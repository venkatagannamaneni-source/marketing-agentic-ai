import type { Task } from "../types/task.ts";
import type { AgentConfig } from "../types/agent.ts";
import { SKILL_SQUAD_MAP } from "../types/agent.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { WorkspaceError } from "../workspace/errors.ts";
import type {
  ClaudeClient,
  ClaudeResponse,
  ExecutionResult,
  ExecutionErrorCode,
  ExecutorConfig,
} from "./types.ts";
import { ExecutionError } from "./types.ts";
import { loadSkillContent } from "./skill-content-loader.ts";
import { buildPrompt } from "./prompt-builder.ts";
import type { UpstreamOutput } from "./prompt-builder.ts";
import { cancellableSleep } from "./utils.ts";

// ── Executable Statuses ─────────────────────────────────────────────────────

const EXECUTABLE_STATUSES = new Set(["pending", "assigned", "revision"]);

// ── Agent Executor ──────────────────────────────────────────────────────────

export class AgentExecutor {
  constructor(
    private readonly client: ClaudeClient,
    private readonly workspace: WorkspaceManager,
    private readonly config: ExecutorConfig,
  ) {}

  async execute(
    task: Task,
    options?: {
      signal?: AbortSignal;
      agentConfig?: Partial<AgentConfig>;
    },
  ): Promise<ExecutionResult> {
    const signal = options?.signal;
    const startTime = Date.now();

    // Step 1: Validate task is executable
    if (!EXECUTABLE_STATUSES.has(task.status)) {
      return this.failedResult(task, startTime, {
        code: "TASK_NOT_EXECUTABLE",
        message: `Task status "${task.status}" is not executable (must be pending, assigned, or revision)`,
      });
    }

    // Step 2: Check abort signal
    if (signal?.aborted) {
      return this.failedResult(task, startTime, {
        code: "ABORTED",
        message: "Aborted before execution started",
      });
    }

    // Step 3: Update task status to in_progress
    try {
      await this.workspace.updateTaskStatus(task.id, "in_progress");
    } catch (err: unknown) {
      return this.failedResult(task, startTime, {
        code: "WORKSPACE_WRITE_FAILED",
        message: `Failed to update task status: ${errorMessage(err)}`,
        cause: toError(err),
      });
    }

    // Step 4-12: Execute (wrapped to catch all errors and return result)
    try {
      return await this.executeInner(task, startTime, signal, options?.agentConfig);
    } catch (err: unknown) {
      // Catch-all: should never reach here (executeInner handles all errors)
      await this.safeUpdateStatus(task.id, "failed");
      const execErr =
        err instanceof ExecutionError
          ? err
          : new ExecutionError(
              `Unexpected error: ${errorMessage(err)}`,
              "UNKNOWN",
              task.id,
              toError(err),
            );
      return this.failedResult(task, startTime, {
        code: execErr.code,
        message: execErr.message,
        cause: execErr.cause,
      });
    }
  }

