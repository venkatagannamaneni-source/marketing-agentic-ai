import Anthropic from "@anthropic-ai/sdk";
import type { ModelTier } from "../types/agent.ts";
import { NULL_LOGGER } from "../observability/logger.ts";
import type { Logger } from "../observability/logger.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeClient {
  createMessage(params: ClaudeMessageParams): Promise<ClaudeMessageResult>;
}

export interface ClaudeMessageParams {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ClaudeMessage[];
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly tools?: readonly ClaudeToolDef[];
}

export interface ClaudeToolDef {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: {
    readonly type: "object";
    readonly properties?: unknown | null;
    readonly required?: readonly string[] | null;
  };
}

export interface ClaudeMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly ClaudeContentBlock[];
}

// ── Content Block Types (for tool_use conversations) ────────────────────────

export interface ClaudeTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ClaudeToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

export interface ClaudeMessageResult {
  readonly content: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason: string;
  readonly durationMs: number;
  readonly toolUseBlocks?: readonly ClaudeToolUseBlock[];
  readonly contentBlocks?: readonly ClaudeContentBlock[];
}

// ── Error ────────────────────────────────────────────────────────────────────

export type ExecutionErrorCode =
  // Skill/input resolution
  | "SKILL_NOT_FOUND"
  | "INPUT_NOT_FOUND"
  // API errors
  | "API_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "API_OVERLOADED"
  // Response issues
  | "RESPONSE_EMPTY"
  | "TRUNCATED"
  | "MALFORMED_OUTPUT"
  // Budget/execution gating
  | "BUDGET_EXHAUSTED"
  | "TASK_NOT_EXECUTABLE"
  // Workspace
  | "WORKSPACE_WRITE_FAILED"
  // Cancellation
  | "ABORTED"
  // Tool invocation
  | "TOOL_ERROR"
  | "TOOL_LOOP_LIMIT"
  // Catch-all
  | "UNKNOWN";

export class ExecutionError extends Error {
  override readonly name = "ExecutionError";

  constructor(
    message: string,
    readonly code: ExecutionErrorCode,
    readonly taskId: string,
    readonly retryable: boolean,
    override readonly cause?: Error,
  ) {
    super(message);
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

export const MODEL_MAP: Record<ModelTier, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};

export const COST_PER_MILLION_TOKENS: Record<
  ModelTier,
  { readonly input: number; readonly output: number }
> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.25, output: 1.25 },
};

