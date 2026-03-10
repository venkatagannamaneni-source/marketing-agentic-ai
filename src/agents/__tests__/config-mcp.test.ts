import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { loadConfig, ConfigError } from "../../config.ts";

describe("loadConfig — MCP settings", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("provides MCP defaults", () => {
    const config = loadConfig();
    expect(config.mcp.serverTimeoutMs).toBe(30_000);
    expect(config.mcp.invocationTimeoutMs).toBe(60_000);
    expect(config.mcp.maxReconnectAttempts).toBe(3);
  });

  it("reads MCP_SERVER_TIMEOUT_MS from env", () => {
    const config = loadConfig({ MCP_SERVER_TIMEOUT_MS: "15000", ANTHROPIC_API_KEY: "sk-test" });
    expect(config.mcp.serverTimeoutMs).toBe(15_000);
  });

  it("reads MCP_INVOCATION_TIMEOUT_MS from env", () => {
    const config = loadConfig({ MCP_INVOCATION_TIMEOUT_MS: "120000", ANTHROPIC_API_KEY: "sk-test" });
    expect(config.mcp.invocationTimeoutMs).toBe(120_000);
  });

  it("reads MCP_MAX_RECONNECT_ATTEMPTS from env", () => {
    const config = loadConfig({ MCP_MAX_RECONNECT_ATTEMPTS: "5", ANTHROPIC_API_KEY: "sk-test" });
    expect(config.mcp.maxReconnectAttempts).toBe(5);
  });

  it("rejects MCP_SERVER_TIMEOUT_MS < 1000", () => {
    expect(() =>
      loadConfig({ MCP_SERVER_TIMEOUT_MS: "500", ANTHROPIC_API_KEY: "sk-test" }),
    ).toThrow(ConfigError);
  });

  it("rejects invalid MCP_INVOCATION_TIMEOUT_MS", () => {
    expect(() =>
      loadConfig({ MCP_INVOCATION_TIMEOUT_MS: "abc", ANTHROPIC_API_KEY: "sk-test" }),
    ).toThrow(ConfigError);
  });

  it("allows MCP_MAX_RECONNECT_ATTEMPTS = 0", () => {
    const config = loadConfig({ MCP_MAX_RECONNECT_ATTEMPTS: "0", ANTHROPIC_API_KEY: "sk-test" });
    expect(config.mcp.maxReconnectAttempts).toBe(0);
  });

  it("rejects negative MCP_MAX_RECONNECT_ATTEMPTS", () => {
    expect(() =>
      loadConfig({ MCP_MAX_RECONNECT_ATTEMPTS: "-1", ANTHROPIC_API_KEY: "sk-test" }),
    ).toThrow(ConfigError);
  });

  it("MCP config is frozen", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(Object.isFrozen(config.mcp)).toBe(true);
  });
});
