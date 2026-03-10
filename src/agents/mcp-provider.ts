// ── MCP Tool Provider ─────────────────────────────────────────────────────
// ToolProvider implementation that delegates to MCP servers.
//
// Phase 4: Routes tool invocations through MCPServerManager,
// applies rate limiting, converts MCP results to ToolInvocationResult.

import type { ToolProvider, ToolInvocationResult, ToolConfigData } from "./tool-registry.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import type {
  MCPServerManager,
  MCPServerConfig,
  MCPCallToolResult,
} from "./mcp-server-manager.ts";
import { MCPServerError } from "./mcp-server-manager.ts";
import type { Logger } from "../observability/logger.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export interface MCPProviderConfig {
  /** Timeout for individual tool calls (default: 60_000ms). */
  readonly invocationTimeoutMs?: number;
}

// ── Implementation ──────────────────────────────────────────────────────────

export class MCPToolProvider implements ToolProvider {
  private readonly serverManager: MCPServerManager;
  private readonly rateLimiter: RateLimiter;
  private readonly serverConfigs: ReadonlyMap<string, MCPServerConfig>;
  private readonly toolConfigs: ReadonlyMap<string, ToolConfigData>;
  private readonly logger: Logger;
  private readonly invocationTimeoutMs: number;

  constructor(options: {
    serverManager: MCPServerManager;
    rateLimiter: RateLimiter;
    serverConfigs: ReadonlyMap<string, MCPServerConfig>;
    toolConfigs: ReadonlyMap<string, ToolConfigData>;
    logger: Logger;
    config?: MCPProviderConfig;
  }) {
    this.serverManager = options.serverManager;
    this.rateLimiter = options.rateLimiter;
    this.serverConfigs = options.serverConfigs;
    this.toolConfigs = options.toolConfigs;
    this.logger = options.logger;
    this.invocationTimeoutMs = options.config?.invocationTimeoutMs ?? 60_000;
  }

  async invoke(
    toolName: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<ToolInvocationResult> {
    const startTime = Date.now();

    // 1. Look up server config for this tool
    const toolConfig = this.toolConfigs.get(toolName);
    if (!toolConfig?.mcp_server) {
      return this._errorResult(toolName, actionName, startTime,
        `No MCP server configured for tool "${toolName}". Set mcp_server in tools.yaml.`);
    }

    const serverConfig = this.serverConfigs.get(toolConfig.mcp_server);
    if (!serverConfig) {
      return this._errorResult(toolName, actionName, startTime,
        `MCP server config not found for "${toolConfig.mcp_server}". Check bootstrap wiring.`);
    }

    // 2. Rate limit
    try {
      await this.rateLimiter.acquire(toolName);
    } catch (err) {
      return this._errorResult(toolName, actionName, startTime,
        `Rate limit: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Get connected server
    let result: MCPCallToolResult;
    try {
      result = await this._callWithRetry(serverConfig, actionName, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("MCP tool invocation failed", {
        event: "mcp_tool_failed",
        tool: toolName,
        action: actionName,
        error: msg,
      });
      return this._errorResult(toolName, actionName, startTime, msg);
    }

    // 4. Convert MCP result to ToolInvocationResult
    const durationMs = Date.now() - startTime;
    const converted = this._convertResult(toolName, actionName, result, durationMs);

    this.logger.info("MCP tool invoked", {
      event: "mcp_tool_invoked",
      tool: toolName,
      action: actionName,
      durationMs,
      success: converted.success,
    });

    return converted;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _callWithRetry(
    serverConfig: MCPServerConfig,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<MCPCallToolResult> {
    try {
      return await this._callWithTimeout(serverConfig, actionName, params);
    } catch (err) {
      // On connection errors, try one reconnect
      if (err instanceof MCPServerError) {
        this.logger.info("Retrying after MCP server reconnect", {
          packageName: serverConfig.packageName,
          action: actionName,
        });
        const handle = await this.serverManager.reconnect(serverConfig);
        return await withTimeout(
          handle.callTool(actionName, params),
          this.invocationTimeoutMs,
          `MCP tool call timed out after ${this.invocationTimeoutMs}ms (retry)`,
        );
      }
      throw err;
    }
  }

  private async _callWithTimeout(
    serverConfig: MCPServerConfig,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<MCPCallToolResult> {
    const handle = await this.serverManager.ensureConnected(serverConfig);
    return withTimeout(
      handle.callTool(actionName, params),
      this.invocationTimeoutMs,
      `MCP tool call "${actionName}" timed out after ${this.invocationTimeoutMs}ms`,
    );
  }

  private _convertResult(
    toolName: string,
    actionName: string,
    result: MCPCallToolResult,
    durationMs: number,
  ): ToolInvocationResult {
    if (!result.content || result.content.length === 0) {
      return {
        toolName,
        actionName,
        success: !result.isError,
        content: "No data returned from MCP server",
        durationMs,
        isStub: false,
      };
    }

    // Check if all content is text — if so, return as simple string
    const hasOnlyText = result.content.every((c) => c.type === "text");
    if (hasOnlyText && result.content.length === 1) {
      return {
        toolName,
        actionName,
        success: !result.isError,
        content: (result.content[0] as { type: "text"; text: string }).text,
        durationMs,
        isStub: false,
      };
    }

    // Convert mixed content to ToolResultContent[]
    const contentBlocks = result.content.map((c) => {
      if (c.type === "text") {
        return { type: "text" as const, text: c.text };
      }
      if (c.type === "image") {
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: c.mimeType,
            data: c.data,
          },
        };
      }
      // Unsupported content type — return as text representation
      return {
        type: "text" as const,
        text: `[Unsupported content type: ${(c as { type: string }).type}]`,
      };
    });

    return {
      toolName,
      actionName,
      success: !result.isError,
      content: contentBlocks,
      durationMs,
      isStub: false,
    };
  }

  private _errorResult(
    toolName: string,
    actionName: string,
    startTime: number,
    message: string,
  ): ToolInvocationResult {
    return {
      toolName,
      actionName,
      success: false,
      content: message,
      durationMs: Date.now() - startTime,
      isStub: false,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}
