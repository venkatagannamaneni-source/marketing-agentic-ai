// ── MCP Server Manager ────────────────────────────────────────────────────
// Manages lifecycle of MCP server child processes.
// One MCP Client per unique server package — shared across tools.
//
// Phase 4: Spawns MCP servers lazily on first invocation,
// detects crashes, reconnects, and shuts down gracefully.

import type { Logger } from "../observability/logger.ts";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for an MCP server process.
 */
export interface MCPServerConfig {
  /** Unique identifier (e.g., "@anthropic/ga4-mcp") — used as dedup key. */
  readonly packageName: string;
  /** Command to launch the server (default: "npx"). */
  readonly command?: string;
  /** CLI arguments (default: ["-y", packageName]). */
  readonly args?: readonly string[];
  /** Environment variables (including credentials) passed to child process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Connection timeout in ms (default: 30_000). */
  readonly timeoutMs?: number;
}

/**
 * Status of a managed MCP server.
 */
export type MCPServerStatus =
  | "connecting"
  | "connected"
  | "error"
  | "closed";

/**
 * Handle to a connected MCP server.
 */
export interface MCPServerHandle {
  readonly packageName: string;
  readonly status: MCPServerStatus;
  readonly startedAt: Date;
  readonly lastUsedAt: Date;
  /** Call a tool on the connected server. */
  callTool(name: string, args?: Record<string, unknown>): Promise<MCPCallToolResult>;
  /** List available tools from the server. */
  listTools(): Promise<MCPToolDefinition[]>;
}

/**
 * MCP tool definition (from tools/list).
 */
export interface MCPToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

/**
 * Result from calling an MCP tool.
 */
export interface MCPCallToolResult {
  readonly content: readonly MCPToolResultContent[];
  readonly isError?: boolean;
}

export type MCPToolResultContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/**
 * MCP Client interface — abstraction over the real MCP SDK Client.
 * Allows mocking in tests without requiring @modelcontextprotocol/sdk.
 */
export interface MCPClientAdapter {
  connect(): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<MCPCallToolResult>;
  close(): Promise<void>;
}

/**
 * Factory that creates an MCPClientAdapter for a given server config.
 * The real factory uses @modelcontextprotocol/sdk's Client + StdioClientTransport.
 * Tests inject a mock factory.
 */
export type MCPClientFactory = (
  config: MCPServerConfig,
) => MCPClientAdapter;

// ── Server Health ───────────────────────────────────────────────────────────

export interface ServerHealth {
  readonly packageName: string;
  readonly status: MCPServerStatus;
  readonly startedAt: Date;
  readonly lastUsedAt: Date;
  readonly reconnectCount: number;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class MCPServerError extends Error {
  override readonly name = "MCPServerError";
  readonly packageName: string;

  constructor(
    message: string,
    packageName: string,
    cause?: Error,
  ) {
    super(message, cause ? { cause } : undefined);
    this.packageName = packageName;
  }
}

// ── Internal Handle ─────────────────────────────────────────────────────────

interface ManagedServer {
  config: MCPServerConfig;
  client: MCPClientAdapter;
  status: MCPServerStatus;
  startedAt: Date;
  lastUsedAt: Date;
  reconnectCount: number;
  reconnectTimestamps: number[];
}

// ── Implementation ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RECONNECT_WINDOW_MS = 60_000;

export class MCPServerManager {
  private readonly servers = new Map<string, ManagedServer>();
  /** Pending connection promises — prevents double-spawn. */
  private readonly connecting = new Map<string, Promise<ManagedServer>>();
  private readonly logger: Logger;
  private readonly clientFactory: MCPClientFactory;
  private readonly maxReconnectAttempts: number;

  constructor(options: {
    logger: Logger;
    clientFactory: MCPClientFactory;
    maxReconnectAttempts?: number;
  }) {
    this.logger = options.logger;
    this.clientFactory = options.clientFactory;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
  }

  /**
   * Get a connected server handle, starting the server if needed.
   * Concurrent calls for the same server are deduped.
   */
  async ensureConnected(config: MCPServerConfig): Promise<MCPServerHandle> {
    const { packageName } = config;

    // Return existing healthy server
    const existing = this.servers.get(packageName);
    if (existing && existing.status === "connected") {
      existing.lastUsedAt = new Date();
      return this._toHandle(existing);
    }

    // If currently connecting, wait for that promise
    const pending = this.connecting.get(packageName);
    if (pending) {
      const server = await pending;
      return this._toHandle(server);
    }

    // Start new connection
    return this._startServer(config);
  }