  private async executeInner(
    task: Task,
    startTime: number,
    signal: AbortSignal | undefined,
    agentConfig: Partial<AgentConfig> | undefined,
  ): Promise<ExecutionResult> {
    // Step 5: Load skill content
    let skillContent;
    try {
      skillContent = await loadSkillContent(task.to, this.config.projectRoot);
    } catch (err: unknown) {
      await this.safeUpdateStatus(task.id, "failed");
      const code =
        err instanceof WorkspaceError && err.code === "NOT_FOUND"
          ? "SKILL_NOT_FOUND"
          : "UNKNOWN";
      return this.failedResult(task, startTime, {
        code,
        message: `Failed to load skill "${task.to}": ${errorMessage(err)}`,
        cause: toError(err),
      });
    }

    // Step 6: Read product marketing context
    let productContext: string | null = null;
    try {
      const exists = await this.workspace.contextExists();
      if (exists) {
        productContext = await this.workspace.readContext();
      }
    } catch {
      // Non-fatal: context read failed, proceed without it
    }

    // Step 7: Read upstream inputs
    const upstreamOutputs: UpstreamOutput[] = [];
    for (const input of task.inputs) {
      try {
        const content = await this.workspace.readFile(input.path);
        upstreamOutputs.push({
          path: input.path,
          description: input.description,
          content,
        });
      } catch (err: unknown) {
        await this.safeUpdateStatus(task.id, "failed");
        return this.failedResult(task, startTime, {
          code: "INPUT_NOT_FOUND",
          message: `Upstream input not found: "${input.path}"`,
          cause: toError(err),
        });
      }
    }

    // Step 8: Build prompt
    const { systemPrompt, userMessage } = buildPrompt({
      skillContent,
      task,
      productContext,
      upstreamOutputs,
    });

    // Step 9: Resolve model and config
    const modelTier = agentConfig?.modelTier ?? this.config.defaultModelTier;
    const model = this.config.modelMap[modelTier];
    const maxTokens = this.config.defaultMaxTokens;
    const maxRetries = agentConfig?.maxRetries ?? this.config.maxRetries;
    const timeoutMs = agentConfig?.timeoutMs ?? this.config.defaultTimeoutMs;

    // Create composite abort signal: timeout + caller signal
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const compositeSignal = signal
      ? AbortSignal.any([timeoutSignal, signal])
      : timeoutSignal;

    // Step 10: Call Claude API with retries
    let response: ClaudeResponse;
    try {
      response = await this.executeWithRetries(
        { systemPrompt, userMessage, model, maxTokens, signal: compositeSignal },
        maxRetries,
      );
    } catch (err: unknown) {
      await this.safeUpdateStatus(task.id, "failed");
      const execErr =
        err instanceof ExecutionError
          ? err
          : new ExecutionError(
              `API call failed: ${errorMessage(err)}`,
              "UNKNOWN",
              task.id,
              toError(err),
            );
      return this.failedResult(task, startTime, {
        code: execErr.code,
        message: execErr.message,
        cause: execErr.cause,
      });
    }

    // Step 11: Handle response
    if (!response.content || response.content.trim().length === 0) {
      await this.safeUpdateStatus(task.id, "failed");
      return this.failedResult(task, startTime, {
        code: "RESPONSE_EMPTY",
        message: "Claude returned empty or whitespace-only content",
      });
    }

    const isTruncated = response.stopReason === "max_tokens";

    // Step 12: Write output to workspace
    try {
      await this.writeOutput(task, response.content);
    } catch (err: unknown) {
      await this.safeUpdateStatus(task.id, "failed");
      return this.failedResult(task, startTime, {
        code: "WORKSPACE_WRITE_FAILED",
        message: `Failed to write output: ${errorMessage(err)}`,
        cause: toError(err),
      });
    }

    // Update task status to completed
    await this.safeUpdateStatus(task.id, "completed");

    const result: ExecutionResult = {
      taskId: task.id,
      skill: task.to,
      status: "completed",
      outputPath: task.output.path,
      tokensUsed: {
        input: response.inputTokens,
        output: response.outputTokens,
        total: response.inputTokens + response.outputTokens,
      },
      durationMs: Date.now() - startTime,
    };

    // Attach truncation warning if applicable
    if (isTruncated) {
      return {
        ...result,
        error: new ExecutionError(
          "Response truncated (max_tokens reached)",
          "RESPONSE_TRUNCATED",
          task.id,
        ),
      };
    }

    return result;
  }

  // ── Retry Logic ─────────────────────────────────────────────────────────

  private async executeWithRetries(
    request: {
      systemPrompt: string;
      userMessage: string;
      model: string;
      maxTokens: number;
      signal?: AbortSignal;
    },
    maxRetries: number,
  ): Promise<ClaudeResponse> {
    let lastError: ExecutionError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.complete(request);
      } catch (err: unknown) {
        const execErr =
          err instanceof ExecutionError
            ? err
            : new ExecutionError(
                errorMessage(err),
                "UNKNOWN",
                "",
                toError(err),
              );

        lastError = execErr;

        // Never retry aborts
        if (execErr.code === "ABORTED") {
          throw execErr;
        }

        // Non-retryable errors → throw immediately
        if (!this.config.retryableErrors.includes(execErr.code)) {
          throw execErr;
        }

        // Last attempt → throw
        if (attempt === maxRetries) {
          throw execErr;
        }

        // Check signal before sleeping
        if (request.signal?.aborted) {
          throw new ExecutionError("Aborted during retry", "ABORTED", "");
        }

        // Exponential backoff sleep (cancellable)
        const delay = this.config.retryDelayMs * Math.pow(2, attempt);
        await cancellableSleep(delay, request.signal);
      }
    }

    // Should never reach here
    throw lastError ?? new ExecutionError("Retry loop exited unexpectedly", "UNKNOWN", "");
  }

  // ── Output Writing ──────────────────────────────────────────────────────

  private async writeOutput(task: Task, content: string): Promise<void> {
    const squad = SKILL_SQUAD_MAP[task.to];

    if (squad !== null) {
      await this.workspace.writeOutput(squad, task.to, task.id, content);
    } else {
      // Foundation skill (product-marketing-context) — write directly to task's output path
      await this.workspace.writeFile(task.output.path, content);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private failedResult(
    task: Task,
    startTime: number,
    err: { code: string; message: string; cause?: Error },
  ): ExecutionResult {
    return {
      taskId: task.id,
      skill: task.to,
      status: "failed",
      outputPath: null,
      tokensUsed: { input: 0, output: 0, total: 0 },
      durationMs: Date.now() - startTime,
      error: new ExecutionError(
        err.message,
        err.code as ExecutionErrorCode,
        task.id,
        err.cause,
      ),
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
