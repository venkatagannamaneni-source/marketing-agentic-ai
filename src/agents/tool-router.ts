/**
 * Tool Router — routes tool invocations to the appropriate provider.
 *
 * Sits between the executor and the tool registry. For each invocation:
 * 1. Looks up the tool's config to determine provider type
 * 2. Checks rate limits
 * 3. Routes to MCPToolProvider (mcp), StubToolProvider (stub), or errors (rest)
 *
 * Phase 4a: Routes GA4, Search Console, GTM, PageSpeed to MCP servers.
 */

import type { Logger } from "../observability/logger.ts";
import { NULL_LOGGER } from "../observability/logger.ts";
import type {
  ToolProvider,
  ToolInvocationResult,
  ToolRegistry,
} from "./tool-registry.ts";
import { StubToolProvider } from "./tool-registry.ts";
import type { MCPToolProvider } from "./mcp-tool-provider.ts";
import type { ToolRateLimiterRegistry } from "./tool-rate-limiter.ts";
import { RateLimitError } from "./tool-rate-limiter.ts";

// ── Tool Router ─────────────────────────────────────────────────────────────

export class ToolRouter implements ToolProvider {
  private readonly toolRegistry: ToolRegistry;
  private readonly mcpProvider: MCPToolProvider;
  private readonly rateLimiterRegistry: ToolRateLimiterRegistry;
  private readonly stubProvider: StubToolProvider;
  private readonly logger: Logger;

  constructor(
    toolRegistry: ToolRegistry,
    mcpProvider: MCPToolProvider,
    rateLimiterRegistry: ToolRateLimiterRegistry,
    logger?: Logger,
  ) {
    this.toolRegistry = toolRegistry;
    this.mcpProvider = mcpProvider;
    this.rateLimiterRegistry = rateLimiterRegistry;
    this.stubProvider = new StubToolProvider();
    this.logger = (logger ?? NULL_LOGGER).child({ module: "tool-router" });
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
        content: `Tool "${toolName}" not found`,
        durationMs: Date.now() - startTime,
        isStub: false,
      };
    }

    // Check rate limits
    const limiter = this.rateLimiterRegistry.getLimiter(toolName);
    if (limiter) {
      try {
        await limiter.acquire(toolName);
      } catch (err: unknown) {
        if (err instanceof RateLimitError) {
          this.logger.warn("tool_rate_limited", {
            tool: toolName,
            action: actionName,
            retryAfterMs: err.retryAfterMs,
          });
          return {
            toolName,
            actionName,
            success: false,
            content: `Rate limit exceeded for tool "${toolName}". Retry after ${Math.ceil(err.retryAfterMs / 1000)}s.`,
            durationMs: Date.now() - startTime,
            isStub: false,
          };
        }
        throw err;
      }
    }

    // Route to appropriate provider
    this.logger.debug("tool_routing", {
      tool: toolName,
      action: actionName,
      provider: config.provider,
    });

    switch (config.provider) {
      case "mcp":
        return this.mcpProvider.invoke(toolName, actionName, params);

      case "stub":
        return this.stubProvider.invoke(toolName, actionName, params);

      case "rest":
        return {
          toolName,
          actionName,
          success: false,
          content: `REST provider not yet implemented for tool "${toolName}"`,
          durationMs: Date.now() - startTime,
          isStub: false,
        };

      default:
        return {
          toolName,
          actionName,
          success: false,
          content: `Unknown provider "${config.provider}" for tool "${toolName}"`,
          durationMs: Date.now() - startTime,
          isStub: false,
        };
    }
  }
}
