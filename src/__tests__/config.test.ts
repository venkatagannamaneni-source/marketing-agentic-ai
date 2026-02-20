import { describe, expect, it } from "bun:test";
import { loadConfig, ConfigError } from "../config.ts";

// Helper to build a valid base env set for all tests
function validEnv(
  overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: "sk-ant-test-key-123",
    ...overrides,
  };
}

describe("loadConfig", () => {
  // ── Required Field: ANTHROPIC_API_KEY ──────────────────────────────────

  it("throws ConfigError when ANTHROPIC_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).field).toBe("ANTHROPIC_API_KEY");
      expect((err as ConfigError).message).toContain("ANTHROPIC_API_KEY is required");
    }
  });

  it("throws ConfigError when ANTHROPIC_API_KEY is empty string", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "" })).toThrow(ConfigError);
  });

  it("throws ConfigError when ANTHROPIC_API_KEY is whitespace only", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "   " })).toThrow(ConfigError);
  });

  // ── Valid Configuration ────────────────────────────────────────────────

  it("returns correct RuntimeConfig with all env vars set", () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: "sk-ant-test",
      REDIS_HOST: "redis.example.com",
      REDIS_PORT: "6380",
      REDIS_PASSWORD: "secret",
      WORKSPACE_DIR: "/tmp/workspace",
      BUDGET_MONTHLY: "500",
      LOG_LEVEL: "debug",
      LOG_FORMAT: "json",
      MAX_PARALLEL_AGENTS: "5",
    });

    expect(config.anthropicApiKey).toBe("sk-ant-test");
    expect(config.redis.host).toBe("redis.example.com");
    expect(config.redis.port).toBe(6380);
    expect(config.redis.password).toBe("secret");
    expect(config.workspace.rootDir).toBe("/tmp/workspace");
    expect(config.budget.totalMonthly).toBe(500);
    expect(config.logging.level).toBe("debug");
    expect(config.logging.format).toBe("json");
    expect(config.maxParallelAgents).toBe(5);
  });

  // ── Defaults ───────────────────────────────────────────────────────────

  it("uses defaults when optional vars are missing", () => {
    const config = loadConfig(validEnv());

    expect(config.redis.host).toBe("localhost");
    expect(config.redis.port).toBe(6379);
    expect(config.redis.password).toBeUndefined();
    expect(config.budget.totalMonthly).toBe(1000);
    expect(config.logging.level).toBe("info");
    expect(config.logging.format).toBe("pretty");
    expect(config.maxParallelAgents).toBe(3);
  });

  it("resolves WORKSPACE_DIR to absolute path", () => {
    const config = loadConfig(validEnv({ WORKSPACE_DIR: "./my-workspace" }));
    expect(config.workspace.rootDir).toMatch(/^\//); // starts with /
    expect(config.workspace.rootDir).toContain("my-workspace");
  });

  // ── REDIS_PASSWORD ─────────────────────────────────────────────────────

  it("treats empty REDIS_PASSWORD as undefined", () => {
    const config = loadConfig(validEnv({ REDIS_PASSWORD: "" }));
    expect(config.redis.password).toBeUndefined();
  });

  it("passes through non-empty REDIS_PASSWORD", () => {
    const config = loadConfig(validEnv({ REDIS_PASSWORD: "pass123" }));
    expect(config.redis.password).toBe("pass123");
  });

  // ── Validation: REDIS_PORT ─────────────────────────────────────────────

  it("throws ConfigError for non-numeric REDIS_PORT", () => {
    expect(() => loadConfig(validEnv({ REDIS_PORT: "abc" }))).toThrow(
      ConfigError,
    );
    try {
      loadConfig(validEnv({ REDIS_PORT: "abc" }));
    } catch (err) {
      expect((err as ConfigError).field).toBe("REDIS_PORT");
    }
  });

  it("throws ConfigError for negative REDIS_PORT", () => {
    expect(() => loadConfig(validEnv({ REDIS_PORT: "-1" }))).toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError for zero REDIS_PORT", () => {
    expect(() => loadConfig(validEnv({ REDIS_PORT: "0" }))).toThrow(
      ConfigError,
    );
  });

  // ── Validation: BUDGET_MONTHLY ─────────────────────────────────────────

  it("throws ConfigError for negative BUDGET_MONTHLY", () => {
    expect(() => loadConfig(validEnv({ BUDGET_MONTHLY: "-100" }))).toThrow(
      ConfigError,
    );
    try {
      loadConfig(validEnv({ BUDGET_MONTHLY: "-100" }));
    } catch (err) {
      expect((err as ConfigError).field).toBe("BUDGET_MONTHLY");
    }
  });

  it("throws ConfigError for non-numeric BUDGET_MONTHLY", () => {
    expect(() =>
      loadConfig(validEnv({ BUDGET_MONTHLY: "not-a-number" })),
    ).toThrow(ConfigError);
  });

  // ── Validation: LOG_LEVEL ──────────────────────────────────────────────

  it("throws ConfigError for invalid LOG_LEVEL", () => {
    expect(() => loadConfig(validEnv({ LOG_LEVEL: "verbose" }))).toThrow(
      ConfigError,
    );
    try {
      loadConfig(validEnv({ LOG_LEVEL: "verbose" }));
    } catch (err) {
      expect((err as ConfigError).field).toBe("LOG_LEVEL");
    }
  });

  it("accepts all valid LOG_LEVEL values", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "silent"]) {
      const config = loadConfig(validEnv({ LOG_LEVEL: level }));
      expect(config.logging.level).toBe(level as typeof config.logging.level);
    }
  });

  // ── Validation: LOG_FORMAT ─────────────────────────────────────────────

  it("throws ConfigError for invalid LOG_FORMAT", () => {
    expect(() => loadConfig(validEnv({ LOG_FORMAT: "xml" }))).toThrow(
      ConfigError,
    );
    try {
      loadConfig(validEnv({ LOG_FORMAT: "xml" }));
    } catch (err) {
      expect((err as ConfigError).field).toBe("LOG_FORMAT");
    }
  });

  // ── Validation: MAX_PARALLEL_AGENTS ────────────────────────────────────

  it("throws ConfigError for zero MAX_PARALLEL_AGENTS", () => {
    expect(() =>
      loadConfig(validEnv({ MAX_PARALLEL_AGENTS: "0" })),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for negative MAX_PARALLEL_AGENTS", () => {
    expect(() =>
      loadConfig(validEnv({ MAX_PARALLEL_AGENTS: "-1" })),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for non-numeric MAX_PARALLEL_AGENTS", () => {
    expect(() =>
      loadConfig(validEnv({ MAX_PARALLEL_AGENTS: "abc" })),
    ).toThrow(ConfigError);
  });

  // ── envOverrides ───────────────────────────────────────────────────────

  it("envOverrides take precedence over process.env", () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: "override-key",
      REDIS_HOST: "override-host",
    });
    expect(config.anthropicApiKey).toBe("override-key");
    expect(config.redis.host).toBe("override-host");
  });

  // ── Frozen Config ──────────────────────────────────────────────────────

  it("returned config is frozen", () => {
    const config = loadConfig(validEnv());
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("deeply freezes nested config objects", () => {
    const config = loadConfig(validEnv());
    expect(Object.isFrozen(config.redis)).toBe(true);
    expect(Object.isFrozen(config.workspace)).toBe(true);
    expect(Object.isFrozen(config.budget)).toBe(true);
    expect(Object.isFrozen(config.logging)).toBe(true);
  });

  // ── Whitespace Trimming ──────────────────────────────────────────────────

  it("trims whitespace from REDIS_HOST", () => {
    const config = loadConfig(validEnv({ REDIS_HOST: "  myhost  " }));
    expect(config.redis.host).toBe("myhost");
  });

  it("falls back to default for whitespace-only REDIS_HOST", () => {
    const config = loadConfig(validEnv({ REDIS_HOST: "   " }));
    expect(config.redis.host).toBe("localhost");
  });

  it("trims whitespace from WORKSPACE_DIR", () => {
    const config = loadConfig(validEnv({ WORKSPACE_DIR: "  ./my-ws  " }));
    expect(config.workspace.rootDir).toContain("my-ws");
    expect(config.workspace.rootDir).not.toContain("  ");
  });

  it("trims whitespace from LOG_LEVEL", () => {
    const config = loadConfig(validEnv({ LOG_LEVEL: "  debug  " }));
    expect(config.logging.level).toBe("debug");
  });

  it("trims whitespace from LOG_FORMAT", () => {
    const config = loadConfig(validEnv({ LOG_FORMAT: "  json  " }));
    expect(config.logging.format).toBe("json");
  });

  // ── ConfigError ────────────────────────────────────────────────────────

  it("ConfigError has correct name and field properties", () => {
    const err = new ConfigError("test message", "TEST_FIELD");
    expect(err.name).toBe("ConfigError");
    expect(err.field).toBe("TEST_FIELD");
    expect(err.message).toBe("test message");
    expect(err).toBeInstanceOf(Error);
  });
});
