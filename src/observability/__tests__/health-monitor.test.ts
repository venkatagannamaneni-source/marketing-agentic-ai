import { describe, it, expect, beforeEach } from "bun:test";
import {
  HealthMonitor,
  DEFAULT_HEALTH_MONITOR_CONFIG,
  type HealthCheckFn,
} from "../health-monitor.ts";
import type { ComponentHealth } from "../../types/health.ts";
import type { BudgetState } from "../../director/types.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

function createHealthyCheck(name: string): HealthCheckFn {
  return () => ({
    name,
    status: "healthy" as const,
    lastCheckedAt: new Date().toISOString(),
    details: {},
  });
}

function createDegradedCheck(
  name: string,
  details?: Record<string, unknown>,
): HealthCheckFn {
  return () => ({
    name,
    status: "degraded" as const,
    lastCheckedAt: new Date().toISOString(),
    details: details ?? { warning: "high latency" },
  });
}

function createOfflineCheck(name: string): HealthCheckFn {
  return () => ({
    name,
    status: "offline" as const,
    lastCheckedAt: new Date().toISOString(),
    details: { error: "not reachable" },
  });
}

function createThrowingCheck(): HealthCheckFn {
  return () => {
    throw new Error("Connection refused");
  };
}

function createAsyncThrowingCheck(): HealthCheckFn {
  return () => Promise.reject(new Error("Async connection failed"));
}

function createSlowCheck(name: string, delayMs: number): HealthCheckFn {
  return () =>
    new Promise<ComponentHealth>((resolve) =>
      setTimeout(
        () =>
          resolve({
            name,
            status: "healthy" as const,
            lastCheckedAt: new Date().toISOString(),
            details: {},
          }),
        delayMs,
      ),
    );
}

