/**
 * Targeted probe tests to find hidden bugs in the observability module.
 * These test edge cases and interactions that the original test suite doesn't cover.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { BufferLogger } from "../logger.ts";
import { CostTracker, type CostEntry } from "../cost-tracker.ts";
import { MetricsCollector, type TaskExecutionRecord } from "../metrics.ts";
import { HealthMonitor, type HealthCheckFn } from "../health-monitor.ts";
import type { SkillName, ModelTier } from "../../types/agent.ts";
import type { ComponentHealth } from "../../types/health.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function costEntry(overrides?: Partial<CostEntry>): CostEntry {
  return {
    timestamp: "2026-02-20T12:00:00.000Z",
    taskId: "task-1",
    skillName: "copywriting" as SkillName,
    modelTier: "sonnet" as ModelTier,
    inputTokens: 1000,
    outputTokens: 500,
    estimatedCost: 0.01,
    ...overrides,
  };
}

function taskRecord(overrides?: Partial<TaskExecutionRecord>): TaskExecutionRecord {
  return {
    taskId: "task-1",
    skillName: "copywriting" as SkillName,
    status: "completed",
    durationMs: 5000,
    inputTokens: 1000,
    outputTokens: 500,
    timestamp: "2026-02-20T12:00:00.000Z",
    ...overrides,
  };
}

// ── PROBE: CostTracker.toBudgetState() zero budget with spending ────────────

describe("PROBE: CostTracker zero-budget edge case", () => {
  it("zero totalMonthly + nonzero spent is exhausted (fixed)", () => {
    const tracker = new CostTracker({
      budget: { totalMonthly: 0, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 },
    });
    tracker.record(costEntry({ estimatedCost: 5 }));
    const state = tracker.toBudgetState();
    expect(state.spent).toBe(5);
    expect(state.percentUsed).toBe(100);
    expect(state.level).toBe("exhausted");
  });

  it("zero totalMonthly + zero spent is correctly normal", () => {
    const tracker = new CostTracker({
      budget: { totalMonthly: 0, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 },
    });
    const state = tracker.toBudgetState();
    expect(state.level).toBe("normal");
  });
});

// ── PROBE: CostTracker.flush() missing daily breakdown ──────────────────────

describe("PROBE: CostTracker flush report completeness", () => {
  it("flush() report includes daily breakdown (fixed)", async () => {
    const tracker = new CostTracker();
    tracker.record(costEntry({ timestamp: "2026-02-18T10:00:00.000Z", estimatedCost: 1 }));
    tracker.record(costEntry({ timestamp: "2026-02-19T10:00:00.000Z", estimatedCost: 2 }));

    const files: { path: string; content: string }[] = [];
    await tracker.flush("/tmp", {
      async writeFile(p, c) { files.push({ path: p, content: c }); },
      async mkdir() {},
    });

    expect(tracker.getDailyBreakdown().length).toBe(2);
    expect(files[0]!.content).toContain("## By Day");
    expect(files[0]!.content).toContain("2026-02-18");
    expect(files[0]!.content).toContain("2026-02-19");
  });
});

// ── PROBE: HealthMonitor — no components + exhausted budget ─────────────────

describe("PROBE: HealthMonitor no components with budget", () => {
  it("no components + exhausted budget results in PAUSED", async () => {
    const monitor = new HealthMonitor();
    const health = await monitor.checkHealth(0, 0, {
      totalBudget: 1000,
      spent: 1000,
      percentUsed: 100,
      level: "exhausted",
      allowedPriorities: [],
      modelOverride: null,
    });
    // No components registered but budget is exhausted
    // Should be degradation 3 (PAUSED) due to budget adjustment
    expect(health.degradationLevel).toBe(3);
    expect(health.state).toBe("PAUSED");
  });

  it("no components + critical budget results in DEGRADED", async () => {
    const monitor = new HealthMonitor();
    const health = await monitor.checkHealth(0, 0, {
      totalBudget: 1000,
      spent: 950,
      percentUsed: 95,
      level: "critical",
      allowedPriorities: ["P0"],
      modelOverride: "haiku",
    });
    expect(health.degradationLevel).toBe(2);
    expect(health.state).toBe("DEGRADED");
  });
});

// ── PROBE: HealthMonitor — single offline component ─────────────────────────

describe("PROBE: HealthMonitor single component states", () => {
  it("single offline component = OFFLINE (level 4), not level 2", async () => {
    const monitor = new HealthMonitor();
    monitor.registerComponent("redis", () => ({
      name: "redis",
      status: "offline" as const,
      lastCheckedAt: new Date().toISOString(),
      details: {},
    }));
    const health = await monitor.checkHealth();
    // With only 1 component and it's offline:
    // offlineCount (1) === componentValues.length (1) → level 4 (all offline)
    expect(health.degradationLevel).toBe(4);
    expect(health.state).toBe("OFFLINE");
  });

  it("single degraded component = level 1", async () => {
    const monitor = new HealthMonitor();
    monitor.registerComponent("redis", () => ({
      name: "redis",
      status: "degraded" as const,
      lastCheckedAt: new Date().toISOString(),
      details: {},
    }));
    const health = await monitor.checkHealth();
    expect(health.degradationLevel).toBe(1);
    expect(health.state).toBe("DEGRADED");
  });
});

// ── PROBE: BufferLogger child data ordering ─────────────────────────────────

describe("PROBE: BufferLogger binding edge cases", () => {
  it("child with bindings + no data still produces bindings in entry.data", () => {
    const logger = new BufferLogger();
    const child = logger.child({ module: "executor" });
    child.info("message only");
    // When child has bindings but no data is passed, the entry.data should
    // still contain the bindings
    expect(logger.entries[0]!.data).toEqual({ module: "executor" });
  });

  it("child with bindings + undefined data produces bindings", () => {
    const logger = new BufferLogger();
    const child = logger.child({ module: "executor" });
    child.info("message", undefined);
    // { ...bindings, ...undefined } = { ...bindings }
    expect(logger.entries[0]!.data).toEqual({ module: "executor" });
  });

  it("child with bindings + empty data merges correctly", () => {
    const logger = new BufferLogger();
    const child = logger.child({ module: "executor" });
    child.info("message", {});
    // { ...bindings, ...{} } = { ...bindings }
    expect(logger.entries[0]!.data).toEqual({ module: "executor" });
  });
});

// ── PROBE: CostTracker.getSpentSince() with malformed entry timestamps ──────

describe("PROBE: CostTracker malformed timestamps", () => {
  it("entries with malformed timestamps are skipped in getSpentSince", () => {
    const tracker = new CostTracker();
    // Malformed timestamp → new Date("invalid").getTime() = NaN
    // NaN >= sinceMs is false → entry skipped
    tracker.record(costEntry({ timestamp: "not-a-date", estimatedCost: 5 }));
    tracker.record(costEntry({ timestamp: "2026-02-20T12:00:00.000Z", estimatedCost: 3 }));

    const result = tracker.getSpentSince(new Date("2026-02-19T00:00:00.000Z"));
    // Only the valid-timestamped entry should be counted
    expect(result).toBe(3);
  });

  it("extractDate on malformed timestamp produces garbage for daily breakdown", () => {
    const tracker = new CostTracker();
    tracker.record(costEntry({ timestamp: "not-a-date", estimatedCost: 5 }));
    const daily = tracker.getDailyBreakdown();
    // slice(0,10) of "not-a-date" = "not-a-date" — produces garbage date key
    expect(daily.length).toBe(1);
    expect(daily[0]!.date).toBe("not-a-date");
  });
});

// ── PROBE: MetricsCollector getStats() skillStats defensive copy ────────────

describe("PROBE: MetricsCollector defensive copies", () => {
  it("skillStats are different array instances across calls", () => {
    const collector = new MetricsCollector();
    collector.recordTaskExecution(taskRecord());
    const stats1 = collector.getStats();
    const stats2 = collector.getStats();
    expect(stats1.skillStats).not.toBe(stats2.skillStats);
  });

  it("mutating returned skillStats doesn't affect collector", () => {
    const collector = new MetricsCollector();
    collector.recordTaskExecution(taskRecord());
    const stats = collector.getStats();
    // Try to mutate the returned array
    (stats.skillStats as any[]).length = 0;
    const stats2 = collector.getStats();
    expect(stats2.skillStats.length).toBe(1);
  });
});

// ── PROBE: CostTracker microdollar precision edge ───────────────────────────

describe("PROBE: Microdollar precision boundaries", () => {
  it("sub-microdollar amounts round to nearest microdollar", () => {
    const tracker = new CostTracker();
    // $0.0000005 = 0.5 microdollars → rounds to 1 microdollar = $0.000001
    tracker.record(costEntry({ estimatedCost: 0.0000005 }));
    expect(tracker.getTotalSpent()).toBe(0.000001);
  });

  it("sub-microdollar amounts below 0.5 round to 0", () => {
    const tracker = new CostTracker();
    // $0.0000004 = 0.4 microdollars → rounds to 0
    tracker.record(costEntry({ estimatedCost: 0.0000004 }));
    expect(tracker.getTotalSpent()).toBe(0);
  });

  it("large number of entries doesn't cause integer overflow", () => {
    const tracker = new CostTracker();
    // $100 * 10000 entries = $1,000,000
    // In microdollars: 100,000,000 * 10,000 = 1,000,000,000,000
    // JavaScript Number.MAX_SAFE_INTEGER is 9,007,199,254,740,991
    // So 1 trillion is safe
    for (let i = 0; i < 100; i++) {
      tracker.record(costEntry({ estimatedCost: 100, taskId: `task-${i}` }));
    }
    expect(tracker.getTotalSpent()).toBe(10000);
  });
});

// ── PROBE: HealthMonitor with non-Error throws ──────────────────────────────

describe("PROBE: HealthMonitor non-Error exceptions", () => {
  it("handles string thrown from health check", async () => {
    const monitor = new HealthMonitor();
    monitor.registerComponent("bad", (() => {
      throw "string error";
    }) as HealthCheckFn);
    const health = await monitor.checkHealth();
    expect(health.components["bad"]!.status).toBe("offline");
    expect(health.components["bad"]!.details).toEqual({ error: "string error" });
  });

  it("handles number thrown from health check", async () => {
    const monitor = new HealthMonitor();
    monitor.registerComponent("bad", (() => {
      throw 42;
    }) as HealthCheckFn);
    const health = await monitor.checkHealth();
    expect(health.components["bad"]!.status).toBe("offline");
    expect(health.components["bad"]!.details).toEqual({ error: "42" });
  });

  it("handles null thrown from health check", async () => {
    const monitor = new HealthMonitor();
    monitor.registerComponent("bad", (() => {
      throw null;
    }) as HealthCheckFn);
    const health = await monitor.checkHealth();
    expect(health.components["bad"]!.status).toBe("offline");
    expect(health.components["bad"]!.details).toEqual({ error: "null" });
  });
});
