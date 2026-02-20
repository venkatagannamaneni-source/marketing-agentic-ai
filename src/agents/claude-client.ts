import Anthropic from "@anthropic-ai/sdk";
import type { ModelTier } from "../types/agent.ts";

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
}

export interface ClaudeMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ClaudeMessageResult {
  readonly content: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason: string;
  readonly durationMs: number;
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

  /**
   * @param anthropicInstance Optional pre-configured Anthropic SDK instance.
   *   If not provided, creates one using ANTHROPIC_API_KEY from environment.
   */
  constructor(anthropicInstance?: Anthropic) {
    this.anthropic = anthropicInstance ?? new Anthropic();
  }

  async createMessage(
    params: ClaudeMessageParams,
  ): Promise<ClaudeMessageResult> {
    const startTime = Date.now();
    const response = await this.callWithRetry(params);
    const durationMs = Date.now() - startTime;

    const textBlock = response.content.find((b) => b.type === "text");
    const content = textBlock?.type === "text" ? textBlock.text : "";

    return {
      content,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason ?? "unknown",
      durationMs,
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
      try {
        return await this.anthropic.messages.create(
          {
            model: params.model,
            system: params.system,
            messages: params.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            max_tokens: params.maxTokens,
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
          await sleep(RATE_LIMIT_BACKOFFS_MS[rateLimitRetries]!);
          rateLimitRetries++;
          continue;
        }

        if (
          classified === "server_error" &&
          serverErrorRetries < SERVER_ERROR_BACKOFFS_MS.length
        ) {
          await sleep(SERVER_ERROR_BACKOFFS_MS[serverErrorRetries]!);
          serverErrorRetries++;
          continue;
        }

        if (classified === "timeout" && timeoutRetries < TIMEOUT_MAX_RETRIES) {
          timeoutRetries++;
          continue;
        }

        // Non-retryable or retries exhausted
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

  // Bun/Node timeout errors
  if (err instanceof Error && err.name === "AbortError") {
    return "timeout";
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
    case "non_retryable":
      return new ExecutionError(message, "API_ERROR", "", false, cause);
  }
}
