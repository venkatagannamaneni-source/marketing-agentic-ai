import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelTier } from "../types/agent.ts";
import { SKILL_SQUAD_MAP, FOUNDATION_SKILL } from "../types/agent.ts";
import type { Task } from "../types/task.ts";
import type { BudgetState } from "../director/types.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { loadSkillMeta } from "./skill-loader.ts";
import { buildAgentPrompt } from "./prompt-builder.ts";
import { selectModelTier } from "./model-selector.ts";
import type { ClaudeClient } from "./claude-client.ts";
import { MODEL_MAP, estimateCost, ExecutionError } from "./claude-client.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExecutorConfig {
  readonly projectRoot: string;
  readonly defaultModel: ModelTier;
  readonly defaultTimeoutMs: number;
  readonly defaultMaxTokens: number;
  readonly maxRetries: number;
  readonly maxContextTokens: number;
}

export const DEFAULT_EXECUTOR_CONFIG: Omit<ExecutorConfig, "projectRoot"> = {
  defaultModel: "sonnet",
  defaultTimeoutMs: 120_000,
  defaultMaxTokens: 8192,
  maxRetries: 3,
  maxContextTokens: 150_000,
};

export interface ExecutionResult {
  readonly taskId: string;
  readonly content: string;
  readonly metadata: ExecutionMetadata;
  readonly truncated: boolean;
  readonly missingInputs: readonly string[];
  readonly warnings: readonly string[];
}

export interface ExecutionMetadata {
  readonly model: string;
  readonly modelTier: ModelTier;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly estimatedCost: number;
  readonly retryCount: number;
}

// ── Agent Executor ───────────────────────────────────────────────────────────

export class AgentExecutor {
  constructor(
    private readonly client: ClaudeClient,
    private readonly workspace: WorkspaceManager,
    private readonly config: ExecutorConfig,
  ) {}

  /**
   * Execute a task by loading its skill, building a prompt, calling Claude,
   * and writing the output to the workspace.
   */
  async executeTask(
    task: Task,
    budgetState?: BudgetState,
  ): Promise<ExecutionResult> {
    // EC-7: Validate projectRoot on first call
    await this.ensureValidProjectRoot();

    // 1. Budget gate
    if (budgetState?.level === "exhausted") {
      throw new ExecutionError(
        `Budget exhausted — cannot execute task ${task.id}`,
        "BUDGET_EXHAUSTED",
        false,
      );
    }

    // 2. Load skill metadata
    const agentMeta = await loadSkillMeta(task.to, this.config.projectRoot);

    // 3. Select model
    const modelTier = selectModelTier(task.to, budgetState);
    const model = MODEL_MAP[modelTier];

    // 4. Build prompt
    const prompt = await buildAgentPrompt(
      task,
      agentMeta,
      this.workspace,
      this.config.projectRoot,
      this.config.maxContextTokens,
    );

    // 5. Update task status to in_progress
    await this.workspace.updateTaskStatus(task.id, "in_progress");

    let retryCount = 0;
    let truncated = false;
    let content: string;
    let inputTokens: number;
    let outputTokens: number;
    let durationMs: number;

    try {
      // 6. Call Claude API
      const result = await this.client.createMessage({
        model,
        system: prompt.systemPrompt,
        messages: [{ role: "user", content: prompt.userMessage }],
        maxTokens: this.config.defaultMaxTokens,
        timeoutMs: this.config.defaultTimeoutMs,
      });

      content = result.content;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      durationMs = result.durationMs;

      // 7. Detect truncation
      if (result.stopReason !== "end_turn") {
        truncated = true;

        // Retry once with format reminder
        const retryResult = await this.client.createMessage({
          model,
          system: prompt.systemPrompt,
          messages: [
            { role: "user", content: prompt.userMessage },
            { role: "assistant", content: result.content },
            {
              role: "user",
              content:
                "\n\nIMPORTANT: Your previous response was truncated. Please provide a complete but more concise response.",
            },
          ],
          maxTokens: this.config.defaultMaxTokens,
          timeoutMs: this.config.defaultTimeoutMs,
        });

        retryCount = 1;
        // Use the retry result if it completed
        if (retryResult.stopReason === "end_turn") {
          content = retryResult.content;
          truncated = false;
        }
        // Accumulate tokens from both calls
        inputTokens += retryResult.inputTokens;
        outputTokens += retryResult.outputTokens;
        durationMs += retryResult.durationMs;
      }

      // 8. Write output — EC-1: Handle foundation skill (null squad)
      const squad = SKILL_SQUAD_MAP[task.to];
      if (squad) {
        await this.workspace.writeOutput(squad, task.to, task.id, content);
      } else if (task.to === FOUNDATION_SKILL) {
        await this.workspace.writeFile(
          "context/product-marketing-context.md",
          content,
        );
      } else {
        // Unexpected null squad for non-foundation skill — write to generic path
        await this.workspace.writeFile(
          `outputs/${task.to}/${task.id}.md`,
          content,
        );
      }

      // 9. Update task status to completed
      await this.workspace.updateTaskStatus(task.id, "completed");
    } catch (err: unknown) {
      // On any error during execution, mark task as failed
      try {
        await this.workspace.updateTaskStatus(task.id, "failed");
      } catch {
        // If status update fails too, we still want to throw the original error
      }
      throw err;
    }

    // 10. Compute cost
    const estimatedCost = estimateCost(modelTier, inputTokens, outputTokens);

    // 11. Return result
    return {
      taskId: task.id,
      content,
      metadata: {
        model,
        modelTier,
        inputTokens,
        outputTokens,
        durationMs,
        estimatedCost,
        retryCount,
      },
      truncated,
      missingInputs: prompt.missingInputs,
      warnings: prompt.warnings,
    };
  }

  // EC-7: Validate that the skills directory exists
  private _validated = false;
  private async ensureValidProjectRoot(): Promise<void> {
    if (this._validated) return;
    const skillsDir = resolve(this.config.projectRoot, ".agents/skills");
    try {
      await stat(skillsDir);
      this._validated = true;
    } catch {
      throw new Error(
        `Skills directory not found at ${skillsDir}. Check ExecutorConfig.projectRoot.`,
      );
    }
  }
}