function createTestBudgetState(
  level: "normal" | "warning" | "throttle" | "critical" | "exhausted",
): BudgetState {
  const configs: Record<string, BudgetState> = {
    normal: {
      totalBudget: 1000,
      spent: 100,
      percentUsed: 10,
      level: "normal",
      allowedPriorities: ["P0", "P1", "P2", "P3"],
      modelOverride: null,
    },
    warning: {
      totalBudget: 1000,
      spent: 800,
      percentUsed: 80,
      level: "warning",
      allowedPriorities: ["P0", "P1", "P2"],
      modelOverride: null,
    },
    throttle: {
      totalBudget: 1000,
      spent: 900,
      percentUsed: 90,
      level: "throttle",
      allowedPriorities: ["P0", "P1"],
      modelOverride: null,
    },
    critical: {
      totalBudget: 1000,
      spent: 950,
      percentUsed: 95,
      level: "critical",
      allowedPriorities: ["P0"],
      modelOverride: "haiku",
    },
    exhausted: {
      totalBudget: 1000,
      spent: 1000,
      percentUsed: 100,
      level: "exhausted",
      allowedPriorities: [],
      modelOverride: null,
    },
  };
  return configs[level]!;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("HealthMonitor", () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor();
  });

  // ── Registration ────────────────────────────────────────────────────────

  describe("registerComponent / unregisterComponent", () => {
    it("registers a health check", () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      expect(monitor.getRegisteredComponents()).toEqual(["redis"]);
    });

    it("registers multiple health checks", () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      monitor.registerComponent("queue", createHealthyCheck("queue"));
      const components = monitor.getRegisteredComponents();
      expect(components.length).toBe(2);
      expect(components).toContain("redis");
      expect(components).toContain("queue");
    });

    it("overwrites existing check with same name", () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      monitor.registerComponent("redis", createDegradedCheck("redis"));
      expect(monitor.getRegisteredComponents().length).toBe(1);
    });

    it("unregister returns true for existing component", () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      expect(monitor.unregisterComponent("redis")).toBe(true);
      expect(monitor.getRegisteredComponents().length).toBe(0);
    });

    it("unregister returns false for unknown component", () => {
      expect(monitor.unregisterComponent("nonexistent")).toBe(false);
    });

    it("getRegisteredComponents returns empty array initially", () => {
      expect(monitor.getRegisteredComponents()).toEqual([]);
    });
  });

  // ── checkHealth basics ──────────────────────────────────────────────────

  describe("checkHealth", () => {
    it("returns healthy with no registered components", async () => {
      const health = await monitor.checkHealth();
      expect(health.state).toBe("HEALTHY");
      expect(health.degradationLevel).toBe(0);
      expect(Object.keys(health.components)).toEqual([]);
    });

    it("returns healthy when all checks pass", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      monitor.registerComponent("queue", createHealthyCheck("queue"));
      monitor.registerComponent("worker", createHealthyCheck("worker"));

      const health = await monitor.checkHealth();
      expect(health.state).toBe("HEALTHY");
      expect(health.degradationLevel).toBe(0);
      expect(Object.keys(health.components).length).toBe(3);
      expect(health.components["redis"]!.status).toBe("healthy");
      expect(health.components["queue"]!.status).toBe("healthy");
      expect(health.components["worker"]!.status).toBe("healthy");
    });

    it("returns degraded when one component is degraded", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      monitor.registerComponent("queue", createDegradedCheck("queue"));

      const health = await monitor.checkHealth();
      expect(health.state).toBe("DEGRADED");
      expect(health.degradationLevel).toBe(1);
    });

    it("returns correct degradation level 1 for degraded components", async () => {
      monitor.registerComponent("redis", createDegradedCheck("redis"));
      monitor.registerComponent("queue", createDegradedCheck("queue"));

      const health = await monitor.checkHealth();
      expect(health.degradationLevel).toBe(1);
    });

    it("returns degradation level 2 for one offline component", async () => {
      monitor.registerComponent("redis", createOfflineCheck("redis"));
      monitor.registerComponent("queue", createHealthyCheck("queue"));

      const health = await monitor.checkHealth();
      expect(health.state).toBe("DEGRADED");
      expect(health.degradationLevel).toBe(2);
    });

    it("returns degradation level 3 for two offline components", async () => {
      monitor.registerComponent("redis", createOfflineCheck("redis"));
      monitor.registerComponent("queue", createOfflineCheck("queue"));
      monitor.registerComponent("worker", createHealthyCheck("worker"));

      const health = await monitor.checkHealth();
      expect(health.state).toBe("PAUSED");
      expect(health.degradationLevel).toBe(3);
    });

    it("returns degradation level 4 when all components offline", async () => {
      monitor.registerComponent("redis", createOfflineCheck("redis"));
      monitor.registerComponent("queue", createOfflineCheck("queue"));

      const health = await monitor.checkHealth();
      expect(health.state).toBe("OFFLINE");
      expect(health.degradationLevel).toBe(4);
    });

    it("handles health check that throws synchronously", async () => {
      monitor.registerComponent("redis", createThrowingCheck());

      const health = await monitor.checkHealth();
      expect(health.components["redis"]!.status).toBe("offline");
      expect(health.components["redis"]!.details).toEqual({
        error: "Connection refused",
      });
    });

    it("handles health check that returns rejected promise", async () => {
      monitor.registerComponent("redis", createAsyncThrowingCheck());

      const health = await monitor.checkHealth();
      expect(health.components["redis"]!.status).toBe("offline");
      expect(health.components["redis"]!.details).toEqual({
        error: "Async connection failed",
      });
    });

    it("marks throwing health check as offline component", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      monitor.registerComponent("queue", createThrowingCheck());

      const health = await monitor.checkHealth();
      expect(health.components["redis"]!.status).toBe("healthy");
      expect(health.components["queue"]!.status).toBe("offline");
    });

    it("handles health check timeout", async () => {
      monitor = new HealthMonitor({ healthCheckTimeoutMs: 50 });
      monitor.registerComponent("slow", createSlowCheck("slow", 500));

      const health = await monitor.checkHealth();
      expect(health.components["slow"]!.status).toBe("offline");
      expect(health.components["slow"]!.details).toEqual({
        error: "Health check timed out",
      });
    });

    it("uses default activeAgents=0 and queueDepth=0", async () => {
      const health = await monitor.checkHealth();
      expect(health.activeAgents).toBe(0);
      expect(health.queueDepth).toBe(0);
    });

    it("passes through activeAgents and queueDepth values", async () => {
      const health = await monitor.checkHealth(5, 42);
      expect(health.activeAgents).toBe(5);
      expect(health.queueDepth).toBe(42);
    });

    it("includes maxParallelAgents from config", async () => {
      monitor = new HealthMonitor({ maxParallelAgents: 10 });
      const health = await monitor.checkHealth();
      expect(health.maxParallelAgents).toBe(10);
    });
  });

  // ── Budget state adjustments ────────────────────────────────────────────

  describe("checkHealth with budgetState", () => {
    it("does not adjust degradation for normal budget", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      const health = await monitor.checkHealth(
        0,
        0,
        createTestBudgetState("normal"),
      );
      expect(health.degradationLevel).toBe(0);
      expect(health.state).toBe("HEALTHY");
    });

    it("does not adjust degradation for warning budget", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      const health = await monitor.checkHealth(
        0,
        0,
        createTestBudgetState("warning"),
      );
      expect(health.degradationLevel).toBe(0);
      expect(health.state).toBe("HEALTHY");
    });

    it("does not adjust degradation for throttle budget", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      const health = await monitor.checkHealth(
        0,
        0,
        createTestBudgetState("throttle"),
      );
      expect(health.degradationLevel).toBe(0);
      expect(health.state).toBe("HEALTHY");
    });

    it("bumps degradation to 2 for critical budget", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      const health = await monitor.checkHealth(
        0,
        0,
        createTestBudgetState("critical"),
      );
      expect(health.degradationLevel).toBe(2);
      expect(health.state).toBe("DEGRADED");
    });

    it("bumps degradation to 3 for exhausted budget", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      const health = await monitor.checkHealth(
        0,
        0,
        createTestBudgetState("exhausted"),
      );
      expect(health.degradationLevel).toBe(3);
      expect(health.state).toBe("PAUSED");
    });

    it("budget exhausted overrides healthy components to PAUSED", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      monitor.registerComponent("queue", createHealthyCheck("queue"));
      const health = await monitor.checkHealth(
        0,
        0,
        createTestBudgetState("exhausted"),
      );
      expect(health.state).toBe("PAUSED");
      // Components themselves are still healthy
      expect(health.components["redis"]!.status).toBe("healthy");
      expect(health.components["queue"]!.status).toBe("healthy");
    });

    it("does not lower degradation level from budget", async () => {
      // Two offline components → level 3 (PAUSED)
      // Critical budget only adjusts to max(current, 2) = 3 (no change)
      monitor.registerComponent("redis", createOfflineCheck("redis"));
      monitor.registerComponent("queue", createOfflineCheck("queue"));
      monitor.registerComponent("worker", createHealthyCheck("worker"));

      const health = await monitor.checkHealth(
        0,
        0,
        createTestBudgetState("critical"),
      );
      expect(health.degradationLevel).toBe(3);
    });

    it("combines offline component with exhausted budget", async () => {
      // 1 offline → level 2, exhausted budget bumps to max(2, 3) = 3
      monitor.registerComponent("redis", createOfflineCheck("redis"));
      monitor.registerComponent("queue", createHealthyCheck("queue"));

      const health = await monitor.checkHealth(
        0,
        0,
        createTestBudgetState("exhausted"),
      );
      expect(health.degradationLevel).toBe(3);
      expect(health.state).toBe("PAUSED");
    });
  });

  // ── SystemState derivation ──────────────────────────────────────────────

  describe("SystemState derivation", () => {
    it("maps degradation 0 to HEALTHY", async () => {
      monitor.registerComponent("redis", createHealthyCheck("redis"));
      const health = await monitor.checkHealth();
      expect(health.state).toBe("HEALTHY");
    });

    it("maps degradation 1 to DEGRADED", async () => {
      monitor.registerComponent("redis", createDegradedCheck("redis"));
      const health = await monitor.checkHealth();
      expect(health.degradationLevel).toBe(1);
      expect(health.state).toBe("DEGRADED");
    });

    it("maps degradation 2 to DEGRADED", async () => {
      monitor.registerComponent("redis", createOfflineCheck("redis"));
      monitor.registerComponent("queue", createHealthyCheck("queue"));
      const health = await monitor.checkHealth();
      expect(health.degradationLevel).toBe(2);
      expect(health.state).toBe("DEGRADED");
    });

    it("maps degradation 3 to PAUSED", async () => {
      monitor.registerComponent("redis", createOfflineCheck("redis"));
      monitor.registerComponent("queue", createOfflineCheck("queue"));
      monitor.registerComponent("worker", createHealthyCheck("worker"));
      const health = await monitor.checkHealth();
      expect(health.degradationLevel).toBe(3);
      expect(health.state).toBe("PAUSED");
    });

    it("maps degradation 4 to OFFLINE", async () => {
      monitor.registerComponent("redis", createOfflineCheck("redis"));
      const health = await monitor.checkHealth();
      expect(health.degradationLevel).toBe(4);
      expect(health.state).toBe("OFFLINE");
    });
  });

  // ── lastUpdatedAt ──────────────────────────────────────────────────────

  describe("lastUpdatedAt", () => {
    it("sets lastUpdatedAt to current ISO timestamp", async () => {
      const before = new Date().toISOString();
      const health = await monitor.checkHealth();
      const after = new Date().toISOString();
      expect(health.lastUpdatedAt >= before).toBe(true);
      expect(health.lastUpdatedAt <= after).toBe(true);
    });
  });

  // ── Concurrent health checks ──────────────────────────────────────────

  describe("concurrent health checks", () => {
    it("runs all health checks concurrently", async () => {
      const startTimes: number[] = [];
      const delayMs = 50;

      for (let i = 0; i < 3; i++) {
        const name = `component-${i}`;
        monitor.registerComponent(name, () => {
          startTimes.push(Date.now());
          return new Promise<ComponentHealth>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  name,
                  status: "healthy",
                  lastCheckedAt: new Date().toISOString(),
                  details: {},
                }),
              delayMs,
            ),
          );
        });
      }

      const before = Date.now();
      const health = await monitor.checkHealth();
      const elapsed = Date.now() - before;

      expect(Object.keys(health.components).length).toBe(3);
      // All 3 checks should run concurrently, total time ~50ms not 150ms
      // Use generous margin for CI environments
      expect(elapsed).toBeLessThan(delayMs * 2.5);
    });

    it("handles mix of fast and slow health checks", async () => {
      monitor = new HealthMonitor({ healthCheckTimeoutMs: 200 });
      monitor.registerComponent("fast", createHealthyCheck("fast"));
      monitor.registerComponent("slow", createSlowCheck("slow", 50));

      const health = await monitor.checkHealth();
      expect(health.components["fast"]!.status).toBe("healthy");
      expect(health.components["slow"]!.status).toBe("healthy");
    });

    it("times out slow checks independently", async () => {
      monitor = new HealthMonitor({ healthCheckTimeoutMs: 50 });
      monitor.registerComponent("fast", createHealthyCheck("fast"));
      monitor.registerComponent("slow", createSlowCheck("slow", 500));

      const health = await monitor.checkHealth();
      expect(health.components["fast"]!.status).toBe("healthy");
      expect(health.components["slow"]!.status).toBe("offline");
    });
  });

  // ── DEFAULT_HEALTH_MONITOR_CONFIG ─────────────────────────────────────

  describe("DEFAULT_HEALTH_MONITOR_CONFIG", () => {
    it("has expected default values", () => {
      expect(DEFAULT_HEALTH_MONITOR_CONFIG.maxParallelAgents).toBe(3);
      expect(DEFAULT_HEALTH_MONITOR_CONFIG.healthCheckTimeoutMs).toBe(5_000);
    });
  });
});
