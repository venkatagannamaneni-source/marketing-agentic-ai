import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelTier, SkillName } from "../types/agent.ts";
import { SKILL_SQUAD_MAP, FOUNDATION_SKILL } from "../types/agent.ts";
import type { Task, TaskStatus } from "../types/task.ts";
import type { BudgetState } from "../director/types.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { NULL_LOGGER } from "../observability/logger.ts";
import type { Logger } from "../observability/logger.ts";
import { loadSkillMeta } from "./skill-loader.ts";
import { buildAgentPrompt } from "./prompt-builder.ts";
import { selectModelTier } from "./model-selector.ts";
import type { ClaudeClient } from "./claude-client.ts";
import { MODEL_MAP, estimateCost, ExecutionError } from "./claude-client.ts";

// ── Executable Statuses ─────────────────────────────────────────────────────

const EXECUTABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "pending",
  "assigned",
  "revision",
]);

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

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly budgetState?: BudgetState;
  readonly modelTierOverride?: ModelTier;
}

export interface ExecutionResult {
  readonly taskId: string;
  readonly skill: SkillName;
  readonly status: "completed" | "failed";
  readonly content: string;
  readonly outputPath: string | null;
  readonly metadata: ExecutionMetadata;
  readonly truncated: boolean;
  readonly missingInputs: readonly string[];
  readonly warnings: readonly string[];
  readonly error?: ExecutionError;
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
  private readonly logger: Logger;

  constructor(
    private readonly client: ClaudeClient,
    private readonly workspace: WorkspaceManager,
    private readonly config: ExecutorConfig,
    logger?: Logger,
  ) {
    this.logger = (logger ?? NULL_LOGGER).child({ module: "executor" });
  }

  /**
   * Execute a task by loading its skill, building a prompt, calling Claude,
   * and writing the output to the workspace.
   *
   * Never throws — always returns an ExecutionResult with status field.
   * Use executeOrThrow() if you want the throwing contract.
   */
  async execute(
    task: Task,
    options?: ExecuteOptions,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const signal = options?.signal;
    const budgetState = options?.budgetState;
    const modelTierOverride = options?.modelTierOverride;

    this.logger.debug("executor_task_started", {
      taskId: task.id,
      skill: task.to,
      status: task.status,
    });

    try {
      return await this.executeInner(
        task,
        startTime,
        signal,
        budgetState,
        modelTierOverride,
      );
    } catch (err: unknown) {
      // Never throw — wrap any error into a failed result
      const execErr =
        err instanceof ExecutionError
          ? err
          : new ExecutionError(
              `Unexpected error: ${errorMessage(err)}`,
              "UNKNOWN",
              task.id,
              false,
              toError(err),
            );
      return this.failedResult(task, startTime, execErr);
    }
  }

  /**
   * Execute a task — throws ExecutionError on failure.
   * Convenience wrapper for callers (e.g. MarketingDirector) that expect
   * the throwing error contract.
   */
  async executeOrThrow(
    task: Task,
    options?: ExecuteOptions,
  ): Promise<ExecutionResult> {
    const result = await this.execute(task, options);
    if (result.status === "failed") {
      throw (
        result.error ??
        new ExecutionError(
          `Task ${task.id} execution failed`,
          "UNKNOWN",
          task.id,
          false,
        )
      );
    }
    return result;
  }

  // ── Core Execution Logic ──────────────────────────────────────────────────

