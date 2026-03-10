import { describe, expect, it, beforeEach } from "bun:test";
import {
  SlidingWindowRateLimiter,
  RateLimitTimeoutError,
} from "../rate-limiter.ts";

describe("SlidingWindowRateLimiter", () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter({ maxWaitMs: 2_000 });
  });

  describe("configure", () => {
    it("accepts positive max_per_minute", () => {
      expect(() => limiter.configure("ga4", 60)).not.toThrow();
    });

    it("rejects zero max_per_minute", () => {
      expect(() => limiter.configure("ga4", 0)).toThrow(/must be positive/);
    });

    it("rejects negative max_per_minute", () => {
      expect(() => limiter.configure("ga4", -1)).toThrow(/must be positive/);
    });
  });

  describe("tryAcquire", () => {
    it("returns true when under limit", () => {
      limiter.configure("ga4", 5);
      expect(limiter.tryAcquire("ga4")).toBe(true);
    });

    it("returns true for unconfigured tools (unlimited)", () => {
      expect(limiter.tryAcquire("unknown-tool")).toBe(true);
    });

    it("returns false when at limit", () => {
      limiter.configure("ga4", 2);
      expect(limiter.tryAcquire("ga4")).toBe(true);
      expect(limiter.tryAcquire("ga4")).toBe(true);
      expect(limiter.tryAcquire("ga4")).toBe(false);
    });

    it("tracks limits independently per tool", () => {
      limiter.configure("ga4", 1);
      limiter.configure("gsc", 1);
      expect(limiter.tryAcquire("ga4")).toBe(true);
      expect(limiter.tryAcquire("ga4")).toBe(false);
      expect(limiter.tryAcquire("gsc")).toBe(true);
      expect(limiter.tryAcquire("gsc")).toBe(false);
    });
  });

  describe("acquire", () => {
    it("resolves immediately when under limit", async () => {
      limiter.configure("ga4", 10);
      await limiter.acquire("ga4"); // Should not throw or block
    });

    it("resolves immediately for unconfigured tools", async () => {
      await limiter.acquire("unconfigured"); // Should not throw
    });

    it("consumes a slot on acquire", async () => {
      limiter.configure("ga4", 2);
      await limiter.acquire("ga4");
      await limiter.acquire("ga4");
      expect(limiter.tryAcquire("ga4")).toBe(false);
    });

    it("throws RateLimitTimeoutError when maxWaitMs exceeded", async () => {
      const fastLimiter = new SlidingWindowRateLimiter({ maxWaitMs: 50 });
      fastLimiter.configure("ga4", 1);
      await fastLimiter.acquire("ga4"); // Use the one slot

      try {
        await fastLimiter.acquire("ga4");
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitTimeoutError);
        expect((err as RateLimitTimeoutError).toolName).toBe("ga4");
      }
    });
  });

  describe("reset", () => {
    it("clears all timestamps for a tool", () => {
      limiter.configure("ga4", 2);
      expect(limiter.tryAcquire("ga4")).toBe(true);
      expect(limiter.tryAcquire("ga4")).toBe(true);
      expect(limiter.tryAcquire("ga4")).toBe(false);

      limiter.reset("ga4");
      expect(limiter.tryAcquire("ga4")).toBe(true);
    });

    it("does not affect other tools", () => {
      limiter.configure("ga4", 1);
      limiter.configure("gsc", 1);
      limiter.tryAcquire("ga4");
      limiter.tryAcquire("gsc");

      limiter.reset("ga4");
      expect(limiter.tryAcquire("ga4")).toBe(true);
      expect(limiter.tryAcquire("gsc")).toBe(false);
    });

    it("is safe to call on unconfigured tool", () => {
      expect(() => limiter.reset("nonexistent")).not.toThrow();
    });
  });

  describe("concurrent callers", () => {
    it("serializes concurrent acquire calls for same tool", async () => {
      limiter.configure("ga4", 3);
      const results = await Promise.all([
        limiter.acquire("ga4"),
        limiter.acquire("ga4"),
        limiter.acquire("ga4"),
      ]);
      // All three should resolve (3 slots available)
      expect(results.length).toBe(3);
      // Fourth should fail
      expect(limiter.tryAcquire("ga4")).toBe(false);
    });
  });
});
