import type { SkillName, ModelTier, AgentMeta } from "../types/agent.ts";

// ── Claude Client Interface ─────────────────────────────────────────────────

export interface ClaudeClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly defaultMaxTokens?: number;
}

export interface ClaudeRequest {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

export interface ClaudeResponse {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason: "end_turn" | "max_tokens" | "stop_sequence";
}

export interface ClaudeClient {
  complete(request: ClaudeRequest): Promise<ClaudeResponse>;
}

// ── Execution Result ────────────────────────────────────────────────────────

export type ExecutionStatus = "completed" | "failed";

export interface ExecutionResult {
  readonly taskId: string;
  readonly skill: SkillName;
  readonly status: ExecutionStatus;
  readonly outputPath: string | null;
  readonly tokensUsed: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly durationMs: number;
  readonly error?: ExecutionError;
}

// ── Execution Errors ────────────────────────────────────────────────────────

export type ExecutionErrorCode =
  | "SKILL_NOT_FOUND"
  | "CONTEXT_NOT_FOUND"
  | "INPUT_NOT_FOUND"
  | "API_ERROR"
  | "API_RATE_LIMITED"
  | "API_OVERLOADED"
  | "API_TIMEOUT"
  | "RESPONSE_EMPTY"
  | "RESPONSE_TRUNCATED"
  | "WORKSPACE_WRITE_FAILED"
  | "TASK_NOT_EXECUTABLE"
  | "ABORTED"
  | "UNKNOWN";

export class ExecutionError extends Error {
  override readonly name = "ExecutionError";

  constructor(
    message: string,
    public readonly code: ExecutionErrorCode,
    public readonly taskId: string,
    public override readonly cause?: Error,
  ) {
    super(message);
  }
}

// ── Executor Config ─────────────────────────────────────────────────────────

export interface ExecutorConfig {
  readonly projectRoot: string;
  readonly modelMap: Record<ModelTier, string>;
  readonly defaultModelTier: ModelTier;
  readonly defaultTimeoutMs: number;
  readonly defaultMaxTokens: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly retryableErrors: readonly ExecutionErrorCode[];
}

export const DEFAULT_MODEL_MAP: Record<ModelTier, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};

const DEFAULT_RETRYABLE_ERRORS: readonly ExecutionErrorCode[] = [
  "API_ERROR",
  "API_RATE_LIMITED",
  "API_OVERLOADED",
  "API_TIMEOUT",
];

export function createDefaultConfig(
  overrides?: Partial<ExecutorConfig>,
): ExecutorConfig {
  return {
    projectRoot: overrides?.projectRoot ?? process.cwd(),
    modelMap: overrides?.modelMap ?? DEFAULT_MODEL_MAP,
    defaultModelTier: overrides?.defaultModelTier ?? "sonnet",
    defaultTimeoutMs: overrides?.defaultTimeoutMs ?? 120_000,
    defaultMaxTokens: overrides?.defaultMaxTokens ?? 4096,
    maxRetries: overrides?.maxRetries ?? 2,
    retryDelayMs: overrides?.retryDelayMs ?? 1_000,
    retryableErrors: overrides?.retryableErrors ?? DEFAULT_RETRYABLE_ERRORS,
  };
}

// ── Skill Content (extends AgentMeta with full body + reference contents) ───

export interface SkillContent extends AgentMeta {
  readonly body: string;
  readonly referenceContents: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}
