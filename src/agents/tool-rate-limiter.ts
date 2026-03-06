/**
 * Token bucket rate limiter for tool invocations.
 *
 * Each tool with a `rate_limit.max_per_minute` config gets its own limiter.
 * Tools without rate limits pass through unrestricted.
 *
 * Phase 4a: Enforces Google API rate limits (GA4: 10/min, GSC: 200/min, GTM: 5/min, PageSpeed: 15/min).
 */

import type { ToolRegistry } from "./tool-registry.ts";

// ── Rate Limiter Error ──────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ── Token Bucket Rate Limiter ───────────────────────────────────────────────

/**
 * Simple token bucket limiter.
 * Tokens refill at a constant rate up to the max capacity.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private readonly refillRatePerMs: number;
  private readonly maxTokens: number;

  constructor(maxPerMinute: number) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.lastRefillTime = Date.now();
    this.refillRatePerMs = maxPerMinute / 60_000;
  }

  /**
   * Try to acquire a token without blocking.
   * Returns true if a token was available, false otherwise.
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Wait until a token is available, up to the timeout.
   * Throws RateLimitError if the timeout expires.
   */
  async acquire(toolName: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.tryAcquire()) return;

      // Calculate wait time until next token
      const waitMs = Math.min(this.msUntilNextToken(), deadline - Date.now());
      if (waitMs <= 0) break;

      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 100)));
    }

    // One final attempt after timeout loop
    if (this.tryAcquire()) return;

    throw new RateLimitError(
      `Rate limit exceeded for tool "${toolName}" (max ${this.maxTokens}/minute)`,
      toolName,
      this.msUntilNextToken(),
    );
  }

  /**
   * Get the number of available tokens (for monitoring).
   */
  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTime;
    if (elapsedMs <= 0) return;

    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsedMs * this.refillRatePerMs,
    );
    this.lastRefillTime = now;
  }

  private msUntilNextToken(): number {
    if (this.tokens >= 1) return 0;
    const tokensNeeded = 1 - this.tokens;
    return Math.ceil(tokensNeeded / this.refillRatePerMs);
  }
}

// ── Rate Limiter Registry ───────────────────────────────────────────────────

/**
 * Creates and manages per-tool rate limiters based on ToolRegistry config.
 */
export class ToolRateLimiterRegistry {
  private readonly limiters = new Map<string, TokenBucketRateLimiter>();

  constructor(toolRegistry: ToolRegistry) {
    for (const toolName of toolRegistry.toolNames) {
      const config = toolRegistry.getToolConfig(toolName);
      if (config?.rate_limit?.max_per_minute) {
        this.limiters.set(
          toolName,
          new TokenBucketRateLimiter(config.rate_limit.max_per_minute),
        );
      }
    }
  }

  /**
   * Get the limiter for a tool, or null if the tool has no rate limit.
   */
  getLimiter(toolName: string): TokenBucketRateLimiter | null {
    return this.limiters.get(toolName) ?? null;
  }

  /**
   * Get all tool names that have rate limiters configured.
   */
  get limitedTools(): readonly string[] {
    return [...this.limiters.keys()];
  }
}
