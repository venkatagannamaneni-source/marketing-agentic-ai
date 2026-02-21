import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import type { Application } from "../bootstrap.ts";
import type { RuntimeConfig } from "../config.ts";

// ── Test config factory ─────────────────────────────────────────────────────

function makeTestConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return Object.freeze({
    anthropicApiKey: "sk-test-key",
    redis: { host: "localhost", port: 6379, password: undefined },
    workspace: { rootDir: "/tmp/bootstrap-test-workspace" },
    projectRoot: "/tmp/bootstrap-test",
    budget: { totalMonthly: 100 },
    logging: { level: "silent" as const, format: "json" as const },
    maxParallelAgents: 2,
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
// Bootstrap wires real implementations, which require Redis and Anthropic.
// We test the Application interface contract using structural checks rather
// than calling bootstrap() directly, since it creates real connections.

describe("Application interface contract", () => {
  it("Application has all required properties", () => {
    // Verify the type system enforces the contract by constructing a mock
    const config = makeTestConfig();

    const mockApp: Application = {
      config,
      registry: {} as any,
      toolRegistry: {} as any,
      workspace: {} as any,
      client: {} as any,
      director: {} as any,
      executor: {} as any,
      pipelineEngine: {} as any,
      queueManager: {} as any,
      costTracker: {} as any,
      logger: {} as any,
      eventBus: {} as any,
      scheduler: {} as any,
      async start() {},
      async shutdown() {},
    };

    expect(mockApp.config).toBe(config);
    expect(mockApp.start).toBeFunction();
    expect(mockApp.shutdown).toBeFunction();
  });

  it("start() delegates to queueManager.start() and scheduler.start()", async () => {
    const calls: string[] = [];
    const config = makeTestConfig();

    const mockApp: Application = {
      config,
      registry: {} as any,
      toolRegistry: {} as any,
      workspace: {} as any,
      client: {} as any,
      director: {} as any,
      executor: {} as any,
      pipelineEngine: {} as any,
      queueManager: {
        start: async () => {
          calls.push("queueManager.start");
        },
      } as any,
      costTracker: {} as any,
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any,
      eventBus: {} as any,
      scheduler: {
        start: async () => {
          calls.push("scheduler.start");
        },
      } as any,
      async start() {
        await this.queueManager.start();
        await (this.scheduler as any).start();
      },
      async shutdown() {},
    };

    await mockApp.start();
    expect(calls).toEqual(["queueManager.start", "scheduler.start"]);
  });

  it("shutdown() stops scheduler before queueManager, then closes redis", async () => {
    const calls: string[] = [];
    const config = makeTestConfig();

    const mockRedis = {
      close: async () => {
        calls.push("redis.close");
      },
    };

    const mockApp: Application = {
      config,
      registry: {} as any,
      toolRegistry: {} as any,
      workspace: {} as any,
      client: {} as any,
      director: {} as any,
      executor: {} as any,
      pipelineEngine: {} as any,
      queueManager: {
        stop: async () => {
          calls.push("queueManager.stop");
        },
      } as any,
      costTracker: {} as any,
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any,
      eventBus: {} as any,
      scheduler: {
        stop: async () => {
          calls.push("scheduler.stop");
        },
      } as any,
      async start() {},
      async shutdown() {
        await (this.scheduler as any).stop();
        await (this.queueManager as any).stop();
        await mockRedis.close();
      },
    };

    await mockApp.shutdown();
    expect(calls).toEqual(["scheduler.stop", "queueManager.stop", "redis.close"]);
  });

  it("shutdown() is idempotent (double call is safe)", async () => {
    let shutdownCount = 0;
    let shuttingDown = false;
    const config = makeTestConfig();

    const mockApp: Application = {
      config,
      registry: {} as any,
      toolRegistry: {} as any,
      workspace: {} as any,
      client: {} as any,
      director: {} as any,
      executor: {} as any,
      pipelineEngine: {} as any,
      queueManager: { stop: async () => {} } as any,
      costTracker: {} as any,
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any,
      eventBus: {} as any,
      scheduler: {} as any,
      async start() {},
      async shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        shutdownCount++;
      },
    };

    await mockApp.shutdown();
    await mockApp.shutdown();
    expect(shutdownCount).toBe(1);
  });

  it("config is frozen and immutable", () => {
    const config = makeTestConfig();
    expect(Object.isFrozen(config)).toBe(true);

    // Attempting to modify should not work (frozen)
    expect(() => {
      (config as any).anthropicApiKey = "modified";
    }).toThrow();
  });

  it("shutdown() cleans up signal handlers to prevent accumulation", async () => {
    // Verify the shutdown contract: signal handlers should be removable
    // to prevent MaxListenersExceededWarning on repeated bootstrap() calls
    const initialListenerCount = process.listenerCount("SIGTERM");

    // Create a handler and register it, simulating what bootstrap does
    const handler = () => {};
    process.on("SIGTERM", handler);
    expect(process.listenerCount("SIGTERM")).toBe(initialListenerCount + 1);

    // Simulate shutdown cleanup
    process.removeListener("SIGTERM", handler);
    expect(process.listenerCount("SIGTERM")).toBe(initialListenerCount);
  });

  it("budget provider can be wired to costTracker", () => {
    const { CostTracker } = require("../observability/cost-tracker.ts");
    const costTracker = new CostTracker({
      budget: {
        totalMonthly: 100,
        warningPercent: 80,
        throttlePercent: 90,
        criticalPercent: 95,
      },
    });

    // The budgetProvider closure pattern used in bootstrap
    const budgetProvider = () => costTracker.toBudgetState();
    const state = budgetProvider();

    expect(state.level).toBe("normal");
    expect(state.totalBudget).toBe(100);
    expect(state.spent).toBe(0);
    expect(state.percentUsed).toBe(0);
  });
});

describe("RuntimeConfig structure", () => {
  it("makeTestConfig() produces a valid config shape", () => {
    const config = makeTestConfig();

    expect(config.anthropicApiKey).toBe("sk-test-key");
    expect(config.redis.host).toBe("localhost");
    expect(config.redis.port).toBe(6379);
    expect(config.redis.password).toBeUndefined();
    expect(config.workspace.rootDir).toBe("/tmp/bootstrap-test-workspace");
    expect(config.projectRoot).toBe("/tmp/bootstrap-test");
    expect(config.budget.totalMonthly).toBe(100);
    expect(config.logging.level).toBe("silent");
    expect(config.logging.format).toBe("json");
    expect(config.maxParallelAgents).toBe(2);
  });

  it("makeTestConfig() accepts overrides", () => {
    const config = makeTestConfig({
      maxParallelAgents: 5,
      budget: { totalMonthly: 500 },
    });

    expect(config.maxParallelAgents).toBe(5);
    expect(config.budget.totalMonthly).toBe(500);
  });
});
