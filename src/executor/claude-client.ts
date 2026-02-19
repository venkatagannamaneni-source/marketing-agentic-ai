import Anthropic from "@anthropic-ai/sdk";
import type {
  ClaudeClient,
  ClaudeClientConfig,
  ClaudeRequest,
  ClaudeResponse,
} from "./types.ts";
import { ExecutionError } from "./types.ts";
import { cancellableSleep } from "./utils.ts";

// ── Real Implementation ─────────────────────────────────────────────────────

export class AnthropicClaudeClient implements ClaudeClient {
  private readonly client: Anthropic;

  constructor(config: ClaudeClientConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async complete(request: ClaudeRequest): Promise<ClaudeResponse> {
    if (request.signal?.aborted) {
      throw new ExecutionError("Request aborted before API call", "ABORTED", "");
    }

    try {
      const response = await this.client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.systemPrompt,
          messages: [{ role: "user" as const, content: request.userMessage }],
        },
        { signal: request.signal },
      );

      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );

      if (textBlocks.length === 0) {
        throw new ExecutionError(
          "Claude returned no text content blocks",
          "RESPONSE_EMPTY",
          "",
        );
      }

      const content = textBlocks.map((b) => b.text).join("\n\n");

      const stopReason = mapStopReason(response.stop_reason);

      return {
        content,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason,
      };
    } catch (error: unknown) {
      if (error instanceof ExecutionError) throw error;

      if (error instanceof Anthropic.APIUserAbortError) {
        throw new ExecutionError("Request aborted", "ABORTED", "", error);
      }

      if (error instanceof Anthropic.APIConnectionTimeoutError) {
        throw new ExecutionError("Connection timed out", "API_TIMEOUT", "", error);
      }

      if (error instanceof Anthropic.APIConnectionError) {
        throw new ExecutionError("Connection failed", "API_TIMEOUT", "", error);
      }

      if (error instanceof Anthropic.RateLimitError) {
        throw new ExecutionError("Rate limited (429)", "API_RATE_LIMITED", "", error);
      }

      if (error instanceof Anthropic.APIError) {
        const status = error.status;
        if (status === 529) {
          throw new ExecutionError("API overloaded (529)", "API_OVERLOADED", "", error);
        }
        if (status === 408) {
          throw new ExecutionError("Request timeout (408)", "API_TIMEOUT", "", error);
        }
        throw new ExecutionError(
          `API error (${status}): ${error.message}`,
          "API_ERROR",
          "",
          error,
        );
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ExecutionError("Request aborted", "ABORTED", "", error);
      }

      throw new ExecutionError(
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        "UNKNOWN",
        "",
        error instanceof Error ? error : undefined,
      );
    }
  }
}

function mapStopReason(
  reason: string | null,
): ClaudeResponse["stopReason"] {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

// ── Mock Implementation ─────────────────────────────────────────────────────

export class MockClaudeClient implements ClaudeClient {
  readonly calls: ClaudeRequest[] = [];
  private responseGenerator:
    | ((request: ClaudeRequest) => ClaudeResponse)
    | null;
  private errorToThrow: Error | null = null;
  private errorOneShot = true;
  private delayMs = 0;

  constructor(
    responseGenerator?: (request: ClaudeRequest) => ClaudeResponse,
  ) {
    this.responseGenerator = responseGenerator ?? null;
  }

  setError(error: Error, oneShot = true): void {
    this.errorToThrow = error;
    this.errorOneShot = oneShot;
  }

  clearError(): void {
    this.errorToThrow = null;
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  async complete(request: ClaudeRequest): Promise<ClaudeResponse> {
    if (request.signal?.aborted) {
      throw new ExecutionError("Aborted", "ABORTED", "");
    }

    if (this.delayMs > 0) {
      await cancellableSleep(this.delayMs, request.signal);
    }

    this.calls.push(request);

    if (this.errorToThrow) {
      const err = this.errorToThrow;
      if (this.errorOneShot) {
        this.errorToThrow = null;
      }
      throw err;
    }

    if (this.responseGenerator) {
      return this.responseGenerator(request);
    }

    return {
      content: "Mock output for task",
      inputTokens: 100,
      outputTokens: 200,
      stopReason: "end_turn",
    };
  }
}
