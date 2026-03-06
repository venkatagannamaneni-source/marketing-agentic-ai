import { describe, it, expect } from "bun:test";
import {
  TokenBucketRateLimiter,
  ToolRateLimiterRegistry,
  RateLimitError,
} from "../tool-rate-limiter.ts";
import { ToolRegistry } from "../tool-registry.ts";
import type { ToolRegistryData } from "../tool-registry.ts";

// ── TokenBucketRateLimiter ──────────────────────────────────────────────────

describe("TokenBucketRateLimiter", () => {
  it("starts with full token bucket", () => {
    const limiter = new TokenBucketRateLimiter(10);
    expect(limiter.availableTokens).toBe(10);
  });

  it("tryAcquire consumes a token", () => {
    const limiter = new TokenBucketRateLimiter(5);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.availableTokens).toBe(4);
  });

  it("tryAcquire returns false when bucket is empty", () => {
    const limiter = new TokenBucketRateLimiter(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it("acquire succeeds when tokens are available", async () => {
    const limiter = new TokenBucketRateLimiter(10);
    await limiter.acquire("test-tool");
    expect(limiter.availableTokens).toBe(9);
  });

  it("acquire throws RateLimitError on timeout", async () => {
    const limiter = new TokenBucketRateLimiter(1);
    limiter.tryAcquire(); // exhaust
    try {
      await limiter.acquire("test-tool", 100); // very short timeout
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const rle = err as RateLimitError;
      expect(rle.toolName).toBe("test-tool");
      expect(rle.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("tokens refill over time", async () => {
    const limiter = new TokenBucketRateLimiter(600); // 10 per second
    // Exhaust 5 tokens
    for (let i = 0; i < 5; i++) limiter.tryAcquire();
    const before = limiter.availableTokens;
    await new Promise((r) => setTimeout(r, 200)); // wait 200ms → ~2 tokens refill
    const after = limiter.availableTokens;
    expect(after).toBeGreaterThan(before);
  });

  it("tokens do not exceed max capacity", () => {
    const limiter = new TokenBucketRateLimiter(5);
    // Don't consume any — already at max
    expect(limiter.availableTokens).toBe(5);
    // Wait and check still at max
    expect(limiter.availableTokens).toBeLessThanOrEqual(5);
  });
});

// ── ToolRateLimiterRegistry ─────────────────────────────────────────────────

describe("ToolRateLimiterRegistry", () => {
  const registryData: ToolRegistryData = {
    tools: {
      ga4: {
        description: "GA4",
        provider: "mcp",
        skills: ["analytics-tracking"],
        rate_limit: { max_per_minute: 10 },
        actions: [
          {
            name: "query-report",
            description: "Query",
            parameters: { type: "object" },
          },
        ],
      },
      "no-limit-tool": {
        description: "No limit",
        provider: "stub",
        skills: ["copywriting"],
        actions: [
          {
            name: "do-thing",
            description: "Do thing",
            parameters: { type: "object" },
          },
        ],
      },
    },
  };

  it("creates limiters for tools with rate_limit config", () => {
    const toolReg = ToolRegistry.fromData(registryData);
    const limiterReg = new ToolRateLimiterRegistry(toolReg);
    expect(limiterReg.getLimiter("ga4")).not.toBeNull();
  });

  it("returns null for tools without rate_limit", () => {
    const toolReg = ToolRegistry.fromData(registryData);
    const limiterReg = new ToolRateLimiterRegistry(toolReg);
    expect(limiterReg.getLimiter("no-limit-tool")).toBeNull();
  });

  it("returns null for unknown tools", () => {
    const toolReg = ToolRegistry.fromData(registryData);
    const limiterReg = new ToolRateLimiterRegistry(toolReg);
    expect(limiterReg.getLimiter("nonexistent")).toBeNull();
  });

  it("tracks limited tools", () => {
    const toolReg = ToolRegistry.fromData(registryData);
    const limiterReg = new ToolRateLimiterRegistry(toolReg);
    expect(limiterReg.limitedTools).toEqual(["ga4"]);
  });
});

// ── Exports ─────────────────────────────────────────────────────────────────

describe("Tool rate limiter exports", () => {
  it("exports from agents/index.ts", async () => {
    const mod = await import("../index.ts");
    expect(mod.TokenBucketRateLimiter).toBeDefined();
    expect(mod.ToolRateLimiterRegistry).toBeDefined();
    expect(mod.RateLimitError).toBeDefined();
  });
});
