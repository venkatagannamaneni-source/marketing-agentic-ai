/**
 * Bidirectional adapters between the Modern and Legacy ClaudeClient interfaces.
 *
 * Modern: `createMessage(params: ClaudeMessageParams): Promise<ClaudeMessageResult>`
 * Legacy: `complete(request: ClaudeRequest): Promise<ClaudeResponse>`
 *
 * These adapters allow code written for one interface to work with a client
 * that implements the other, enabling gradual migration from the legacy
 * executor to the modern executor.
 */

import type {
  ClaudeClient as ModernClaudeClient,
  ClaudeMessageParams,
  ClaudeMessageResult,
} from "./claude-client.ts";
import type {
  ClaudeClient as LegacyClaudeClient,
  ClaudeRequest,
  ClaudeResponse,
} from "../executor/types.ts";

// ── Modern → Legacy Adapter ─────────────────────────────────────────────────

/**
 * Wraps a Modern ClaudeClient (createMessage) to satisfy the Legacy
 * ClaudeClient interface (complete). Use this when pipeline or queue code
 * needs a legacy client but you only have a modern client instance.
 */
export class ModernToLegacyClientAdapter implements LegacyClaudeClient {
  constructor(private readonly modern: ModernClaudeClient) {}

  async complete(request: ClaudeRequest): Promise<ClaudeResponse> {
    const result = await this.modern.createMessage({
      model: request.model,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userMessage }],
      maxTokens: request.maxTokens,
      timeoutMs: 120_000,
    });

    return {
      content: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      stopReason: mapStopReason(result.stopReason),
    };
  }
}

// ── Legacy → Modern Adapter ─────────────────────────────────────────────────

/**
 * Wraps a Legacy ClaudeClient (complete) to satisfy the Modern
 * ClaudeClient interface (createMessage). Use this when director code
 * needs a modern client but you only have a legacy client instance.
 */
export class LegacyToModernClientAdapter implements ModernClaudeClient {
  constructor(private readonly legacy: LegacyClaudeClient) {}

  async createMessage(
    params: ClaudeMessageParams,
  ): Promise<ClaudeMessageResult> {
    const startTime = Date.now();
    const userContent =
      params.messages.find((m) => m.role === "user")?.content ?? "";

    const response = await this.legacy.complete({
      systemPrompt: params.system,
      userMessage: userContent,
      model: params.model,
      maxTokens: params.maxTokens,
    });

    return {
      content: response.content,
      model: params.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      stopReason: response.stopReason,
      durationMs: Date.now() - startTime,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapStopReason(
  reason: string,
): ClaudeResponse["stopReason"] {
  if (reason === "end_turn") return "end_turn";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "stop_sequence") return "stop_sequence";
  return "end_turn";
}
