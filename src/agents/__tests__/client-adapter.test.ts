import { describe, it, expect } from "bun:test";
import {
  ModernToLegacyClientAdapter,
  LegacyToModernClientAdapter,
} from "../client-adapter.ts";
import type { ClaudeClient as ModernClaudeClient } from "../claude-client.ts";
import type { ClaudeClient as LegacyClaudeClient } from "../../executor/types.ts";

describe("ModernToLegacyClientAdapter", () => {
  it("converts createMessage to complete", async () => {
    const mockModern: ModernClaudeClient = {
      async createMessage(params) {
        return {
          content: "Hello from modern",
          model: params.model,
          inputTokens: 50,
          outputTokens: 100,
          stopReason: "end_turn",
          durationMs: 500,
        };
      },
    };

    const adapter = new ModernToLegacyClientAdapter(mockModern);
    const result = await adapter.complete({
      systemPrompt: "You are a helper",
      userMessage: "Say hello",
      model: "claude-sonnet-4-5-20250929",
      maxTokens: 1000,
    });

    expect(result.content).toBe("Hello from modern");
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(100);
    expect(result.stopReason).toBe("end_turn");
  });

  it("maps max_tokens stop reason correctly", async () => {
    const mockModern: ModernClaudeClient = {
      async createMessage() {
        return {
          content: "Truncated",
          model: "test",
          inputTokens: 10,
          outputTokens: 4096,
          stopReason: "max_tokens",
          durationMs: 100,
        };
      },
    };

    const adapter = new ModernToLegacyClientAdapter(mockModern);
    const result = await adapter.complete({
      systemPrompt: "",
      userMessage: "",
      model: "test",
      maxTokens: 4096,
    });

    expect(result.stopReason).toBe("max_tokens");
  });

  it("propagates errors from the modern client", async () => {
    const mockModern: ModernClaudeClient = {
      async createMessage() {
        throw new Error("API down");
      },
    };

    const adapter = new ModernToLegacyClientAdapter(mockModern);
    await expect(
      adapter.complete({
        systemPrompt: "",
        userMessage: "",
        model: "test",
        maxTokens: 100,
      }),
    ).rejects.toThrow("API down");
  });
});

describe("LegacyToModernClientAdapter", () => {
  it("converts complete to createMessage", async () => {
    const mockLegacy: LegacyClaudeClient = {
      async complete(request) {
        return {
          content: "Hello from legacy",
          inputTokens: 30,
          outputTokens: 60,
          stopReason: "end_turn",
        };
      },
    };

    const adapter = new LegacyToModernClientAdapter(mockLegacy);
    const result = await adapter.createMessage({
      model: "claude-sonnet-4-5-20250929",
      system: "You are a helper",
      messages: [{ role: "user", content: "Say hello" }],
      maxTokens: 1000,
      timeoutMs: 30000,
    });

    expect(result.content).toBe("Hello from legacy");
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.inputTokens).toBe(30);
    expect(result.outputTokens).toBe(60);
    expect(result.stopReason).toBe("end_turn");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("extracts user message from messages array", async () => {
    let capturedMessage = "";
    const mockLegacy: LegacyClaudeClient = {
      async complete(request) {
        capturedMessage = request.userMessage;
        return {
          content: "response",
          inputTokens: 10,
          outputTokens: 20,
          stopReason: "end_turn",
        };
      },
    };

    const adapter = new LegacyToModernClientAdapter(mockLegacy);
    await adapter.createMessage({
      model: "test",
      system: "sys",
      messages: [
        { role: "user", content: "first message" },
        { role: "assistant", content: "response" },
        { role: "user", content: "second message" },
      ],
      maxTokens: 100,
      timeoutMs: 30000,
    });

    // Should extract the first user message
    expect(capturedMessage).toBe("first message");
  });

  it("propagates errors from the legacy client", async () => {
    const mockLegacy: LegacyClaudeClient = {
      async complete() {
        throw new Error("Rate limited");
      },
    };

    const adapter = new LegacyToModernClientAdapter(mockLegacy);
    await expect(
      adapter.createMessage({
        model: "test",
        system: "",
        messages: [{ role: "user", content: "" }],
        maxTokens: 100,
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("Rate limited");
  });
});