  /**
   * Health status of all managed servers.
   */
  healthCheck(): Map<string, ServerHealth> {
    const result = new Map<string, ServerHealth>();
    for (const [name, server] of this.servers) {
      result.set(name, {
        packageName: name,
        status: server.status,
        startedAt: server.startedAt,
        lastUsedAt: server.lastUsedAt,
        reconnectCount: server.reconnectCount,
      });
    }
    return result;
  }

  /**
   * Stop a specific server.
   */
  async stopServer(packageName: string): Promise<void> {
    const server = this.servers.get(packageName);
    if (!server) return;

    try {
      await server.client.close();
    } catch (err) {
      this.logger.warn("Error closing MCP server", {
        packageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    server.status = "closed";
    this.servers.delete(packageName);
    this.logger.info("MCP server stopped", { event: "mcp_server_stopped", packageName });
  }

  /**
   * Graceful shutdown of all servers.
   */
  async stopAll(): Promise<void> {
    const names = [...this.servers.keys()];
    await Promise.allSettled(names.map((name) => this.stopServer(name)));
    this.connecting.clear();
  }

  /**
   * Attempt to reconnect a failed server.
   * Called by MCPToolProvider when an invocation fails.
   */
  async reconnect(config: MCPServerConfig): Promise<MCPServerHandle> {
    const { packageName } = config;
    const server = this.servers.get(packageName);

    if (server) {
      // Check reconnect rate limit
      const now = Date.now();
      server.reconnectTimestamps = server.reconnectTimestamps.filter(
        (t) => t > now - MAX_RECONNECT_WINDOW_MS,
      );
      if (server.reconnectTimestamps.length >= this.maxReconnectAttempts) {
        throw new MCPServerError(
          `MCP server "${packageName}" exceeded max reconnect attempts (${this.maxReconnectAttempts} in ${MAX_RECONNECT_WINDOW_MS / 1000}s)`,
          packageName,
        );
      }

      // Close old connection
      try {
        await server.client.close();
      } catch {
        // Ignore close errors during reconnect
      }
      this.servers.delete(packageName);
    }

    this.logger.info("Reconnecting MCP server", {
      event: "mcp_server_reconnecting",
      packageName,
    });

    const handle = await this._startServer(config);
    const reconnectedServer = this.servers.get(packageName)!;
    reconnectedServer.reconnectCount = (server?.reconnectCount ?? 0) + 1;
    reconnectedServer.reconnectTimestamps = [
      ...(server?.reconnectTimestamps ?? []),
      Date.now(),
    ];

    return handle;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _startServer(
    config: MCPServerConfig,
  ): Promise<MCPServerHandle> {
    const { packageName } = config;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const connectPromise = (async (): Promise<ManagedServer> => {
      const client = this.clientFactory(config);

      const managed: ManagedServer = {
        config,
        client,
        status: "connecting",
        startedAt: new Date(),
        lastUsedAt: new Date(),
        reconnectCount: 0,
        reconnectTimestamps: [],
      };

      try {
        // Connect with timeout
        await Promise.race([
          client.connect(),
          timeout(timeoutMs, `MCP server "${packageName}" connection timed out after ${timeoutMs}ms`),
        ]);

        // Verify server is alive by listing tools
        await Promise.race([
          client.listTools(),
          timeout(timeoutMs, `MCP server "${packageName}" listTools timed out after ${timeoutMs}ms`),
        ]);

        managed.status = "connected";
        this.servers.set(packageName, managed);

        this.logger.info("MCP server started", {
          event: "mcp_server_started",
          packageName,
        });

        return managed;
      } catch (err) {
        managed.status = "error";
        try {
          await client.close();
        } catch {
          // Ignore close errors
        }

        throw new MCPServerError(
          `Failed to start MCP server "${packageName}": ${err instanceof Error ? err.message : String(err)}`,
          packageName,
          err instanceof Error ? err : undefined,
        );
      } finally {
        this.connecting.delete(packageName);
      }
    })();

    this.connecting.set(packageName, connectPromise);
    const server = await connectPromise;
    return this._toHandle(server);
  }

  private _toHandle(server: ManagedServer): MCPServerHandle {
    return {
      packageName: server.config.packageName,
      status: server.status,
      startedAt: server.startedAt,
      lastUsedAt: server.lastUsedAt,
      async callTool(name: string, args?: Record<string, unknown>) {
        server.lastUsedAt = new Date();
        return server.client.callTool(name, args);
      },
      async listTools() {
        return server.client.listTools();
      },
    };
  }
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new MCPServerError(message, "")), ms),
  );
}
