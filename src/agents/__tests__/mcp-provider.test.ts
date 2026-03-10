import { describe, expect, it, beforeEach, mock } from "bun:test";
import { MCPToolProvider } from "../mcp-provider.ts";
import { MCPServerError } from "../mcp-server-manager.ts";
import type {
  MCPServerManager,
  MCPServerConfig,
  MCPServerHandle,
  MCPCallToolResult,
} from "../mcp-server-manager.ts";
import type { RateLimiter } from "../rate-limiter.ts";
import type { ToolConfigData } from "../tool-registry.ts";

// ── Mock Factories ──────────────────────────────────────────────────────────

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

function createMockHandle(
  callToolResult?: MCPCallToolResult,
): MCPServerHandle {
  return {
    packageName: "@test/mcp-server",
    status: "connected",
    startedAt: new Date(),
    lastUsedAt: new Date(),
    callTool: mock(async () =>
      callToolResult ?? { content: [{ type: "text" as const, text: "test result" }] },
    ),
    listTools: mock(async () => []),
  };
}

function createMockServerManager(handle?: MCPServerHandle): MCPServerManager {
  const h = handle ?? createMockHandle();
  return {
    ensureConnected: mock(async () => h),
    reconnect: mock(async () => h),
    stopServer: mock(async () => {}),
    stopAll: mock(async () => {}),
    healthCheck: mock(() => new Map()),
  } as any;
}

const SERVER_CONFIG: MCPServerConfig = {
  packageName: "@test/mcp-server",
};

const TOOL_CONFIG: ToolConfigData = {
  description: "Test MCP Tool",
  provider: "mcp",
  mcp_server: "@test/mcp-server",
  skills: ["test-skill"],
  actions: [
    { name: "test-action", description: "Test action", parameters: { type: "object" } },
  ],
};

