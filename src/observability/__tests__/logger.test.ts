import { describe, it, expect, beforeEach } from "bun:test";
import {
  createLogger,
  BufferLogger,
  DEFAULT_LOGGER_CONFIG,
  type Logger,
  type LogLevel,
  type LogEntry,
} from "../logger.ts";

// ── BufferLogger Tests ──────────────────────────────────────────────────────

describe("BufferLogger", () => {
  let logger: BufferLogger;

  beforeEach(() => {
    logger = new BufferLogger();
  });

  it("records entries at all log levels", () => {
    logger.trace("trace message");
    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");
    logger.fatal("fatal message");
    expect(logger.entries.length).toBe(6);
    const expectedLevels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
    for (let i = 0; i < expectedLevels.length; i++) {
      const level = expectedLevels[i]!;
      expect(logger.entries[i]!.level).toBe(level);
      expect(logger.entries[i]!.msg).toBe(`${level} message`);
    }
  });

  it("stores timestamp on each entry", () => {
    const before = new Date().toISOString();
    logger.info("test");
    const after = new Date().toISOString();
    const entry = logger.entries[0]!;
    expect(entry.timestamp >= before).toBe(true);
    expect(entry.timestamp <= after).toBe(true);
  });

  it("stores data payload on entries", () => {
    logger.info("with data", { foo: "bar", count: 42 });
    const entry = logger.entries[0]!;
    expect(entry.data).toEqual({ foo: "bar", count: 42 });
  });

  it("handles missing data parameter", () => {
    logger.info("no data");
    const entry = logger.entries[0]!;
    expect(entry.data).toBeUndefined();
  });

  it("handles undefined data parameter", () => {
    logger.info("undefined data", undefined);
    const entry = logger.entries[0]!;
    expect(entry.data).toBeUndefined();
  });

  describe("child()", () => {
    it("creates logger with merged bindings", () => {
      const child = logger.child({ module: "executor" });
      child.info("child message");
      const entry = logger.entries[0]!;
      expect(entry.data).toEqual({ module: "executor" });
    });

    it("entries include parent bindings", () => {
      const child = logger.child({ module: "executor" });
      child.info("test", { taskId: "task-1" });
      const entry = logger.entries[0]!;
      expect(entry.data).toEqual({ module: "executor", taskId: "task-1" });
    });

    it("child entries are visible from parent", () => {
      const child = logger.child({ module: "test" });
      child.info("from child");
      expect(logger.entries.length).toBe(1);
      expect(logger.entries[0]!.msg).toBe("from child");
    });

    it("parent entries are visible from child", () => {
      const child = logger.child({ module: "test" });
      logger.info("from parent");
      expect(child.entries.length).toBe(1);
    });

    it("child of child merges all ancestor bindings", () => {
      const child = logger.child({ module: "executor" });
      const grandchild = child.child({ taskId: "task-1" });
      grandchild.info("deep message", { extra: true });
      const entry = logger.entries[0]!;
      expect(entry.data).toEqual({
        module: "executor",
        taskId: "task-1",
        extra: true,
      });
    });

    it("empty bindings creates a valid child", () => {
      const child = logger.child({});
      child.info("test");
      expect(logger.entries.length).toBe(1);
      expect(logger.entries[0]!.msg).toBe("test");
      expect(logger.entries[0]!.data).toBeUndefined();
    });

    it("child data overrides parent binding with same key", () => {
      const child = logger.child({ module: "parent-mod" });
      child.info("test", { module: "overridden" });
      const entry = logger.entries[0]!;
      expect(entry.data).toEqual({ module: "overridden" });
    });
  });

  describe("clear()", () => {
    it("removes all entries", () => {
      logger.info("a");
      logger.info("b");
      logger.info("c");
      expect(logger.entries.length).toBe(3);
      logger.clear();
      expect(logger.entries.length).toBe(0);
    });

    it("clearing parent also clears child entries", () => {
      const child = logger.child({ module: "test" });
      child.info("from child");
      expect(logger.entries.length).toBe(1);
      logger.clear();
      expect(child.entries.length).toBe(0);
    });
  });

  describe("getByLevel()", () => {
    it("filters entries by level", () => {
      logger.info("info 1");
      logger.warn("warn 1");
      logger.info("info 2");
      logger.error("error 1");
      const infos = logger.getByLevel("info");
      expect(infos.length).toBe(2);
      expect(infos[0]!.msg).toBe("info 1");
      expect(infos[1]!.msg).toBe("info 2");
    });

    it("returns empty array when no matches", () => {
      logger.info("only info");
      expect(logger.getByLevel("error")).toEqual([]);
    });

    it("returns empty array on empty logger", () => {
      expect(logger.getByLevel("info")).toEqual([]);
    });
  });

  describe("has()", () => {
    it("checks for level and message substring", () => {
      logger.info("task completed successfully");
      expect(logger.has("info", "completed")).toBe(true);
    });

    it("returns false when level does not match", () => {
      logger.info("task completed");
      expect(logger.has("error", "completed")).toBe(false);
    });

    it("returns false when message does not match", () => {
      logger.info("task completed");
      expect(logger.has("info", "failed")).toBe(false);
    });

    it("returns false on empty logger", () => {
      expect(logger.has("info", "anything")).toBe(false);
    });

    it("matches exact messages", () => {
      logger.error("connection refused");
      expect(logger.has("error", "connection refused")).toBe(true);
    });
  });
});

// ── createLogger Tests ──────────────────────────────────────────────────────

describe("createLogger", () => {
  it("creates a logger with default config", () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("creates a logger with custom level", () => {
    const logger = createLogger({ level: "debug" });
    expect(logger).toBeDefined();
  });

  it("creates a logger with silent level", () => {
    const logger = createLogger({ level: "silent" });
    // Should not throw
    logger.info("this should be silent");
    logger.error("this too");
  });

  it("creates a logger with base bindings", () => {
    const logger = createLogger({ base: { service: "marketing-ai" } });
    expect(logger).toBeDefined();
  });

  it("creates a logger with empty base", () => {
    const logger = createLogger({ base: {} });
    expect(logger).toBeDefined();
  });

  it("merges partial config with defaults", () => {
    // Only providing level, format should default to "json"
    const logger = createLogger({ level: "warn" });
    expect(logger).toBeDefined();
  });

  it("implements Logger interface", () => {
    const logger: Logger = createLogger({ level: "silent" });
    expect(typeof logger.trace).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.fatal).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("child() returns a Logger", () => {
    const logger = createLogger({ level: "silent" });
    const child = logger.child({ module: "test" });
    expect(typeof child.info).toBe("function");
    expect(typeof child.child).toBe("function");
  });

  it("does not throw when logging with data", () => {
    const logger = createLogger({ level: "silent" });
    logger.info("test", { key: "value" });
    logger.error("err", { code: 500, nested: { a: 1 } });
  });

  it("does not throw when logging without data", () => {
    const logger = createLogger({ level: "silent" });
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");
  });
});

// ── DEFAULT_LOGGER_CONFIG Tests ─────────────────────────────────────────────

describe("DEFAULT_LOGGER_CONFIG", () => {
  it("has info as default level", () => {
    expect(DEFAULT_LOGGER_CONFIG.level).toBe("info");
  });

  it("has json as default format", () => {
    expect(DEFAULT_LOGGER_CONFIG.format).toBe("json");
  });

  it("has no base bindings by default", () => {
    expect(DEFAULT_LOGGER_CONFIG.base).toBeUndefined();
  });
});
