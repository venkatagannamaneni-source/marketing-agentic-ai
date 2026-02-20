// Server type uses never as the generic for no WebSocket support
type BunServer = ReturnType<typeof Bun.serve>;
import type { SystemEvent, EventType } from "../types/events.ts";
import { EVENT_TYPES } from "../types/events.ts";
import type { EventBus, EventBusLogger } from "./event-bus.ts";

// ── Webhook Server Types ────────────────────────────────────────────────────

export interface WebhookServerConfig {
  readonly port: number;
  readonly bearerToken: string;
  readonly eventBus: EventBus;
  readonly logger?: EventBusLogger;
}

export interface WebhookServer {
  readonly port: number;
  start(): void;
  stop(): Promise<void>;
  getStats(): WebhookStats;
}

export interface WebhookStats {
  readonly status: "running" | "stopped";
  readonly startedAt: string | null;
  readonly webhooksReceived: number;
  readonly webhooksAccepted: number;
  readonly webhooksRejected: number;
  readonly uptimeMs: number;
}

// ── Null Logger ─────────────────────────────────────────────────────────────

const NULL_LOGGER: EventBusLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Event Validation ────────────────────────────────────────────────────────

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

function validateSystemEvent(
  body: unknown,
): { valid: true; event: SystemEvent } | { valid: false; reason: string } {
  if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, reason: "Body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return { valid: false, reason: "Missing or invalid 'id' field" };
  }

  if (typeof obj.type !== "string" || !EVENT_TYPE_SET.has(obj.type)) {
    return {
      valid: false,
      reason: `Invalid 'type' field: must be one of ${EVENT_TYPES.join(", ")}`,
    };
  }

  if (typeof obj.timestamp !== "string" || obj.timestamp.length === 0) {
    return { valid: false, reason: "Missing or invalid 'timestamp' field" };
  }

  if (typeof obj.source !== "string" || obj.source.length === 0) {
    return { valid: false, reason: "Missing or invalid 'source' field" };
  }

  if (obj.data === null || obj.data === undefined || typeof obj.data !== "object" || Array.isArray(obj.data)) {
    return { valid: false, reason: "Missing or invalid 'data' field: must be an object" };
  }

  return {
    valid: true,
    event: {
      id: obj.id,
      type: obj.type as EventType,
      timestamp: obj.timestamp,
      source: obj.source,
      data: obj.data as Record<string, unknown>,
    },
  };
}

// ── JSON Response Helpers ───────────────────────────────────────────────────

function jsonResponse(data: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createWebhookServer(config: WebhookServerConfig): WebhookServer {
  const logger = config.logger ?? NULL_LOGGER;
  let server: BunServer | null = null;
  let startedAt: string | null = null;
  let startedAtMs = 0;
  let webhooksReceived = 0;
  let webhooksAccepted = 0;
  let webhooksRejected = 0;

  function getStats(): WebhookStats {
    return {
      status: server !== null ? "running" : "stopped",
      startedAt,
      webhooksReceived,
      webhooksAccepted,
      webhooksRejected,
      uptimeMs: startedAt !== null ? Date.now() - startedAtMs : 0,
    };
  }

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Route: GET /health
    if (path === "/health") {
      if (method !== "GET") {
        return jsonResponse({ error: "Method Not Allowed" }, 405);
      }
      const stats = getStats();
      return jsonResponse(
        {
          status: "healthy",
          uptime: stats.uptimeMs,
          webhooksReceived: stats.webhooksReceived,
          webhooksAccepted: stats.webhooksAccepted,
          webhooksRejected: stats.webhooksRejected,
        },
        200,
      );
    }

    // Route: POST /webhook
    if (path === "/webhook") {
      if (method !== "POST") {
        return jsonResponse({ error: "Method Not Allowed" }, 405);
      }

      webhooksReceived++;

      // Authenticate
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || authHeader !== `Bearer ${config.bearerToken}`) {
        webhooksRejected++;
        logger.warn("Unauthorized webhook request");
        return jsonResponse(
          { error: "Unauthorized", message: "Invalid or missing bearer token" },
          401,
        );
      }

      // Parse JSON body
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        webhooksRejected++;
        return jsonResponse(
          { error: "Bad Request", message: "Invalid JSON" },
          400,
        );
      }

      // Validate event shape
      const validation = validateSystemEvent(body);
      if (!validation.valid) {
        webhooksRejected++;
        return jsonResponse(
          { error: "Bad Request", message: `Invalid event: ${validation.reason}` },
          400,
        );
      }

      // Emit event
      const result = await config.eventBus.emit(validation.event);
      webhooksAccepted++;

      logger.info("Webhook processed", {
        eventId: result.eventId,
        eventType: result.eventType,
        pipelinesTriggered: result.pipelinesTriggered,
      });

      return jsonResponse(
        {
          status: "accepted",
          eventId: result.eventId,
          pipelinesTriggered: result.pipelinesTriggered,
          pipelineIds: result.pipelineIds,
        },
        200,
      );
    }

    // Unknown path
    return jsonResponse({ error: "Not Found" }, 404);
  }

  const webhookServer: WebhookServer = {
    get port() {
      return server?.port ?? config.port;
    },
    start() {
      if (server !== null) return;
      server = Bun.serve({
        port: config.port,
        fetch: handleRequest,
      });
      startedAt = new Date().toISOString();
      startedAtMs = Date.now();
      logger.info("Webhook server started", { port: server.port });
    },
    async stop() {
      if (server === null) return;
      server.stop(true);
      server = null;
      logger.info("Webhook server stopped");
    },
    getStats,
  };

  return webhookServer;
}