describe("MCPToolProvider", () => {
  let provider: MCPToolProvider;
  let serverManager: MCPServerManager;
  let rateLimiter: RateLimiter;
  let handle: MCPServerHandle;

  beforeEach(() => {
    handle = createMockHandle();
    serverManager = createMockServerManager(handle);
    rateLimiter = createMockRateLimiter();

    provider = new MCPToolProvider({
      serverManager,
      rateLimiter,
      serverConfigs: new Map([["@test/mcp-server", SERVER_CONFIG]]),
      toolConfigs: new Map([["test-tool", TOOL_CONFIG]]),
      logger: createMockLogger(),
      config: { invocationTimeoutMs: 5_000 },
    });
  });

  describe("invoke — success", () => {
    it("returns text content from MCP server", async () => {
      const result = await provider.invoke("test-tool", "test-action", { key: "val" });
      expect(result.success).toBe(true);
      expect(result.content).toBe("test result");
      expect(result.isStub).toBe(false);
      expect(result.toolName).toBe("test-tool");
      expect(result.actionName).toBe("test-action");
    });

    it("acquires rate limit before calling", async () => {
      await provider.invoke("test-tool", "test-action", {});
      expect(rateLimiter.acquire).toHaveBeenCalledWith("test-tool");
    });

    it("calls ensureConnected on server manager", async () => {
      await provider.invoke("test-tool", "test-action", {});
      expect(serverManager.ensureConnected).toHaveBeenCalled();
    });

    it("passes actionName and params to callTool", async () => {
      const params = { property_id: "123", start_date: "2024-01-01" };
      await provider.invoke("test-tool", "test-action", params);
      expect(handle.callTool).toHaveBeenCalledWith("test-action", params);
    });
  });

  describe("invoke — image content", () => {
    it("converts MCP image to ToolResultImageContent", async () => {
      const imageHandle = createMockHandle({
        content: [
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      });
      const imgManager = createMockServerManager(imageHandle);

      const imgProvider = new MCPToolProvider({
        serverManager: imgManager,
        rateLimiter,
        serverConfigs: new Map([["@test/mcp-server", SERVER_CONFIG]]),
        toolConfigs: new Map([["test-tool", TOOL_CONFIG]]),
        logger: createMockLogger(),
      });

      const result = await imgProvider.invoke("test-tool", "test-action", {});
      expect(result.success).toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      const blocks = result.content as any[];
      expect(blocks[0].type).toBe("image");
      expect(blocks[0].source.data).toBe("base64data");
      expect(blocks[0].source.media_type).toBe("image/png");
    });
  });

  describe("invoke — error handling", () => {
    it("returns error when MCP returns isError: true", async () => {
      const errorHandle = createMockHandle({
        content: [{ type: "text", text: "Auth failed" }],
        isError: true,
      });
      const errManager = createMockServerManager(errorHandle);

      const errProvider = new MCPToolProvider({
        serverManager: errManager,
        rateLimiter,
        serverConfigs: new Map([["@test/mcp-server", SERVER_CONFIG]]),
        toolConfigs: new Map([["test-tool", TOOL_CONFIG]]),
        logger: createMockLogger(),
      });

      const result = await errProvider.invoke("test-tool", "test-action", {});
      expect(result.success).toBe(false);
      expect(result.content).toBe("Auth failed");
    });

    it("returns error for tool with no mcp_server", async () => {
      const noServerConfig: ToolConfigData = { ...TOOL_CONFIG, mcp_server: undefined };
      const noServerProvider = new MCPToolProvider({
        serverManager,
        rateLimiter,
        serverConfigs: new Map(),
        toolConfigs: new Map([["no-server", noServerConfig]]),
        logger: createMockLogger(),
      });

      const result = await noServerProvider.invoke("no-server", "test-action", {});
      expect(result.success).toBe(false);
      expect(result.content).toContain("No MCP server configured");
    });

    it("returns error when tool config not found", async () => {
      const result = await provider.invoke("unknown-tool", "test-action", {});
      expect(result.success).toBe(false);
      expect(result.content).toContain("No MCP server configured");
    });

    it("returns error for empty content array", async () => {
      const emptyHandle = createMockHandle({ content: [] });
      const emptyManager = createMockServerManager(emptyHandle);

      const emptyProvider = new MCPToolProvider({
        serverManager: emptyManager,
        rateLimiter,
        serverConfigs: new Map([["@test/mcp-server", SERVER_CONFIG]]),
        toolConfigs: new Map([["test-tool", TOOL_CONFIG]]),
        logger: createMockLogger(),
      });

      const result = await emptyProvider.invoke("test-tool", "test-action", {});
      expect(result.success).toBe(true);
      expect(result.content).toBe("No data returned from MCP server");
    });

    it("retries on MCPServerError (connection failure)", async () => {
      let callCount = 0;
      const flakeyHandle: MCPServerHandle = {
        ...createMockHandle(),
        callTool: mock(async () => {
          callCount++;
          if (callCount === 1) throw new MCPServerError("Connection lost", "@test/mcp-server");
          return { content: [{ type: "text" as const, text: "retry success" }] };
        }),
      };
      const flakeyManager = {
        ...createMockServerManager(flakeyHandle),
        reconnect: mock(async () => flakeyHandle),
      } as any;

      const flakeyProvider = new MCPToolProvider({
        serverManager: flakeyManager,
        rateLimiter,
        serverConfigs: new Map([["@test/mcp-server", SERVER_CONFIG]]),
        toolConfigs: new Map([["test-tool", TOOL_CONFIG]]),
        logger: createMockLogger(),
      });

      const result = await flakeyProvider.invoke("test-tool", "test-action", {});
      expect(result.success).toBe(true);
      expect(result.content).toBe("retry success");
      expect(flakeyManager.reconnect).toHaveBeenCalled();
    });
  });

  describe("invoke — rate limit error", () => {
    it("returns error when rate limiter rejects", async () => {
      const rejectLimiter: RateLimiter = {
        acquire: mock(async () => { throw new Error("Rate limit exceeded"); }),
        tryAcquire: mock(() => false),
        configure: mock(() => {}),
        reset: mock(() => {}),
      };

      const rateLimitProvider = new MCPToolProvider({
        serverManager,
        rateLimiter: rejectLimiter,
        serverConfigs: new Map([["@test/mcp-server", SERVER_CONFIG]]),
        toolConfigs: new Map([["test-tool", TOOL_CONFIG]]),
        logger: createMockLogger(),
      });

      const result = await rateLimitProvider.invoke("test-tool", "test-action", {});
      expect(result.success).toBe(false);
      expect(result.content).toContain("Rate limit");
    });
  });
});
