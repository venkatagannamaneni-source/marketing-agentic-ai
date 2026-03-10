// ── Rate Limiter ──────────────────────────────────────────────────────────
// Sliding-window token bucket rate limiter, keyed by tool name.
// No external dependencies — runs entirely in-process.
//
// Phase 4: Used by MCPToolProvider and RESTToolProvider to enforce
// per-tool rate limits declared in tools.yaml.

/**
 * RateLimiter interface — acquire a slot before invoking a tool.
 */
export interface RateLimiter {
  /** Block until a slot is available (max `maxWaitMs`). Throws on timeout. */
  acquire(toolName: string): Promise<void>;
  /** Non-blocking check: returns true if a slot is immediately available. */
  tryAcquire(toolName: string): boolean;
  /** Configure rate limit for a tool. Call once at bootstrap. */
  configure(toolName: string, maxPerMinute: number): void;
  /** Reset a tool's rate limit window (for testing). */
  reset(toolName: string): void;
}

/** Error thrown when acquire() times out waiting for a slot. */
export class RateLimitTimeoutError extends Error {
  override readonly name = "RateLimitTimeoutError";

  constructor(
    readonly toolName: string,
    readonly maxWaitMs: number,
  ) {
    super(
      `Rate limit timeout: tool "${toolName}" could not acquire a slot within ${maxWaitMs}ms`,
    );
  }
}

// ── Internal Types ──────────────────────────────────────────────────────────

interface ToolBucket {
  readonly maxPerMinute: number;
  readonly timestamps: number[];
  /** Promise chain to serialize concurrent callers for same tool */
  queue: Promise<void>;
}

const WINDOW_MS = 60_000; // 1-minute sliding window

// ── Implementation ──────────────────────────────────────────────────────────

export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, ToolBucket>();
  private readonly maxWaitMs: number;

  constructor(options?: { maxWaitMs?: number }) {
    this.maxWaitMs = options?.maxWaitMs ?? 60_000;
  }

  configure(toolName: string, maxPerMinute: number): void {
    if (maxPerMinute <= 0) {
      throw new Error(
        `Rate limit for "${toolName}" must be positive, got ${maxPerMinute}`,
      );
    }
    this.buckets.set(toolName, {
      maxPerMinute,
      timestamps: [],
      queue: Promise.resolve(),
    });
  }

  async acquire(toolName: string): Promise<void> {
    const bucket = this.buckets.get(toolName);
    if (!bucket) {
      // No rate limit configured — unlimited throughput
      return;
    }

    // Chain this caller onto the per-tool queue to avoid TOCTOU races
    const result = new Promise<void>((resolve, reject) => {
      bucket.queue = bucket.queue.then(async () => {
        try {
          await this._acquireSlot(bucket, toolName);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    return result;
  }

  tryAcquire(toolName: string): boolean {
    const bucket = this.buckets.get(toolName);
    if (!bucket) return true; // unlimited

    this._evictExpired(bucket);
    if (bucket.timestamps.length < bucket.maxPerMinute) {
      bucket.timestamps.push(Date.now());
      return true;
    }
    return false;
  }

  reset(toolName: string): void {
    const bucket = this.buckets.get(toolName);
    if (bucket) {
      bucket.timestamps.length = 0;
      bucket.queue = Promise.resolve();
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _acquireSlot(
    bucket: ToolBucket,
    toolName: string,
  ): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;

    while (true) {
      this._evictExpired(bucket);

      if (bucket.timestamps.length < bucket.maxPerMinute) {
        bucket.timestamps.push(Date.now());
        return;
      }

      // Compute wait time until oldest entry expires
      const oldest = bucket.timestamps[0]!;
      const waitMs = oldest + WINDOW_MS - Date.now() + 1; // +1 to ensure it's past the window

      if (Date.now() + waitMs > deadline) {
        throw new RateLimitTimeoutError(toolName, this.maxWaitMs);
      }

      await sleep(Math.max(1, waitMs));
    }
  }

  private _evictExpired(bucket: ToolBucket): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= cutoff) {
      bucket.timestamps.shift();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
