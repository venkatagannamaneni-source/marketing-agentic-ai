// ── REST Tool Provider ────────────────────────────────────────────────────
// ToolProvider implementation for tools that use REST APIs or in-process handlers.
//
// Phase 4: Supports two modes:
//   1. In-process handlers (e.g., Playwright) — registered via registerHandler()
//   2. HTTP endpoint handlers — registered via registerEndpoint()

import type { ToolProvider, ToolInvocationResult } from "./tool-registry.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import type { Logger } from "../observability/logger.ts";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A function that handles tool invocations in-process.
 * Used for tools like Playwright that don't need HTTP.
 */
export type ToolHandler = (
  actionName: string,
  params: Record<string, unknown>,
) => Promise<ToolHandlerResult>;

export interface ToolHandlerResult {
  readonly success: boolean;
  readonly content: string;
}

/**
 * Configuration for an HTTP REST endpoint.
 */
export interface RESTEndpointConfig {
  /** Base URL (e.g., "https://api.example.com/v2"). */
  readonly baseUrl: string;
  /** HTTP method (default: "POST"). */
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** URL path template — {param} placeholders replaced from params. */
  readonly pathTemplate?: string;
  /** Auth type. */
  readonly authType?: "bearer" | "api_key" | "basic" | "none";
  /** Env var name containing the auth credential. */
  readonly authEnvVar?: string;
  /** Additional headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Request timeout in ms (default: 30_000). */
  readonly timeoutMs?: number;
}

// ── Implementation ──────────────────────────────────────────────────────────

export class RESTToolProvider implements ToolProvider {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly endpoints = new Map<string, RESTEndpointConfig>();
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;

  constructor(options: {
    rateLimiter: RateLimiter;
    logger: Logger;
  }) {
    this.rateLimiter = options.rateLimiter;
    this.logger = options.logger;
  }

  /**
   * Register an in-process handler for a tool.
   * The handler receives (actionName, params) and returns a result.
   */
  registerHandler(toolName: string, handler: ToolHandler): void {
    this.handlers.set(toolName, handler);
  }

  /**
   * Register an HTTP endpoint for a tool action.
   * Key format: "toolName__actionName".
   */
  registerEndpoint(
    toolName: string,
    actionName: string,
    config: RESTEndpointConfig,
  ): void {
    this.endpoints.set(`${toolName}__${actionName}`, config);
  }

  async invoke(
    toolName: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<ToolInvocationResult> {
    const startTime = Date.now();

    // Rate limit
    try {
      await this.rateLimiter.acquire(toolName);
    } catch (err) {
      return this._errorResult(toolName, actionName, startTime,
        `Rate limit: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Try in-process handler first
    const handler = this.handlers.get(toolName);
    if (handler) {
      return this._invokeHandler(toolName, actionName, params, handler, startTime);
    }

    // Try HTTP endpoint
    const qualifiedKey = `${toolName}__${actionName}`;
    const endpoint = this.endpoints.get(qualifiedKey);
    if (endpoint) {
      return this._invokeEndpoint(toolName, actionName, params, endpoint, startTime);
    }

    return this._errorResult(toolName, actionName, startTime,
      `No handler or endpoint registered for tool "${toolName}" action "${actionName}"`);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _invokeHandler(
    toolName: string,
    actionName: string,
    params: Record<string, unknown>,
    handler: ToolHandler,
    startTime: number,
  ): Promise<ToolInvocationResult> {
    try {
      const result = await handler(actionName, params);
      const durationMs = Date.now() - startTime;

      this.logger.info("REST tool invoked (handler)", {
        event: "tool_invoked",
        tool: toolName,
        action: actionName,
        durationMs,
        success: result.success,
      });

      return {
        toolName,
        actionName,
        success: result.success,
        content: result.content,
        durationMs,
        isStub: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("REST tool handler failed", {
        event: "tool_failed",
        tool: toolName,
        action: actionName,
        error: msg,
      });
      return this._errorResult(toolName, actionName, startTime, msg);
    }
  }

  private async _invokeEndpoint(
    toolName: string,
    actionName: string,
    params: Record<string, unknown>,
    config: RESTEndpointConfig,
    startTime: number,
  ): Promise<ToolInvocationResult> {
    const method = config.method ?? "POST";
    const timeoutMs = config.timeoutMs ?? 30_000;

    // Build URL
    let url = config.baseUrl;
    if (config.pathTemplate) {
      let path = config.pathTemplate;
      for (const [key, value] of Object.entries(params)) {
        path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
      }
      url = `${url}${path}`;
    }

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    // Auth
    if (config.authType && config.authType !== "none" && config.authEnvVar) {
      const credential = process.env[config.authEnvVar];
      if (!credential) {
        return this._errorResult(toolName, actionName, startTime,
          `Missing credential: env var "${config.authEnvVar}" is not set`);
      }

      switch (config.authType) {
        case "bearer":
          headers["Authorization"] = `Bearer ${credential}`;
          break;
        case "api_key":
          headers["Authorization"] = `apikey ${credential}`;
          break;
        case "basic":
          headers["Authorization"] = `Basic ${btoa(credential)}`;
          break;
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (method !== "GET" && Object.keys(params).length > 0) {
        fetchOptions.body = JSON.stringify(params);
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);

      // Parse response
      let responseBody: string;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = await response.json();
        responseBody = JSON.stringify(json, null, 2);
      } else {
        responseBody = await response.text();
      }

      const durationMs = Date.now() - startTime;
      const success = response.ok;

      this.logger.info("REST tool invoked (endpoint)", {
        event: "tool_invoked",
        tool: toolName,
        action: actionName,
        durationMs,
        success,
        httpStatus: response.status,
      });

      return {
        toolName,
        actionName,
        success,
        content: responseBody,
        durationMs,
        isStub: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("REST endpoint call failed", {
        event: "tool_failed",
        tool: toolName,
        action: actionName,
        error: msg,
      });
      return this._errorResult(toolName, actionName, startTime, msg);
    }
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
