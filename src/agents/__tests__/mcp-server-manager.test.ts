import { describe, expect, it, beforeEach, mock } from "bun:test";
import {
  MCPServerManager,
  MCPServerError,
  type MCPClientAdapter,
  type MCPServerConfig,
  type MCPClientFactory,
} from "../mcp-server-manager.ts";

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

// ── Mock MCP Client ─────────────────────────────────────────────────────────

function createMockClient(overrides?: Partial<MCPClientAdapter>): MCPClientAdapter {
  return {
    connect: mock(async () => {}),
    listTools: mock(async () => [
      { name: "test-tool", description: "Test", inputSchema: { type: "object" as const } },
    ]),
    callTool: mock(async () => ({
      content: [{ type: "text" as const, text: "mock result" }],
    })),
    close: mock(async () => {}),
    ...overrides,
  };
}

const TEST_CONFIG: MCPServerConfig = {
  packageName: "@test/mcp-server",
  command: "echo",
  args: ["test"],
  timeoutMs: 5_000,
};

describe("MCPServerManager", () => {
  let manager: MCPServerManager;
  let mockClient: MCPClientAdapter;
  let factory: MCPClientFactory;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockClient = createMockClient();
    factory = mock(() => mockClient);
    logger = createMockLogger();
    manager = new MCPServerManager({
      logger,
      clientFactory: factory,
      maxReconnectAttempts: 3,
    });
  });

  describe("ensureConnected", () => {
    it("starts a new server on first call", async () => {
      const handle = await manager.ensureConnected(TEST_CONFIG);
      expect(handle.packageName).toBe("@test/mcp-server");
      expect(handle.status).toBe("connected");
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("calls connect and listTools on new server", async () => {
      await manager.ensureConnected(TEST_CONFIG);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.listTools).toHaveBeenCalledTimes(1);
    });

    it("reuses existing connected server", async () => {
      await manager.ensureConnected(TEST_CONFIG);
      await manager.ensureConnected(TEST_CONFIG);
      expect(factory).toHaveBeenCalledTimes(1); // Only created once
    });

    it("different servers get separate clients", async () => {
      const config2: MCPServerConfig = { ...TEST_CONFIG, packageName: "@test/other" };
      await manager.ensureConnected(TEST_CONFIG);
      await manager.ensureConnected(config2);
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it("throws MCPServerError on connect failure", async () => {
      const failClient = createMockClient({
        connect: mock(async () => { throw new Error("Connection refused"); }),
      });
      const failFactory = mock(() => failClient);
      const failManager = new MCPServerManager({
        logger,
        clientFactory: failFactory,
      });

      try {
        await failManager.ensureConnected(TEST_CONFIG);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(MCPServerError);
        expect((err as MCPServerError).packageName).toBe("@test/mcp-server");
      }
    });

    it("deduplicates concurrent connection attempts", async () => {
      const [handle1, handle2] = await Promise.all([
        manager.ensureConnected(TEST_CONFIG),
        manager.ensureConnected(TEST_CONFIG),
      ]);
      expect(handle1.packageName).toBe(handle2.packageName);
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  describe("callTool via handle", () => {
    it("delegates callTool to the MCP client", async () => {
      const handle = await manager.ensureConnected(TEST_CONFIG);
      const result = await handle.callTool("test-action", { key: "value" });
      expect(result.content[0]).toEqual({ type: "text", text: "mock result" });
    });
  });

  describe("healthCheck", () => {
    it("returns empty map when no servers", () => {
      const health = manager.healthCheck();
      expect(health.size).toBe(0);
    });

    it("returns status of managed servers", async () => {
      await manager.ensureConnected(TEST_CONFIG);
      const health = manager.healthCheck();
      expect(health.size).toBe(1);
      const serverHealth = health.get("@test/mcp-server")!;
      expect(serverHealth.status).toBe("connected");
      expect(serverHealth.reconnectCount).toBe(0);
    });
  });

  describe("stopServer", () => {
    it("closes the client and removes the server", async () => {
      await manager.ensureConnected(TEST_CONFIG);
      await manager.stopServer("@test/mcp-server");
      expect(mockClient.close).toHaveBeenCalledTimes(1);
      expect(manager.healthCheck().size).toBe(0);
    });

    it("does not throw for unknown server", async () => {
      await manager.stopServer("nonexistent");
    });
  });

  describe("stopAll", () => {
    it("stops all managed servers", async () => {
      const config2: MCPServerConfig = { ...TEST_CONFIG, packageName: "@test/other" };
      const client2 = createMockClient();
      let callCount = 0;
      const multiFactory = mock(() => {
        callCount++;
        return callCount === 1 ? mockClient : client2;
      });

      const multiManager = new MCPServerManager({
        logger,
        clientFactory: multiFactory,
      });
      await multiManager.ensureConnected(TEST_CONFIG);
      await multiManager.ensureConnected(config2);
      await multiManager.stopAll();
      expect(mockClient.close).toHaveBeenCalled();
      expect(client2.close).toHaveBeenCalled();
      expect(multiManager.healthCheck().size).toBe(0);
    });
  });

  describe("reconnect", () => {
    it("closes old connection and starts new one", async () => {
      await manager.ensureConnected(TEST_CONFIG);
      const newClient = createMockClient();
      let callCount = 0;
      const reconnectFactory = mock(() => {
        callCount++;
        return callCount <= 1 ? mockClient : newClient;
      });
      const reconnectManager = new MCPServerManager({
        logger,
        clientFactory: reconnectFactory,
      });
      await reconnectManager.ensureConnected(TEST_CONFIG);
      await reconnectManager.reconnect(TEST_CONFIG);
      expect(mockClient.close).toHaveBeenCalled();
    });

    it("throws after max reconnect attempts", async () => {
      // Create a manager with maxReconnectAttempts: 1
      const limitedManager = new MCPServerManager({
        logger,
        clientFactory: factory,
        maxReconnectAttempts: 1,
      });
      await limitedManager.ensureConnected(TEST_CONFIG);
      await limitedManager.reconnect(TEST_CONFIG);

      try {
        await limitedManager.reconnect(TEST_CONFIG);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(MCPServerError);
        expect((err as Error).message).toContain("exceeded max reconnect");
      }
    });
  });
});
