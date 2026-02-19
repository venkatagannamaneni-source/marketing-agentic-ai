import type { ComponentHealth } from "../types/health.ts";
import type { RedisConfig } from "./types.ts";

// ── Redis Client Interface ──────────────────────────────────────────────────
// Abstraction over ioredis for testability.

export interface RedisClient {
  readonly status: string;
  ping(): Promise<string>;
  quit(): Promise<string>;
  disconnect(): void;
}

// ── Redis Connection Manager ────────────────────────────────────────────────

export interface RedisConnectionManager {
  getClient(): RedisClient;
  checkHealth(): Promise<ComponentHealth>;
  close(): Promise<void>;
  isConnected(): boolean;
}

// ── Implementation ──────────────────────────────────────────────────────────

class RedisConnectionManagerImpl implements RedisConnectionManager {
  private connected = false;

  constructor(private readonly client: RedisClient) {
    // With lazyConnect: true, status won't be "ready" at construction time.
    // Only trust "ready" as connected; checkHealth() will update via ping.
    this.connected = client.status === "ready";
  }

  getClient(): RedisClient {
    return this.client;
  }

  async checkHealth(): Promise<ComponentHealth> {
    const now = new Date().toISOString();

    try {
      const response = await this.client.ping();
      this.connected = response === "PONG";

      return {
        name: "redis",
        status: this.connected ? "healthy" : "degraded",
        lastCheckedAt: now,
        details: { response, clientStatus: this.client.status },
      };
    } catch (err: unknown) {
      this.connected = false;
      const message = err instanceof Error ? err.message : String(err);

      return {
        name: "redis",
        status: "offline",
        lastCheckedAt: now,
        details: { error: message, clientStatus: this.client.status },
      };
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// ── Factory Functions ───────────────────────────────────────────────────────

/**
 * Create a Redis connection from config using ioredis.
 * Lazily imports ioredis to avoid hard dependency in tests.
 */
export async function createRedisConnection(
  config: RedisConfig,
): Promise<RedisConnectionManager> {
  const { default: Redis } = await import("ioredis");
  const client = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    connectTimeout: config.connectTimeout,
    lazyConnect: config.lazyConnect,
  }) as unknown as RedisClient;

  return new RedisConnectionManagerImpl(client);
}

/**
 * Create a Redis connection manager from an existing client.
 * Useful for testing with mock clients.
 */
export function createRedisConnectionFromClient(
  client: RedisClient,
): RedisConnectionManager {
  return new RedisConnectionManagerImpl(client);
}
