import { describe, expect, it } from "bun:test";
import {
  MODEL_MAP,
  COST_PER_MILLION_TOKENS,
  estimateCost,
  ExecutionError,
} from "../claude-client.ts";

describe("MODEL_MAP", () => {
  it("maps opus to correct model string", () => {
    expect(MODEL_MAP.opus).toBe("claude-opus-4-6");
  });

  it("maps sonnet to correct model string", () => {
    expect(MODEL_MAP.sonnet).toBe("claude-sonnet-4-5-20250929");
  });

  it("maps haiku to correct model string", () => {
    expect(MODEL_MAP.haiku).toBe("claude-haiku-4-5-20251001");
  });

  it("has entries for all three tiers", () => {
    expect(Object.keys(MODEL_MAP)).toEqual(["opus", "sonnet", "haiku"]);
  });
});

describe("COST_PER_MILLION_TOKENS", () => {
  it("opus costs $15/$75 per million tokens", () => {
    expect(COST_PER_MILLION_TOKENS.opus).toEqual({
      input: 15,
      output: 75,
    });
  });

  it("sonnet costs $3/$15 per million tokens", () => {
    expect(COST_PER_MILLION_TOKENS.sonnet).toEqual({
      input: 3,
      output: 15,
    });
  });

  it("haiku costs $0.25/$1.25 per million tokens", () => {
    expect(COST_PER_MILLION_TOKENS.haiku).toEqual({
      input: 0.25,
      output: 1.25,
    });
  });
});

describe("estimateCost", () => {
  it("calculates opus cost correctly", () => {
    // 1000 input + 500 output tokens
    // (1000 * 15 + 500 * 75) / 1_000_000 = (15000 + 37500) / 1_000_000 = 0.0525
    const cost = estimateCost("opus", 1000, 500);
    expect(cost).toBeCloseTo(0.0525, 6);
  });

  it("calculates sonnet cost correctly", () => {
    const cost = estimateCost("sonnet", 1000, 500);
    // (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it("calculates haiku cost correctly", () => {
    const cost = estimateCost("haiku", 1000, 500);
    // (1000 * 0.25 + 500 * 1.25) / 1_000_000 = (250 + 625) / 1_000_000 = 0.000875
    expect(cost).toBeCloseTo(0.000875, 6);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCost("sonnet", 0, 0)).toBe(0);
  });

  it("handles large token counts", () => {
    // 1M input tokens on opus = $15
    const cost = estimateCost("opus", 1_000_000, 0);
    expect(cost).toBe(15);
  });
});

describe("ExecutionError", () => {
  it("has correct name", () => {
    const err = new ExecutionError("test", "API_ERROR", false);
    expect(err.name).toBe("ExecutionError");
  });

  it("has correct code", () => {
    const err = new ExecutionError("test", "RATE_LIMITED", true);
    expect(err.code).toBe("RATE_LIMITED");
  });

  it("has correct retryable flag", () => {
    const err = new ExecutionError("test", "TIMEOUT", true);
    expect(err.retryable).toBe(true);
  });

  it("stores cause", () => {
    const cause = new Error("underlying");
    const err = new ExecutionError("wrapped", "API_ERROR", false, cause);
    expect(err.cause).toBe(cause);
  });

  it("is an instance of Error", () => {
    const err = new ExecutionError("test", "API_ERROR", false);
    expect(err instanceof Error).toBe(true);
  });

  it("has all valid error codes", () => {
    const codes: Array<ExecutionError["code"]> = [
      "RATE_LIMITED",
      "API_ERROR",
      "TIMEOUT",
      "TRUNCATED",
      "MALFORMED_OUTPUT",
      "BUDGET_EXHAUSTED",
    ];
    for (const code of codes) {
      const err = new ExecutionError("test", code, false);
      expect(err.code).toBe(code);
    }
  });
});