  private async executeInner(
    task: Task,
    startTime: number,
    signal: AbortSignal | undefined,
    budgetState: BudgetState | undefined,
    modelTierOverride: ModelTier | undefined,
  ): Promise<ExecutionResult> {
    // EC-7: Validate projectRoot on first call
    await this.ensureValidProjectRoot();

    // 0. Check abort signal
    if (signal?.aborted) {
      return this.failedResult(
        task,
        startTime,
        new ExecutionError(
          "Aborted before execution started",
          "ABORTED",
          task.id,
          false,
        ),
      );
    }

    // 1. Status gate — only pending, assigned, or revision tasks are executable
    if (!EXECUTABLE_STATUSES.has(task.status)) {
      return this.failedResult(
        task,
        startTime,
        new ExecutionError(
          `Task ${task.id} status "${task.status}" is not executable (must be pending, assigned, or revision)`,
          "TASK_NOT_EXECUTABLE",
          task.id,
          false,
        ),
      );
    }

    // 2. Budget gate — reject if exhausted or if task priority is not allowed
    if (budgetState) {
      if (budgetState.level === "exhausted") {
        this.logger.info("executor_budget_exhausted", { taskId: task.id });
        return this.failedResult(
          task,
          startTime,
          new ExecutionError(
            `Budget exhausted — cannot execute task ${task.id}`,
            "BUDGET_EXHAUSTED",
            task.id,
            false,
          ),
        );
      }
      if (!budgetState.allowedPriorities.includes(task.priority)) {
        this.logger.info("executor_budget_priority_blocked", {
          taskId: task.id,
          priority: task.priority,
          budgetLevel: budgetState.level,
        });
        return this.failedResult(
          task,
          startTime,
          new ExecutionError(
            `Task ${task.id} priority ${task.priority} not allowed at budget level ${budgetState.level}`,
            "BUDGET_EXHAUSTED",
            task.id,
            false,
          ),
        );
      }
    }

    // 3. Load skill metadata
    let agentMeta;
    try {
      agentMeta = await loadSkillMeta(task.to, this.config.projectRoot);
      this.logger.debug("executor_skill_loaded", { taskId: task.id, skill: task.to });
    } catch (err: unknown) {
      this.logger.error("executor_skill_load_failed", {
        taskId: task.id,
        skill: task.to,
        error: errorMessage(err),
      });
      return this.failedResult(
        task,
        startTime,
        new ExecutionError(
          `Failed to load skill "${task.to}": ${errorMessage(err)}`,
          "SKILL_NOT_FOUND",
          task.id,
          false,
          toError(err),
        ),
      );
    }

    // 4. Select model
    const modelTier = selectModelTier(task.to, budgetState, modelTierOverride);
    const model = MODEL_MAP[modelTier];
    this.logger.debug("executor_model_selected", {
      taskId: task.id,
      modelTier,
      model,
    });

    // 5. Build prompt
    const prompt = await buildAgentPrompt(
      task,
      agentMeta,
      this.workspace,
      this.config.projectRoot,
      this.config.maxContextTokens,
    );

    // 6. Update task status to in_progress
    try {
      await this.workspace.updateTaskStatus(task.id, "in_progress");
    } catch (err: unknown) {
      return this.failedResult(
        task,
        startTime,
        new ExecutionError(
          `Failed to update task status: ${errorMessage(err)}`,
          "WORKSPACE_WRITE_FAILED",
          task.id,
          false,
          toError(err),
        ),
      );
    }

    let retryCount = 0;
    let truncated = false;
    let content: string;
    let inputTokens: number;
    let outputTokens: number;
    let durationMs: number;

    try {
      // 7. Call Claude API
      this.logger.debug("executor_api_call_started", {
        taskId: task.id,
        model,
        maxTokens: this.config.defaultMaxTokens,
      });
      const result = await this.client.createMessage({
        model,
        system: prompt.systemPrompt,
        messages: [{ role: "user", content: prompt.userMessage }],
        maxTokens: this.config.defaultMaxTokens,
        timeoutMs: this.config.defaultTimeoutMs,
        signal,
      });

      content = result.content;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      durationMs = result.durationMs;

      this.logger.info("executor_api_call_completed", {
        taskId: task.id,
        model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        stopReason: result.stopReason,
      });

      // 8. Detect truncation and retry once with format reminder
      if (result.stopReason !== "end_turn") {
        truncated = true;
        this.logger.warn("executor_truncation_detected", {
          taskId: task.id,
          retrying: !signal?.aborted,
        });

        // Skip retry if already aborted — keep partial content
        if (!signal?.aborted) {
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
            signal,
          });

          retryCount = 1;
          // Use the retry result: if it completed, mark as not truncated;
          // if also truncated, still prefer the retry (asked for concise output)
          content = retryResult.content;
          if (retryResult.stopReason === "end_turn") {
            truncated = false;
          }
          // Accumulate tokens from both calls
          inputTokens += retryResult.inputTokens;
          outputTokens += retryResult.outputTokens;
          durationMs += retryResult.durationMs;
        }
      }
    } catch (err: unknown) {
      await this.safeUpdateStatus(task.id, "failed");
      let execErr: ExecutionError;
      if (err instanceof ExecutionError) {
        // Re-wrap with correct taskId if the client left it empty
        execErr = err.taskId
          ? err
          : new ExecutionError(err.message, err.code, task.id, err.retryable, err.cause as Error | undefined);
      } else {
        execErr = new ExecutionError(
          `API call failed: ${errorMessage(err)}`,
          "API_ERROR",
          task.id,
          false,
          toError(err),
        );
      }
      return this.failedResult(task, startTime, execErr);
    }

    // 9. Validate response content (bug fix: legacy had this, modern didn't)
    if (!content || content.trim().length === 0) {
      await this.safeUpdateStatus(task.id, "failed");
      return this.failedResult(
        task,
        startTime,
        new ExecutionError(
          "Claude returned empty or whitespace-only content",
          "RESPONSE_EMPTY",
          task.id,
          false,
        ),
      );
    }

    // 10. Compute output path
    const outputPath = this.computeOutputPath(task);
    this.logger.debug("executor_output_writing", { taskId: task.id, outputPath });

    // 11. Write output — EC-1: Handle foundation skill (null squad)
    try {
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
    } catch (err: unknown) {
      this.logger.error("executor_output_write_failed", {
        taskId: task.id,
        error: errorMessage(err),
      });
      await this.safeUpdateStatus(task.id, "failed");
      return this.failedResult(
        task,
        startTime,
        new ExecutionError(
          `Failed to write output: ${errorMessage(err)}`,
          "WORKSPACE_WRITE_FAILED",
          task.id,
          false,
          toError(err),
        ),
      );
    }

    // 12. Update task status to completed
    await this.safeUpdateStatus(task.id, "completed");

    // 13. Compute cost
    const estimatedCostValue = estimateCost(modelTier, inputTokens, outputTokens);

    // 14. Build warnings
    const warnings = [...prompt.warnings];
    if (truncated) {
      warnings.push(
        "Response truncated (max_tokens reached) — retry also truncated",
      );
    }

    // 15. Return unified result
    return {
      taskId: task.id,
      skill: task.to,
      status: "completed",
      content,
      outputPath,
      metadata: {
        model,
        modelTier,
        inputTokens,
        outputTokens,
        durationMs,
        estimatedCost: estimatedCostValue,
        retryCount,
      },
      truncated,
      missingInputs: prompt.missingInputs,
      warnings,
    };
  }

  // ── Output Path Computation ───────────────────────────────────────────────

  private computeOutputPath(task: Task): string {
    const squad = SKILL_SQUAD_MAP[task.to];
    if (squad) {
      return `outputs/${squad}/${task.to}/${task.id}.md`;
    }
    if (task.to === FOUNDATION_SKILL) {
      return "context/product-marketing-context.md";
    }
    return `outputs/${task.to}/${task.id}.md`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private failedResult(
    task: Task,
    startTime: number,
    error: ExecutionError,
  ): ExecutionResult {
    return {
      taskId: task.id,
      skill: task.to,
      status: "failed",
      content: "",
      outputPath: null,
      metadata: {
        model: "",
        modelTier: this.config.defaultModel,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startTime,
        estimatedCost: 0,
        retryCount: 0,
      },
      truncated: false,
      missingInputs: [],
      warnings: [],
      error,
    };
  }

  private async safeUpdateStatus(
    taskId: string,
    status: "failed" | "completed",
  ): Promise<void> {
    try {
      await this.workspace.updateTaskStatus(taskId, status);
    } catch {
      // Best-effort — don't let status update failure mask the original error
      this.logger.warn("executor_status_update_failed", { taskId, targetStatus: status });
    }
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
      throw new ExecutionError(
        `Skills directory not found at ${skillsDir}. Check ExecutorConfig.projectRoot.`,
        "SKILL_NOT_FOUND",
        "",
        false,
      );
    }
  }
}

// ── Utility Functions ───────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toError(err: unknown): Error | undefined {
  return err instanceof Error ? err : undefined;
}
