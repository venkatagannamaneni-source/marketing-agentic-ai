import { describe, expect, it, mock } from "bun:test";
import {
  ToolRegistry,
  type ToolProvider,
  type ToolInvocationResult,
  type ToolRegistryData,
} from "../tool-registry.ts";

// ── Mock Provider ───────────────────────────────────────────────────────────

function createMockProvider(tag: string): ToolProvider {
  return {
    invoke: mock(async (toolName, actionName, params): Promise<ToolInvocationResult> => ({
      toolName,
      actionName,
      success: true,
      content: `${tag}:${toolName}/${actionName}`,
      durationMs: 1,
      isStub: tag === "stub",
    })),
  };
}

// ── Test Data ───────────────────────────────────────────────────────────────

const REGISTRY_DATA: ToolRegistryData = {
  tools: {
    "mcp-tool": {
      description: "MCP Tool",
      provider: "mcp",
      mcp_server: "@test/mcp-server",
      skills: ["test-skill"],
      actions: [
        { name: "query", description: "Query data", parameters: { type: "object" } },
      ],
    },
    "rest-tool": {
      description: "REST Tool",
      provider: "rest",
      skills: ["test-skill"],
      actions: [
        { name: "create", description: "Create resource", parameters: { type: "object" } },
      ],
    },
    "stub-tool": {
      description: "Stub Tool",
      provider: "stub",
      skills: ["test-skill"],
      actions: [
        { name: "test", description: "Test", parameters: { type: "object" } },
      ],
    },
  },
};

describe("ToolRegistry — Provider Routing", () => {
  it("routes mcp tools to MCPToolProvider", async () => {
    const registry = ToolRegistry.fromData(REGISTRY_DATA);
    const mcpProvider = createMockProvider("mcp");
    registry.setProvider("mcp", mcpProvider);

    const result = await registry.invokeTool("mcp-tool__query", { key: "val" });
    expect(result.content).toBe("mcp:mcp-tool/query");
    expect(mcpProvider.invoke).toHaveBeenCalledTimes(1);
  });

  it("routes rest tools to RESTToolProvider", async () => {
    const registry = ToolRegistry.fromData(REGISTRY_DATA);
    const restProvider = createMockProvider("rest");
    registry.setProvider("rest", restProvider);

    const result = await registry.invokeTool("rest-tool__create", { title: "Test" });
    expect(result.content).toBe("rest:rest-tool/create");
    expect(restProvider.invoke).toHaveBeenCalledTimes(1);
  });

  it("falls back to StubToolProvider for stub tools", async () => {
    const registry = ToolRegistry.fromData(REGISTRY_DATA);
    // No setProvider("stub", ...) — should use default StubToolProvider

    const result = await registry.invokeTool("stub-tool__test", {});
    expect(result.isStub).toBe(true);
    expect(result.success).toBe(true);
  });

  it("falls back to stub when provider type not registered", async () => {
    const registry = ToolRegistry.fromData(REGISTRY_DATA);
    // Don't register mcp provider — should fall back to stub

    const result = await registry.invokeTool("mcp-tool__query", {});
    expect(result.isStub).toBe(true);
  });

  it("explicit provider arg takes precedence over providerMap", async () => {
    const registry = ToolRegistry.fromData(REGISTRY_DATA);
    const mcpProvider = createMockProvider("mcp");
    const overrideProvider = createMockProvider("override");
    registry.setProvider("mcp", mcpProvider);

    const result = await registry.invokeTool("mcp-tool__query", {}, overrideProvider);
    expect(result.content).toBe("override:mcp-tool/query");
    expect(mcpProvider.invoke).not.toHaveBeenCalled();
  });

  it("setProvider overwrites previous provider for same type", async () => {
    const registry = ToolRegistry.fromData(REGISTRY_DATA);
    const provider1 = createMockProvider("v1");
    const provider2 = createMockProvider("v2");
    registry.setProvider("mcp", provider1);
    registry.setProvider("mcp", provider2);

    const result = await registry.invokeTool("mcp-tool__query", {});
    expect(result.content).toBe("v2:mcp-tool/query");
  });

  it("getProvider returns registered provider", () => {
    const registry = ToolRegistry.fromData(REGISTRY_DATA);
    const mcpProvider = createMockProvider("mcp");
    registry.setProvider("mcp", mcpProvider);

    expect(registry.getProvider("mcp")).toBe(mcpProvider);
    expect(registry.getProvider("rest")).toBeUndefined();
  });
});

describe("ToolRegistry — tools.yaml with new fields", () => {
  it("accepts mcp_server_config field", () => {
    const data: ToolRegistryData = {
      tools: {
        ga4: {
          description: "GA4",
          provider: "mcp",
          mcp_server: "@test/ga4",
          mcp_server_config: {
            command: "node",
            args: ["./server.js"],
            transport: "stdio",
          },
          skills: ["analytics"],
          actions: [
            { name: "query", description: "Query", parameters: { type: "object" } },
          ],
        },
      },
    };
    const registry = ToolRegistry.fromData(data);
    const config = registry.getToolConfig("ga4");
    expect(config?.mcp_server_config?.command).toBe("node");
    expect(config?.mcp_server_config?.transport).toBe("stdio");
  });

  it("accepts playwright provider type", () => {
    const data: ToolRegistryData = {
      tools: {
        browser: {
          description: "Browser",
          provider: "playwright",
          skills: ["page-cro"],
          actions: [
            { name: "screenshot", description: "Screenshot", parameters: { type: "object" } },
          ],
        },
      },
    };
    const registry = ToolRegistry.fromData(data);
    expect(registry.getToolConfig("browser")?.provider).toBe("playwright");
  });
});
