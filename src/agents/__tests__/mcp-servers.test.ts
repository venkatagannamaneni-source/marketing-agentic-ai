/**
 * MCP Server integration tests.
 *
 * Spawns each MCP server as a subprocess and verifies:
 * 1. MCP initialize handshake works
 * 2. tools/list returns the expected tools
 * 3. tools/call returns proper error when credentials are missing
 *
 * These tests do NOT make real API calls — they verify the MCP protocol layer.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// ── Helpers ────────────────────────────────────────────────────────────────

interface JSONRPCResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class MCPTestClient {
  private proc: ChildProcess;
  private buffer = "";
  private requestId = 0;
  private pending = new Map<
    number,
    { resolve: (v: JSONRPCResponse) => void; reject: (e: Error) => void }
  >();

  constructor(serverPath: string) {
    const absPath = resolve(serverPath);
    this.proc = spawn("bun", ["run", absPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JSONRPCResponse;
          if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              p.resolve(msg);
            }
          }
        } catch {
          // ignore
        }
      }
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<JSONRPCResponse> {
    const id = ++this.requestId;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 5000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.proc.stdin?.write(request + "\n");
    });
  }

  async initialize(): Promise<JSONRPCResponse> {
    const res = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    // Send initialized notification
    this.proc.stdin?.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    return res;
  }

  close(): void {
    this.proc.kill("SIGTERM");
  }
}

// ── Server paths ───────────────────────────────────────────────────────────

const SERVERS = [
  {
    name: "ga4-server",
    path: ".agents/mcp-servers/ga4-server/index.ts",
    expectedTools: ["query-report", "get-realtime", "list-events", "get-conversion-events"],
  },
  {
    name: "search-console-server",
    path: ".agents/mcp-servers/search-console-server/index.ts",
    expectedTools: ["query-search-analytics", "get-index-coverage", "list-sitemaps", "inspect-url"],
  },
  {
    name: "gtm-server",
    path: ".agents/mcp-servers/gtm-server/index.ts",
    expectedTools: ["list-tags", "create-tag", "create-trigger", "publish-workspace"],
  },
  {
    name: "pagespeed-server",
    path: ".agents/mcp-servers/pagespeed-server/index.ts",
    expectedTools: ["run-audit", "get-core-web-vitals"],
  },
];

// ── Tests ──────────────────────────────────────────────────────────────────

const clients: MCPTestClient[] = [];

afterAll(() => {
  for (const c of clients) c.close();
});

for (const server of SERVERS) {
  describe(server.name, () => {
    let client: MCPTestClient;

    it("responds to MCP initialize", async () => {
      client = new MCPTestClient(server.path);
      clients.push(client);

      const res = await client.initialize();
      expect(res.result).toBeDefined();

      const result = res.result as {
        protocolVersion: string;
        serverInfo: { name: string };
      };
      expect(result.protocolVersion).toBe("2024-11-05");
      expect(result.serverInfo.name).toBe(server.name);
    });

    it("lists expected tools", async () => {
      const res = await client.send("tools/list");
      expect(res.result).toBeDefined();

      const result = res.result as {
        tools: Array<{ name: string; inputSchema: unknown }>;
      };
      const toolNames = result.tools.map((t) => t.name);

      for (const expected of server.expectedTools) {
        expect(toolNames).toContain(expected);
      }
      expect(result.tools.length).toBe(server.expectedTools.length);
    });

    it("returns error for unknown tool", async () => {
      const res = await client.send("tools/call", {
        name: "nonexistent-tool",
        arguments: {},
      });

      const result = res.result as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });

    it("returns error when credentials are missing", async () => {
      // Call a real tool — should fail because no TOOL_ACCESS_TOKEN/TOOL_API_KEY
      const firstTool = server.expectedTools[0];
      const res = await client.send("tools/call", {
        name: firstTool,
        arguments: server.name === "pagespeed-server"
          ? { url: "https://example.com" }
          : { property_id: "properties/12345", site_url: "https://example.com", start_date: "2024-01-01", end_date: "2024-01-31", metrics: ["sessions"], account_id: "123", container_id: "456" },
      });

      const result = res.result as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error:");
    });

    it("all tools have inputSchema", async () => {
      const res = await client.send("tools/list");
      const result = res.result as {
        tools: Array<{ name: string; inputSchema: { type: string; required?: string[] } }>;
      };

      for (const tool of result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });
}

// ── Export verification ──────────────────────────────────────────────────────

describe("MCP provider exports", () => {
  it("exports MCPToolProvider and errors from agents/index.ts", async () => {
    const mod = await import("../index.ts");
    expect(mod.MCPToolProvider).toBeDefined();
    expect(mod.MCPConnectionError).toBeDefined();
    expect(mod.MCPToolError).toBeDefined();
  });
});
