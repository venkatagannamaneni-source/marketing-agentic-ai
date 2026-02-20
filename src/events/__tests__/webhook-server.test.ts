import { describe, it, expect, afterEach } from "bun:test";
import { createWebhookServer } from "../webhook-server.ts";
import type { WebhookServer } from "../webhook-server.ts";
import type { EmitResult } from "../event-bus.ts";
import type { SystemEvent } from "../../types/events.ts";

// ── Mock EventBus ───────────────────────────────────────────────────────────

interface MockEventBus {
  emittedEvents: SystemEvent[];
  shouldThrow: boolean;
  emit(event: SystemEvent): Promise<EmitResult>;
}

function createMockEventBus(): MockEventBus {
  const mock: MockEventBus = {
    emittedEvents: [],
    shouldThrow: false,
    async emit(event: SystemEvent): Promise<EmitResult> {
      if (mock.shouldThrow) throw new Error("EventBus emit error");
      mock.emittedEvents.push(event);
      return {
        eventId: event.id,
        eventType: event.type,
        pipelinesTriggered: 1,
        pipelineIds: ["run-1"],
        skippedReasons: [],
      };
    },
  };
  return mock;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const TOKEN = "test-token-123";

function createValidEvent(): Record<string, unknown> {
  return {
    id: `evt-test-${Date.now()}`,
    type: "traffic_drop",
    timestamp: new Date().toISOString(),
    source: "test-webhook",
    data: { percentageDrop: 25 },
  };
}

// Helper to parse JSON response with proper typing
async function parseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("WebhookServer", () => {
  let server: WebhookServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  function startServer(mockBus?: MockEventBus): { server: WebhookServer; mockBus: MockEventBus; baseUrl: string } {
    const bus = mockBus ?? createMockEventBus();
    // Use port 0 for random available port
    server = createWebhookServer({
      port: 0,
      bearerToken: TOKEN,
      eventBus: bus,
    });
    server.start();
    const baseUrl = `http://localhost:${server.port}`;
    return { server, mockBus: bus, baseUrl };
  }

  describe("POST /webhook", () => {
    it("accepts valid event with correct bearer token", async () => {
      const { baseUrl, mockBus } = startServer();
      const event = createValidEvent();

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(200);
      const body = await parseJson(response);
      expect(body.status).toBe("accepted");
      expect(body.eventId).toBe(event.id);
      expect(body.pipelinesTriggered).toBe(1);
      expect(body.pipelineIds).toEqual(["run-1"]);
      expect(mockBus.emittedEvents).toHaveLength(1);
    });

    it("rejects missing Authorization header", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createValidEvent()),
      });

      expect(response.status).toBe(401);
      const body = await parseJson(response);
      expect(body.error).toBe("Unauthorized");
    });

    it("rejects invalid bearer token", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify(createValidEvent()),
      });

      expect(response.status).toBe(401);
      const body = await parseJson(response);
      expect(body.error).toBe("Unauthorized");
    });

    it("rejects malformed JSON body", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: "not json{{{",
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response);
      expect(body.error).toBe("Bad Request");
      expect(body.message).toBe("Invalid JSON");
    });

    it("rejects event missing id field", async () => {
      const { baseUrl } = startServer();
      const event = createValidEvent();
      delete event.id;

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response);
      expect(body.message as string).toContain("id");
    });

    it("rejects event with invalid type", async () => {
      const { baseUrl } = startServer();
      const event = createValidEvent();
      event.type = "unknown_event_type";

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response);
      expect(body.message as string).toContain("type");
    });

    it("rejects event missing timestamp", async () => {
      const { baseUrl } = startServer();
      const event = createValidEvent();
      delete event.timestamp;

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response);
      expect(body.message as string).toContain("timestamp");
    });

    it("rejects event missing source", async () => {
      const { baseUrl } = startServer();
      const event = createValidEvent();
      delete event.source;

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response);
      expect(body.message as string).toContain("source");
    });

    it("rejects event with non-object data", async () => {
      const { baseUrl } = startServer();
      const event = createValidEvent();
      event.data = "not an object";

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response);
      expect(body.message as string).toContain("data");
    });

    it("rejects event with null body", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(null),
      });

      expect(response.status).toBe(400);
    });

    it("rejects event with array body", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify([createValidEvent()]),
      });

      expect(response.status).toBe(400);
    });

    it("passes validated event to eventBus.emit", async () => {
      const { baseUrl, mockBus } = startServer();
      const event = createValidEvent();

      await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(mockBus.emittedEvents).toHaveLength(1);
      expect(mockBus.emittedEvents[0]!.id).toBe(event.id as string);
      expect(mockBus.emittedEvents[0]!.type as string).toBe(event.type as string);
      expect(mockBus.emittedEvents[0]!.source).toBe(event.source as string);
    });

    it("returns pipelineIds from emit result in response", async () => {
      const { baseUrl } = startServer();
      const event = createValidEvent();

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      const body = await parseJson(response);
      expect(body.pipelineIds).toEqual(["run-1"]);
    });

    it("rejects event with empty string id", async () => {
      const { baseUrl } = startServer();
      const event = createValidEvent();
      event.id = "";

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(400);
    });

    it("returns 500 when eventBus.emit throws", async () => {
      const mockBus = createMockEventBus();
      mockBus.shouldThrow = true;
      const { baseUrl } = startServer(mockBus);
      const event = createValidEvent();

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(500);
      const body = await parseJson(response);
      expect(body.error).toBe("Internal Server Error");
    });

    it("rejects event with array data field", async () => {
      const { baseUrl } = startServer();
      const event = createValidEvent();
      event.data = [1, 2, 3];

      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(event),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("GET /health", () => {
    it("returns healthy status", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/health`);

      expect(response.status).toBe(200);
      const body = await parseJson(response);
      expect(body.status).toBe("healthy");
    });

    it("returns uptime in milliseconds", async () => {
      const { baseUrl } = startServer();

      // Small delay to ensure non-zero uptime
      await new Promise((r) => setTimeout(r, 10));

      const response = await fetch(`${baseUrl}/health`);
      const body = await parseJson(response);

      expect(typeof body.uptime).toBe("number");
      expect(body.uptime as number).toBeGreaterThanOrEqual(0);
    });

    it("returns webhook counts", async () => {
      const { baseUrl } = startServer();

      // Make a valid webhook request to increment counters
      await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(createValidEvent()),
      });

      // Make an invalid request to increment rejected counter
      await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createValidEvent()),
      });

      const response = await fetch(`${baseUrl}/health`);
      const body = await parseJson(response);

      expect(body.webhooksReceived).toBe(2);
      expect(body.webhooksAccepted).toBe(1);
      expect(body.webhooksRejected).toBe(1);
    });
  });

  describe("routing", () => {
    it("returns 404 for unknown path", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/unknown`);

      expect(response.status).toBe(404);
      const body = await parseJson(response);
      expect(body.error).toBe("Not Found");
    });

    it("returns 405 for GET /webhook", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/webhook`);

      expect(response.status).toBe(405);
      const body = await parseJson(response);
      expect(body.error).toBe("Method Not Allowed");
    });

    it("returns 405 for POST /health", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(405);
      const body = await parseJson(response);
      expect(body.error).toBe("Method Not Allowed");
    });
  });

  describe("lifecycle", () => {
    it("starts and stops cleanly", async () => {
      const { server: srv } = startServer();

      const stats1 = srv.getStats();
      expect(stats1.status).toBe("running");
      expect(stats1.startedAt).not.toBeNull();

      await srv.stop();
      server = null; // Prevent double-stop in afterEach

      const stats2 = srv.getStats();
      expect(stats2.status).toBe("stopped");
    });

    it("getStats returns correct initial state", async () => {
      const { server: srv } = startServer();

      const stats = srv.getStats();
      expect(stats.status).toBe("running");
      expect(stats.webhooksReceived).toBe(0);
      expect(stats.webhooksAccepted).toBe(0);
      expect(stats.webhooksRejected).toBe(0);
    });

    it("stop is idempotent", async () => {
      const { server: srv } = startServer();

      await srv.stop();
      await srv.stop(); // Should not throw
      server = null;
    });

    it("start is idempotent", async () => {
      const { server: srv } = startServer();

      srv.start(); // Already started — should not throw or create duplicate server
      expect(srv.getStats().status).toBe("running");
    });

    it("reports correct port", async () => {
      const { server: srv } = startServer();
      expect(typeof srv.port).toBe("number");
      expect(srv.port).toBeGreaterThan(0);
    });

    it("all responses have JSON content type", async () => {
      const { baseUrl } = startServer();

      const response = await fetch(`${baseUrl}/health`);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const response2 = await fetch(`${baseUrl}/unknown`);
      expect(response2.headers.get("Content-Type")).toBe("application/json");
    });
  });
});
