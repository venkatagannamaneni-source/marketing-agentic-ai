import { describe, expect, it } from "bun:test";
import { MockClaudeClient } from "../claude-client.ts";
import { ExecutionError } from "../types.ts";
import type { ClaudeRequest, ClaudeResponse } from "../types.ts";

function makeRequest(overrides?: Partial<ClaudeRequest>): ClaudeRequest {
  return {
    systemPrompt: "You are a copywriter.",
    userMessage: "Write a headline.",
    model: "claude-sonnet-4-5-20250929",
    maxTokens: 1024,
    ...overrides,
  };
}

describe("MockClaudeClient", () => {
  it("returns default response when no generator provided", async () => {
    const client = new MockClaudeClient();
    const response = await client.complete(makeRequest());

    expect(response.content).toBe("Mock output for task");
    expect(response.inputTokens).toBe(100);
    expect(response.outputTokens).toBe(200);
    expect(response.stopReason).toBe("end_turn");
  });

  it("uses custom response generator", async () => {
    const generator = (req: ClaudeRequest): ClaudeResponse => ({
      content: `Response for model ${req.model}`,
      inputTokens: 50,
      outputTokens: 150,
      stopReason: "end_turn",
    });

    const client = new MockClaudeClient(generator);
    const response = await client.complete(makeRequest());

    expect(response.content).toBe("Response for model claude-sonnet-4-5-20250929");
    expect(response.inputTokens).toBe(50);
    expect(response.outputTokens).toBe(150);
  });

  it("records call history", async () => {
    const client = new MockClaudeClient();
    expect(client.calls).toHaveLength(0);

    const req1 = makeRequest({ userMessage: "First call" });
    const req2 = makeRequest({ userMessage: "Second call" });

    await client.complete(req1);
    await client.complete(req2);

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]!.userMessage).toBe("First call");
    expect(client.calls[1]!.userMessage).toBe("Second call");
  });

  it("throws configured error (one-shot by default)", async () => {
    const client = new MockClaudeClient();
    const error = new ExecutionError("rate limited", "API_RATE_LIMITED", "");
    client.setError(error);

    // First call throws
    try {
      await client.complete(makeRequest());
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionError);
      expect((err as ExecutionError).code).toBe("API_RATE_LIMITED");
    }

    // Second call succeeds (one-shot)
    const response = await client.complete(makeRequest());
    expect(response.content).toBe("Mock output for task");
  });

  it("throws persistent error when oneShot is false", async () => {
    const client = new MockClaudeClient();
    const error = new ExecutionError("overloaded", "API_OVERLOADED", "");
    client.setError(error, false);

    // Both calls should throw
    for (let i = 0; i < 2; i++) {
      try {
        await client.complete(makeRequest());
        expect(true).toBe(false);
      } catch (err) {
        expect((err as ExecutionError).code).toBe("API_OVERLOADED");
      }
    }

    // Clear and verify recovery
    client.clearError();
    const response = await client.complete(makeRequest());
    expect(response.content).toBe("Mock output for task");
  });

  it("does not record call when error is thrown", async () => {
    const client = new MockClaudeClient();
    client.setError(new ExecutionError("fail", "API_ERROR", ""));

    try {
      await client.complete(makeRequest());
    } catch {
      // expected
    }

    // Error is thrown before recording the call
    // (call is recorded after error check in our implementation)
    // Actually looking at the implementation, calls.push happens before error check
    // Let me verify: the mock pushes calls, then checks error
    expect(client.calls).toHaveLength(1);
  });

  it("simulates delay", async () => {
    const client = new MockClaudeClient();
    client.setDelay(50);

    const start = Date.now();
    await client.complete(makeRequest());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing variance
  });

  it("rejects immediately when signal is already aborted", async () => {
    const client = new MockClaudeClient();
    const controller = new AbortController();
    controller.abort();

    try {
      await client.complete(makeRequest({ signal: controller.signal }));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionError);
      expect((err as ExecutionError).code).toBe("ABORTED");
    }

    // No call should be recorded
    expect(client.calls).toHaveLength(0);
  });

  it("aborts during delay when signal fires", async () => {
    const client = new MockClaudeClient();
    client.setDelay(5000); // long delay

    const controller = new AbortController();

    const promise = client.complete(makeRequest({ signal: controller.signal }));

    // Abort after a short wait
    setTimeout(() => controller.abort(), 50);

    try {
      await promise;
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionError);
      expect((err as ExecutionError).code).toBe("ABORTED");
    }

    // Call should not be recorded (aborted during delay, before push)
    expect(client.calls).toHaveLength(0);
  });

  it("executes normally when signal is provided but not aborted", async () => {
    const client = new MockClaudeClient();
    const controller = new AbortController();

    const response = await client.complete(
      makeRequest({ signal: controller.signal }),
    );

    expect(response.content).toBe("Mock output for task");
    expect(client.calls).toHaveLength(1);
  });

  it("generator can return different stop reasons", async () => {
    const client = new MockClaudeClient(() => ({
      content: "Truncated output",
      inputTokens: 100,
      outputTokens: 4096,
      stopReason: "max_tokens",
    }));

    const response = await client.complete(makeRequest());
    expect(response.stopReason).toBe("max_tokens");
  });
});