export function estimateCost(
  modelTier: ModelTier,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = COST_PER_MILLION_TOKENS[modelTier];
  return (
    (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000
  );
}

// ── Retry Configuration ──────────────────────────────────────────────────────

const RATE_LIMIT_BACKOFFS_MS = [2000, 4000, 8000, 16000, 32000, 60000];
const SERVER_ERROR_BACKOFFS_MS = [2000, 4000, 8000];
const TIMEOUT_MAX_RETRIES = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Anthropic SDK Client ─────────────────────────────────────────────────────

export class AnthropicClaudeClient implements ClaudeClient {
  private readonly anthropic: Anthropic;
  private readonly logger: Logger;

  /**
   * @param anthropicInstance Optional pre-configured Anthropic SDK instance.
   *   If not provided, creates one using ANTHROPIC_API_KEY from environment.
   * @param logger Optional Logger for structured logging.
   */
  constructor(anthropicInstance?: Anthropic, logger?: Logger) {
    this.anthropic = anthropicInstance ?? new Anthropic();
    this.logger = (logger ?? NULL_LOGGER).child({ module: "claude-client" });
  }

  async createMessage(
    params: ClaudeMessageParams,
  ): Promise<ClaudeMessageResult> {
    this.logger.debug("claude_request_started", {
      model: params.model,
      maxTokens: params.maxTokens,
    });

    const startTime = Date.now();
    const response = await this.callWithRetry(params);
    const durationMs = Date.now() - startTime;

    // Extract text content
    const textBlocks = response.content.filter((b) => b.type === "text");
    const content = textBlocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");

    // Extract tool_use blocks
    const toolUseBlocks: ClaudeToolUseBlock[] = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        type: "tool_use" as const,
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      }));

    // Build content blocks (text + tool_use only — excludes tool_result which is user-side)
    const contentBlocks: ClaudeContentBlock[] = response.content
      .filter((b) => b.type === "text" || b.type === "tool_use")
      .map((b) => {
        if (b.type === "text") {
          return { type: "text" as const, text: b.text };
        }
        const tu = b as Anthropic.ToolUseBlock;
        return {
          type: "tool_use" as const,
          id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
        };
      });

    this.logger.info("claude_request_completed", {
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      durationMs,
      stopReason: response.stop_reason ?? "unknown",
      toolUseCount: toolUseBlocks.length,
    });

    return {
      content,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason ?? "unknown",
      durationMs,
      toolUseBlocks,
      contentBlocks,
    };
  }

  private async callWithRetry(
    params: ClaudeMessageParams,
  ): Promise<Anthropic.Message> {
    let rateLimitRetries = 0;
    let serverErrorRetries = 0;
    let timeoutRetries = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check abort before each attempt (catches abort during backoff sleep)
      if (params.signal?.aborted) {
        throw new ExecutionError("Request aborted", "ABORTED", "", false);
      }

      try {
        return await this.anthropic.messages.create(
          {
            model: params.model,
            system: params.system,
            messages: params.messages.map((m) => ({
              role: m.role,
              content: m.content as string | Anthropic.MessageParam["content"],
            })),
            max_tokens: params.maxTokens,
            ...(params.tools && params.tools.length > 0
              ? {
                  tools: params.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
                  })),
                }
              : {}),
          },
          {
            timeout: params.timeoutMs,
            ...(params.signal ? { signal: params.signal } : {}),
          },
        );
      } catch (err: unknown) {
        const classified = classifyError(err);

        if (
          classified === "rate_limited" &&
          rateLimitRetries < RATE_LIMIT_BACKOFFS_MS.length
        ) {
          const backoffMs = RATE_LIMIT_BACKOFFS_MS[rateLimitRetries]!;
          this.logger.warn("claude_rate_limited", {
            retryAttempt: rateLimitRetries + 1,
            backoffMs,
            model: params.model,
          });
          await sleep(backoffMs);
          rateLimitRetries++;
          continue;
        }

        if (
          classified === "server_error" &&
          serverErrorRetries < SERVER_ERROR_BACKOFFS_MS.length
        ) {
          const backoffMs = SERVER_ERROR_BACKOFFS_MS[serverErrorRetries]!;
          this.logger.warn("claude_server_error", {
            retryAttempt: serverErrorRetries + 1,
            backoffMs,
            model: params.model,
          });
          await sleep(backoffMs);
          serverErrorRetries++;
          continue;
        }

        if (classified === "timeout" && timeoutRetries < TIMEOUT_MAX_RETRIES) {
          this.logger.warn("claude_timeout_retry", {
            retryAttempt: timeoutRetries + 1,
            model: params.model,
          });
          timeoutRetries++;
          continue;
        }

        // Non-retryable or retries exhausted
        this.logger.error("claude_request_failed", {
          classification: classified,
          model: params.model,
          error: err instanceof Error ? err.message : String(err),
        });
        throw toExecutionError(classified, err);
      }
    }
  }
}

// ── Error Classification ─────────────────────────────────────────────────────

type ErrorClass =
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "aborted"
  | "non_retryable";

function classifyError(err: unknown): ErrorClass {
  // Check timeout subclasses BEFORE the parent APIError class.
  // APIConnectionTimeoutError extends APIConnectionError extends APIError,
  // so the APIError check would match first and misclassify timeouts.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return "timeout";
  }

  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) return "rate_limited";
    if (err.status >= 500 && err.status < 600) return "server_error";
    return "non_retryable";
  }

  // User-initiated abort (AbortSignal) — distinct from timeout
  if (err instanceof Error && err.name === "AbortError") {
    return "aborted";
  }

  return "non_retryable";
}

function toExecutionError(
  classification: ErrorClass,
  err: unknown,
): ExecutionError {
  const cause = err instanceof Error ? err : undefined;
  const message =
    err instanceof Error ? err.message : "Unknown error calling Claude API";

  switch (classification) {
    case "rate_limited":
      return new ExecutionError(
        `Rate limited after max retries: ${message}`,
        "RATE_LIMITED",
        "",
        false,
        cause,
      );
    case "server_error":
      return new ExecutionError(
        `Server error after max retries: ${message}`,
        "API_ERROR",
        "",
        false,
        cause,
      );
    case "timeout":
      return new ExecutionError(
        `Request timed out: ${message}`,
        "TIMEOUT",
        "",
        false,
        cause,
      );
    case "aborted":
      return new ExecutionError(
        `Request aborted: ${message}`,
        "ABORTED",
        "",
        false,
        cause,
      );
    case "non_retryable":
      return new ExecutionError(message, "API_ERROR", "", false, cause);
  }
}
