/**
 * MCP Tool Provider — wraps MCP server communication.
 *
 * Each MCP server runs as a child process using StdioClientTransport.
 * Connections are lazy — servers spawn only when first invoked.
 * Multiple tools can share one MCP server process.
 *
 * Phase 4a: GA4, Search Console, GTM, PageSpeed MCP servers.
 */

import type { Logger } from "../observability/logger.ts";
import { NULL_LOGGER } from "../observability/logger.ts";
import type {
  ToolProvider,
  ToolInvocationResult,
  ToolRegistry,
} from "./tool-registry.ts";
import type { CredentialResolver } from "./credential-resolver.ts";

// ── MCP Connection Types ────────────────────────────────────────────────────

export interface MCPConnection {
  readonly serverPath: string;
  readonly process: ReturnType<typeof import("node:child_process").spawn> | null;
  readonly connected: boolean;
  sendRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface MCPToolProviderConfig {
  /** Maximum time to wait for server startup (ms). Default: 10000. */
  readonly connectionTimeoutMs: number;
  /** Maximum time per tool invocation (ms). Default: 60000. */
  readonly requestTimeoutMs: number;
  /** Maximum connection retry attempts on failure. Default: 2. */
  readonly maxRetries: number;
}

const DEFAULT_CONFIG: MCPToolProviderConfig = {
  connectionTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
  maxRetries: 2,
};

// ── MCP Error ───────────────────────────────────────────────────────────────

export class MCPConnectionError extends Error {
  constructor(
    message: string,
    public readonly serverPath: string,
    public readonly underlying?: unknown,
  ) {
    super(message);
    this.name = "MCPConnectionError";
  }
}

export class MCPToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly actionName: string,
    public readonly underlying?: unknown,
  ) {
    super(message);
    this.name = "MCPToolError";
  }
}

// ── Stdio MCP Connection ────────────────────────────────────────────────────

/**
 * Manages a single MCP server subprocess and provides JSON-RPC communication.
 * Uses stdin/stdout for communication following the MCP stdio transport protocol.
 */
class StdioMCPConnection implements MCPConnection {
  readonly serverPath: string;
  process: ReturnType<typeof import("node:child_process").spawn> | null = null;
  connected = false;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private buffer = "";
  private readonly logger: Logger;
  private readonly env: Record<string, string>;
  private readonly args: readonly string[];

  constructor(
    serverPath: string,
    logger: Logger,
    env?: Record<string, string>,
    args?: readonly string[],
  ) {
    this.serverPath = serverPath;
    this.logger = logger;
    this.env = env ?? {};
    this.args = args ?? [];
  }

  async connect(timeoutMs: number): Promise<void> {
    const { spawn } = await import("node:child_process");
    const { resolve: pathResolve } = await import("node:path");

    const resolvedPath = pathResolve(this.serverPath);

    this.process = spawn("bun", ["run", resolvedPath, ...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });

    // Handle stdout data (JSON-RPC responses)
    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    // Handle stderr for logging
    this.process.stderr?.on("data", (data: Buffer) => {
      this.logger.debug("mcp_server_stderr", {
        server: this.serverPath,
        message: data.toString().trim(),
      });
    });

    // Handle process exit
    this.process.on("exit", (code) => {
      this.connected = false;
      this.logger.info("mcp_server_exit", {
        server: this.serverPath,
        exitCode: code,
      });
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(
          new MCPConnectionError(
            `MCP server exited with code ${code}`,
            this.serverPath,
          ),
        );
      }
      this.pendingRequests.clear();
    });

    // Wait for server to be ready (send initialize request)
    await this.waitForReady(timeoutMs);
    this.connected = true;
  }

  async sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.process || !this.connected) {
      throw new MCPConnectionError(
        "MCP server not connected",
        this.serverPath,
      );
    }

    const id = ++this.requestId;
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        const ok = this.process!.stdin?.write(request + "\n");
        if (ok === false) {
          this.pendingRequests.delete(id);
          reject(
            new MCPConnectionError(
              "Failed to write to MCP server stdin (backpressure)",
              this.serverPath,
            ),
          );
        }
      } catch (err: unknown) {
        this.pendingRequests.delete(id);
        reject(
          new MCPConnectionError(
            `Failed to write to MCP server stdin: ${err instanceof Error ? err.message : String(err)}`,
            this.serverPath,
            err,
          ),
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.process) {
      this.connected = false;
      this.process.kill("SIGTERM");
      // Give it a moment to clean up
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.process.exitCode === null) {
        this.process.kill("SIGKILL");
      }
      this.process = null;
    }
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    // Send MCP initialize request
    const id = ++this.requestId;
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "marketing-agentic-ai",
          version: "1.0.0",
        },
      },
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new MCPConnectionError(
            `MCP server startup timed out after ${timeoutMs}ms`,
            this.serverPath,
          ),
        );
      }, Math.max(0, deadline - Date.now()));

      this.pendingRequests.set(id, {
        resolve: () => {
          clearTimeout(timer);
          // Send initialized notification
          this.process?.stdin?.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }) + "\n",
          );
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.process!.stdin?.write(initRequest + "\n");
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        };

        if (msg.id !== undefined) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(
                new MCPToolError(
                  msg.error.message,
                  "",
                  "",
                  msg.error,
                ),
              );
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      } catch {
        // Ignore unparseable lines (may be log output)
      }
    }
  }
}

// ── MCP Tool Provider ───────────────────────────────────────────────────────

