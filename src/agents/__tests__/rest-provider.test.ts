import { describe, expect, it, beforeEach, mock, afterAll } from "bun:test";
import { RESTToolProvider } from "../rest-provider.ts";
import type { RateLimiter } from "../rate-limiter.ts";
import type { ToolHandlerResult } from "../rest-provider.ts";

// ── Mock Logger ─────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    fatal: mock(() => {}),
    child: () => createMockLogger(),
  } as any;
}

function createMockRateLimiter(): RateLimiter {
  return {
    acquire: mock(async () => {}),
    tryAcquire: mock(() => true),
    configure: mock(() => {}),
    reset: mock(() => {}),
  };
}

describe("RESTToolProvider", () => {
  let provider: RESTToolProvider;
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = createMockRateLimiter();
    provider = new RESTToolProvider({
      rateLimiter,
      logger: createMockLogger(),
    });
  });

  describe("in-process handlers", () => {
    it("invokes a registered handler", async () => {
      const handler = mock(async (_action: string, _params: Record<string, unknown>): Promise<ToolHandlerResult> => ({
        success: true,
        content: '{"result": "page analyzed"}',
      }));

      provider.registerHandler("browser", handler);
      const result = await provider.invoke("browser", "analyze-page", { url: "https://example.com" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("page analyzed");
      expect(result.isStub).toBe(false);
      expect(handler).toHaveBeenCalledWith("analyze-page", { url: "https://example.com" });
    });

    it("returns error on handler exception", async () => {
      const failHandler = mock(async (): Promise<ToolHandlerResult> => {
        throw new Error("Browser crash");
      });

      provider.registerHandler("browser", failHandler);
      const result = await provider.invoke("browser", "screenshot", {});

      expect(result.success).toBe(false);
      expect(result.content).toContain("Browser crash");
    });

    it("acquires rate limit before handler call", async () => {
      const handler = mock(async (): Promise<ToolHandlerResult> => ({
        success: true,
        content: "ok",
      }));
      provider.registerHandler("browser", handler);
      await provider.invoke("browser", "screenshot", {});
      expect(rateLimiter.acquire).toHaveBeenCalledWith("browser");
    });

    it("returns handler failure result", async () => {
      const handler = mock(async (): Promise<ToolHandlerResult> => ({
        success: false,
        content: "Page not found",
      }));
      provider.registerHandler("browser", handler);
      const result = await provider.invoke("browser", "screenshot", {});
      expect(result.success).toBe(false);
      expect(result.content).toBe("Page not found");
    });
  });

  describe("unregistered tools", () => {
    it("returns error for unknown tool", async () => {
      const result = await provider.invoke("unknown", "action", {});
      expect(result.success).toBe(false);
      expect(result.content).toContain("No handler or endpoint registered");
    });
  });

  describe("HTTP endpoints", () => {
    let server: ReturnType<typeof Bun.serve>;

    beforeEach(() => {
      server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/api/posts" && req.method === "POST") {
            return new Response(JSON.stringify({ id: 1, title: "Test Post" }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.pathname === "/api/posts" && req.method === "GET") {
            return new Response(JSON.stringify([{ id: 1 }]), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.pathname === "/api/error") {
            return new Response("Not Found", { status: 404 });
          }
          return new Response("OK");
        },
      });
    });

    afterAll(() => {
      server?.stop(true);
    });

    it("makes POST request to registered endpoint", async () => {
      provider.registerEndpoint("wordpress", "create-post", {
        baseUrl: `http://localhost:${server.port}`,
        pathTemplate: "/api/posts",
        method: "POST",
      });

      const result = await provider.invoke("wordpress", "create-post", {
        title: "Test Post",
        content: "<p>Hello</p>",
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain("Test Post");
      expect(result.isStub).toBe(false);
    });

    it("handles HTTP error responses", async () => {
      provider.registerEndpoint("wordpress", "fail-action", {
        baseUrl: `http://localhost:${server.port}`,
        pathTemplate: "/api/error",
        method: "GET",
      });

      const result = await provider.invoke("wordpress", "fail-action", {});
      expect(result.success).toBe(false);
    });
  });

  describe("rate limit error", () => {
    it("returns error when rate limiter rejects", async () => {
      const rejectLimiter: RateLimiter = {
        acquire: mock(async () => { throw new Error("Rate exceeded"); }),
        tryAcquire: mock(() => false),
        configure: mock(() => {}),
        reset: mock(() => {}),
      };
      const rateLimitProvider = new RESTToolProvider({
        rateLimiter: rejectLimiter,
        logger: createMockLogger(),
      });
      rateLimitProvider.registerHandler("test", mock(async () => ({ success: true, content: "ok" })));

      const result = await rateLimitProvider.invoke("test", "action", {});
      expect(result.success).toBe(false);
      expect(result.content).toContain("Rate limit");
    });
  });
});