export class MCPToolProvider implements ToolProvider {
  private readonly connections = new Map<string, StdioMCPConnection>();
  private readonly toolRegistry: ToolRegistry;
  private readonly credentialResolver: CredentialResolver;
  private readonly logger: Logger;
  private readonly config: MCPToolProviderConfig;

  constructor(
    toolRegistry: ToolRegistry,
    credentialResolver: CredentialResolver,
    logger?: Logger,
    config?: Partial<MCPToolProviderConfig>,
  ) {
    this.toolRegistry = toolRegistry;
    this.credentialResolver = credentialResolver;
    this.logger = (logger ?? NULL_LOGGER).child({ module: "mcp-provider" });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async invoke(
    toolName: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<ToolInvocationResult> {
    const startTime = Date.now();

    const config = this.toolRegistry.getToolConfig(toolName);
    if (!config) {
      return {
        toolName,
        actionName,
        success: false,
        content: `Tool "${toolName}" not found in registry`,
        durationMs: Date.now() - startTime,
        isStub: false,
      };
    }

    if (!config.mcp_server) {
      return {
        toolName,
        actionName,
        success: false,
        content: `Tool "${toolName}" has no MCP server configured`,
        durationMs: Date.now() - startTime,
        isStub: false,
      };
    }

    try {
      // Resolve credentials and pass as env to MCP server
      let credentialEnv: Record<string, string> = {};
      if (config.credentials_env) {
        try {
          const cred = await this.credentialResolver.resolve(config.credentials_env);
          if (cred.accessToken) {
            credentialEnv.TOOL_ACCESS_TOKEN = cred.accessToken;
          }
          if (cred.apiKey) {
            credentialEnv.TOOL_API_KEY = cred.apiKey;
          }
        } catch (err: unknown) {
          this.logger.warn("mcp_credential_resolution_failed", {
            tool: toolName,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            toolName,
            actionName,
            success: false,
            content: `Credential resolution failed for tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - startTime,
            isStub: false,
          };
        }
      }

      // Get or create connection
      const connection = await this.getOrCreateConnection(
        config.mcp_server,
        credentialEnv,
      );

      // Invoke the tool via JSON-RPC
      const result = await Promise.race([
        connection.sendRequest("tools/call", {
          name: actionName,
          arguments: params,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new MCPToolError(
                  `Tool invocation timed out after ${this.config.requestTimeoutMs}ms`,
                  toolName,
                  actionName,
                ),
              ),
            this.config.requestTimeoutMs,
          ),
        ),
      ]);

      // Parse MCP tool result
      const mcpResult = result as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      const content = mcpResult?.content
        ?.map((c) => c.text ?? "")
        .join("\n") ?? JSON.stringify(result);

      return {
        toolName,
        actionName,
        success: !mcpResult?.isError,
        content,
        durationMs: Date.now() - startTime,
        isStub: false,
      };
    } catch (err: unknown) {
      this.logger.error("mcp_tool_invocation_failed", {
        tool: toolName,
        action: actionName,
        error: err instanceof Error ? err.message : String(err),
      });

      // If connection failed, remove stale connection
      if (config.mcp_server) {
        this.connections.delete(config.mcp_server);
      }

      return {
        toolName,
        actionName,
        success: false,
        content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
        isStub: false,
      };
    }
  }

  /**
   * Disconnect all MCP server processes.
   * Called during application shutdown.
   */
  async disconnectAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [name, conn] of this.connections) {
      this.logger.info("mcp_server_disconnecting", { server: name });
      closePromises.push(conn.close());
    }
    await Promise.allSettled(closePromises);
    this.connections.clear();
  }

  /** Tracks in-flight connection attempts to prevent duplicate connections. */
  private readonly connectingPromises = new Map<string, Promise<StdioMCPConnection>>();

  private async getOrCreateConnection(
    serverPath: string,
    env: Record<string, string>,
  ): Promise<StdioMCPConnection> {
    // Return existing healthy connection
    const existing = this.connections.get(serverPath);
    if (existing?.connected) return existing;

    // Deduplicate concurrent connection attempts
    const inflight = this.connectingPromises.get(serverPath);
    if (inflight) return inflight;

    const promise = this.doConnect(serverPath, env);
    this.connectingPromises.set(serverPath, promise);
    try {
      return await promise;
    } finally {
      this.connectingPromises.delete(serverPath);
    }
  }

  private async doConnect(
    serverPath: string,
    env: Record<string, string>,
  ): Promise<StdioMCPConnection> {
    // Clean up stale connection
    const stale = this.connections.get(serverPath);
    if (stale) {
      await stale.close();
      this.connections.delete(serverPath);
    }

    // Create new connection
    const conn = new StdioMCPConnection(serverPath, this.logger, env);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        await conn.connect(this.config.connectionTimeoutMs);
        this.connections.set(serverPath, conn);
        this.logger.info("mcp_server_connected", {
          server: serverPath,
          attempt: attempt + 1,
        });
        return conn;
      } catch (err: unknown) {
        lastError = err;
        this.logger.warn("mcp_connection_attempt_failed", {
          server: serverPath,
          attempt: attempt + 1,
          maxRetries: this.config.maxRetries,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < this.config.maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    // Clean up leaked process before throwing
    await conn.close();

    throw new MCPConnectionError(
      `Failed to connect to MCP server after ${this.config.maxRetries + 1} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      serverPath,
      lastError,
    );
  }
}
