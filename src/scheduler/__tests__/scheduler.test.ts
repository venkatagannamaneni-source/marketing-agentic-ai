import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Scheduler } from "../scheduler.ts";
import { DEFAULT_SCHEDULES } from "../default-schedules.ts";
import {
  createSchedulerTestContext,
  createTestScheduleEntry,
  createTestBudgetState,
  createTestScheduleState,
  type SchedulerTestContext,
} from "./helpers.ts";

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe("Scheduler lifecycle", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("starts and stops without error", async () => {
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([]);
    expect(scheduler.isRunning()).toBe(true);
    await scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("start is idempotent", async () => {
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([]);
    await scheduler.start([]); // Second start should be no-op
    expect(scheduler.isRunning()).toBe(true);
    await scheduler.stop();
  });

  it("stop is idempotent", async () => {
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([]);
    await scheduler.stop();
    await scheduler.stop(); // Second stop should be no-op
    expect(scheduler.isRunning()).toBe(false);
  });

  it("loads schedules on start", async () => {
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry();
    await scheduler.start([entry]);

    expect(scheduler.getAllSchedules()).toHaveLength(1);
    expect(scheduler.getActiveSchedules()).toHaveLength(1);
    await scheduler.stop();
  });

  it("loads default schedules", async () => {
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start(DEFAULT_SCHEDULES);

    expect(scheduler.getAllSchedules()).toHaveLength(6);
    expect(scheduler.getActiveSchedules()).toHaveLength(6);
    await scheduler.stop();
  });

  it("logs scheduler_started on start", async () => {
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([createTestScheduleEntry()]);
    expect(ctx.logger.has("info", "scheduler_started")).toBe(true);
    await scheduler.stop();
  });

  it("logs scheduler_stopped on stop", async () => {
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([]);
    await scheduler.stop();
    expect(ctx.logger.has("info", "scheduler_stopped")).toBe(true);
  });
});

// ── Tick: Cron Matching ─────────────────────────────────────────────────────

describe("Scheduler tick: cron matching", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("fires schedule when cron matches current time", async () => {
    // Schedule fires at 6:00 AM daily; clock is set to 6:00
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *" });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toContain("test-schedule");
    expect(result.skipped.find((s) => s.id === "test-schedule")).toBeUndefined();
    await scheduler.stop();
  });

  it("does not fire when cron does not match", async () => {
    // Schedule fires at 6:00 AM; clock is at 7:00
    ctx.clock.now = new Date(2026, 1, 16, 7, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *" });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toHaveLength(0);
    await scheduler.stop();
  });

  it("fires multiple schedules in the same tick", async () => {
    // Both fire at 6:00 AM
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([
      createTestScheduleEntry({ id: "sched-1", cron: "0 6 * * *", pipelineId: "Content Production" }),
      createTestScheduleEntry({ id: "sched-2", cron: "0 6 * * *", pipelineId: "SEO Cycle" }),
    ]);

    const result = await scheduler.tick();
    expect(result.fired).toContain("sched-1");
    expect(result.fired).toContain("sched-2");
    await scheduler.stop();
  });

  it("fires weekly schedule only on correct day", async () => {
    // Monday midnight
    const monday = new Date(2026, 1, 16, 0, 0);
    expect(monday.getDay()).toBe(1);

    ctx.clock.now = monday;
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({
      id: "weekly",
      cron: "0 0 * * 1",
    });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toContain("weekly");

    // Now try Tuesday
    ctx.clock.now = new Date(2026, 1, 17, 0, 0);
    const result2 = await scheduler.tick();
    expect(result2.fired).not.toContain("weekly");

    await scheduler.stop();
  });
});

// ── Tick: Dedup ─────────────────────────────────────────────────────────────

describe("Scheduler tick: dedup", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("does not fire the same schedule twice in the same minute", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *" });
    await scheduler.start([entry]);

    const result1 = await scheduler.tick();
    expect(result1.fired).toContain("test-schedule");

    // Second tick in the same minute
    const result2 = await scheduler.tick();
    expect(result2.fired).not.toContain("test-schedule");
    expect(result2.skipped.find((s) => s.id === "test-schedule")?.reason).toBe(
      "already_fired_this_minute",
    );

    await scheduler.stop();
  });

  it("resets dedup when minute changes", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    // Use every-minute cron
    const entry = createTestScheduleEntry({ cron: "* * * * *" });
    await scheduler.start([entry]);

    const result1 = await scheduler.tick();
    expect(result1.fired).toContain("test-schedule");

    // Advance to next minute
    ctx.clock.now = new Date(2026, 1, 16, 6, 1);
    scheduler.markCompleted("test-schedule"); // Clear overlap

    const result2 = await scheduler.tick();
    expect(result2.fired).toContain("test-schedule");

    await scheduler.stop();
  });
});

// ── Tick: Overlap Prevention ────────────────────────────────────────────────

describe("Scheduler tick: overlap prevention", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("skips when pipeline is still running", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "* * * * *" });
    await scheduler.start([entry]);

    // First tick fires
    const result1 = await scheduler.tick();
    expect(result1.fired).toContain("test-schedule");

    // Next minute — pipeline still running (not marked completed)
    ctx.clock.now = new Date(2026, 1, 16, 6, 1);
    const result2 = await scheduler.tick();
    expect(result2.fired).not.toContain("test-schedule");
    expect(result2.skipped.find((s) => s.id === "test-schedule")?.reason).toBe(
      "pipeline_still_running",
    );

    await scheduler.stop();
  });

  it("fires again after markCompleted()", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "* * * * *" });
    await scheduler.start([entry]);

    await scheduler.tick(); // fires

    // Mark completed and advance minute
    scheduler.markCompleted("test-schedule");
    ctx.clock.now = new Date(2026, 1, 16, 6, 1);

    const result = await scheduler.tick();
    expect(result.fired).toContain("test-schedule");

    await scheduler.stop();
  });

  it("logs overlap skip with pipeline details", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "* * * * *" });
    await scheduler.start([entry]);

    await scheduler.tick(); // fires

    ctx.clock.now = new Date(2026, 1, 16, 6, 1);
    await scheduler.tick(); // skips (overlap)

    expect(ctx.logger.has("info", "schedule_overlap_skipped")).toBe(true);
    await scheduler.stop();
  });
});

// ── Tick: Budget Gate ───────────────────────────────────────────────────────

describe("Scheduler tick: budget gate", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("skips all schedules when budget is exhausted", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    ctx.budget.state = createTestBudgetState("exhausted");
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *", priority: "P2" });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toHaveLength(0);
    expect(result.skipped.find((s) => s.id === "test-schedule")?.reason).toBe(
      "budget_exhausted",
    );

    await scheduler.stop();
  });

  it("skips P2 schedule when budget is in throttle (only P0+P1 allowed)", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    ctx.budget.state = createTestBudgetState("throttle");
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *", priority: "P2" });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toHaveLength(0);
    expect(result.skipped.find((s) => s.id === "test-schedule")?.reason).toBe(
      "budget_throttle",
    );

    await scheduler.stop();
  });

  it("fires P0 schedule even when budget is critical", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    ctx.budget.state = createTestBudgetState("critical");
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *", priority: "P0" });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toContain("test-schedule");

    await scheduler.stop();
  });

  it("fires P1 schedule when budget is at warning level", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    ctx.budget.state = createTestBudgetState("warning");
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *", priority: "P1" });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toContain("test-schedule");

    await scheduler.stop();
  });

  it("logs budget skip with level and priority", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    ctx.budget.state = createTestBudgetState("exhausted");
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *", priority: "P2" });
    await scheduler.start([entry]);

    await scheduler.tick();
    expect(ctx.logger.has("info", "schedule_budget_skipped")).toBe(true);

    await scheduler.stop();
  });
});

// ── Tick: Disabled Schedules ────────────────────────────────────────────────

describe("Scheduler tick: disabled schedules", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("skips disabled schedule", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *", enabled: false });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toHaveLength(0);
    expect(result.skipped.find((s) => s.id === "test-schedule")?.reason).toBe(
      "disabled",
    );

    await scheduler.stop();
  });

  it("setEnabled(false) prevents firing", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *" });
    await scheduler.start([entry]);

    scheduler.setEnabled("test-schedule", false);

    const result = await scheduler.tick();
    expect(result.fired).toHaveLength(0);

    await scheduler.stop();
  });

  it("setEnabled(true) re-enables firing", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *", enabled: false });
    await scheduler.start([entry]);

    scheduler.setEnabled("test-schedule", true);

    const result = await scheduler.tick();
    expect(result.fired).toContain("test-schedule");

    await scheduler.stop();
  });
});

// ── Tick: Firing Paths ──────────────────────────────────────────────────────

describe("Scheduler tick: firing paths", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("template-based schedule creates pipeline tasks via Director", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({
      cron: "0 6 * * *",
      pipelineId: "Content Production",
    });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toContain("test-schedule");
    expect(ctx.logger.has("info", "schedule_fired_pipeline")).toBe(true);

    // Verify tasks were created in workspace
    const tasks = await ctx.workspace.listTasks();
    expect(tasks.length).toBeGreaterThan(0);

    await scheduler.stop();
  });

  it("goal-based schedule creates goal via Director", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({
      cron: "0 6 * * *",
      pipelineId: "goal:social-content",
      goalCategory: "content",
    });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toContain("test-schedule");
    expect(ctx.logger.has("info", "schedule_fired_goal")).toBe(true);

    // Verify goal was created
    const goals = await ctx.workspace.listGoals();
    expect(goals.length).toBeGreaterThan(0);

    await scheduler.stop();
  });

  it("handles fire error gracefully (does not crash)", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    // Reference a non-existent template to trigger an error
    const entry = createTestScheduleEntry({
      cron: "0 6 * * *",
      pipelineId: "NonExistent Pipeline",
    });
    await scheduler.start([entry]);

    const result = await scheduler.tick();
    expect(result.fired).toHaveLength(0);
    expect(
      result.skipped.find((s) => s.id === "test-schedule")?.reason,
    ).toContain("fire_error");
    expect(ctx.logger.has("error", "schedule_fire_failed")).toBe(true);

    await scheduler.stop();
  });

  it("handles invalid cron gracefully (does not add schedule)", async () => {
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({
      cron: "invalid cron",
    });
    await scheduler.start([entry]);

    expect(scheduler.getAllSchedules()).toHaveLength(0);
    expect(ctx.logger.has("error", "schedule_invalid_cron")).toBe(true);

    await scheduler.stop();
  });
});

// ── State Persistence ───────────────────────────────────────────────────────

describe("Scheduler state persistence", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("persists state after firing", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *" });
    await scheduler.start([entry]);

    await scheduler.tick();

    const state = await ctx.workspace.readScheduleState("test-schedule");
    expect(state).not.toBeNull();
    expect(state!.scheduleId).toBe("test-schedule");
    expect(state!.lastFiredAt).toBe("2026-02-16T06:00:00.000Z");
    expect(state!.fireCount).toBe(1);
    expect(state!.lastSkipReason).toBeNull();

    await scheduler.stop();
  });

  it("increments fireCount on each firing", async () => {
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "* * * * *" });
    await scheduler.start([entry]);

    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    await scheduler.tick();

    scheduler.markCompleted("test-schedule");
    ctx.clock.now = new Date(2026, 1, 16, 6, 1);
    await scheduler.tick();

    const state = await ctx.workspace.readScheduleState("test-schedule");
    expect(state!.fireCount).toBe(2);

    await scheduler.stop();
  });

  it("restores state from workspace on start", async () => {
    // Pre-persist state
    await ctx.workspace.writeScheduleState("test-schedule", {
      scheduleId: "test-schedule",
      lastFiredAt: "2026-02-15T06:00:00.000Z",
      lastSkipReason: null,
      fireCount: 10,
    });

    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *" });
    await scheduler.start([entry]);

    const states = scheduler.getScheduleStates();
    const state = states.get("test-schedule");
    expect(state).toBeDefined();
    expect(state!.fireCount).toBe(10);
    expect(state!.lastFiredAt).toBe("2026-02-15T06:00:00.000Z");

    await scheduler.stop();
  });
});

// ── Catch-Up ────────────────────────────────────────────────────────────────

describe("Scheduler catch-up", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("fires missed daily schedule on start (last fired yesterday)", async () => {
    // Clock is Monday Feb 16 at 10:00; last fired Feb 15 at 6:00
    ctx.clock.now = new Date(2026, 1, 16, 10, 0);

    await ctx.workspace.writeScheduleState("daily-test", {
      scheduleId: "daily-test",
      lastFiredAt: "2026-02-15T06:00:00.000Z",
      lastSkipReason: null,
      fireCount: 5,
    });

    const scheduler = new Scheduler({
      ...ctx.deps,
      config: { ...ctx.deps.config, catchUpOnStart: true },
    });
    const entry = createTestScheduleEntry({
      id: "daily-test",
      cron: "0 6 * * *",
    });
    await scheduler.start([entry]);

    expect(ctx.logger.has("info", "schedule_catchup_fired")).toBe(true);

    // State should be updated
    const state = scheduler.getScheduleStates().get("daily-test");
    expect(state!.fireCount).toBe(6);

    await scheduler.stop();
  });

  it("does not catch up if lastFiredAt is current", async () => {
    // Clock is Monday Feb 16 at 10:00; last fired today at 6:00
    ctx.clock.now = new Date(2026, 1, 16, 10, 0);

    await ctx.workspace.writeScheduleState("daily-test", {
      scheduleId: "daily-test",
      lastFiredAt: "2026-02-16T06:00:00.000Z",
      lastSkipReason: null,
      fireCount: 5,
    });

    const scheduler = new Scheduler({
      ...ctx.deps,
      config: { ...ctx.deps.config, catchUpOnStart: true },
    });
    const entry = createTestScheduleEntry({
      id: "daily-test",
      cron: "0 6 * * *",
    });
    await scheduler.start([entry]);

    expect(ctx.logger.has("info", "schedule_catchup_fired")).toBe(false);

    const state = scheduler.getScheduleStates().get("daily-test");
    expect(state!.fireCount).toBe(5); // Unchanged

    await scheduler.stop();
  });

  it("does not catch up when catchUpOnStart is false", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 10, 0);

    await ctx.workspace.writeScheduleState("daily-test", {
      scheduleId: "daily-test",
      lastFiredAt: "2026-02-14T06:00:00.000Z",
      lastSkipReason: null,
      fireCount: 3,
    });

    const scheduler = new Scheduler({
      ...ctx.deps,
      config: { ...ctx.deps.config, catchUpOnStart: false },
    });
    const entry = createTestScheduleEntry({
      id: "daily-test",
      cron: "0 6 * * *",
    });
    await scheduler.start([entry]);

    expect(ctx.logger.has("info", "schedule_catchup_fired")).toBe(false);

    await scheduler.stop();
  });

  it("fires catch-up for never-fired schedule", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 10, 0);

    const scheduler = new Scheduler({
      ...ctx.deps,
      config: { ...ctx.deps.config, catchUpOnStart: true },
    });
    const entry = createTestScheduleEntry({
      id: "never-fired",
      cron: "0 6 * * *",
    });
    await scheduler.start([entry]);

    expect(ctx.logger.has("info", "schedule_catchup_fired")).toBe(true);

    await scheduler.stop();
  });

  it("catch-up respects budget gate", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 10, 0);
    ctx.budget.state = createTestBudgetState("exhausted");

    const scheduler = new Scheduler({
      ...ctx.deps,
      config: { ...ctx.deps.config, catchUpOnStart: true },
    });
    const entry = createTestScheduleEntry({
      id: "budget-test",
      cron: "0 6 * * *",
      priority: "P2",
    });
    await scheduler.start([entry]);

    expect(ctx.logger.has("info", "schedule_catchup_budget_skipped")).toBe(true);
    expect(ctx.logger.has("info", "schedule_catchup_fired")).toBe(false);

    await scheduler.stop();
  });

  it("catch-up fires in priority order (P0 before P2)", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 10, 0);

    const scheduler = new Scheduler({
      ...ctx.deps,
      config: { ...ctx.deps.config, catchUpOnStart: true },
    });

    // P2 added first, but P0 should fire first
    await scheduler.start([
      createTestScheduleEntry({
        id: "low-priority",
        cron: "0 6 * * *",
        priority: "P2",
        pipelineId: "Content Production",
      }),
      createTestScheduleEntry({
        id: "high-priority",
        cron: "0 6 * * *",
        priority: "P0",
        pipelineId: "SEO Cycle",
      }),
    ]);

    // Both should fire; verify via log order
    const catchupLogs = ctx.logger.entries.filter(
      (e) => e.msg === "schedule_catchup_fired",
    );
    expect(catchupLogs).toHaveLength(2);
    expect(catchupLogs[0]!.data?.scheduleId).toBe("high-priority");
    expect(catchupLogs[1]!.data?.scheduleId).toBe("low-priority");

    await scheduler.stop();
  });
});

// ── Dynamic Schedule Management ─────────────────────────────────────────────

describe("Scheduler dynamic management", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("addSchedule adds a new schedule at runtime", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([]);

    expect(scheduler.getAllSchedules()).toHaveLength(0);

    scheduler.addSchedule(createTestScheduleEntry({ cron: "0 6 * * *" }));
    expect(scheduler.getAllSchedules()).toHaveLength(1);

    const result = await scheduler.tick();
    expect(result.fired).toContain("test-schedule");

    await scheduler.stop();
  });

  it("removeSchedule stops tracking", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    const entry = createTestScheduleEntry({ cron: "0 6 * * *" });
    await scheduler.start([entry]);

    scheduler.removeSchedule("test-schedule");
    expect(scheduler.getAllSchedules()).toHaveLength(0);

    const result = await scheduler.tick();
    expect(result.fired).toHaveLength(0);

    await scheduler.stop();
  });

  it("addSchedule logs addition", async () => {
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([]);
    scheduler.addSchedule(createTestScheduleEntry());
    expect(ctx.logger.has("info", "schedule_added")).toBe(true);
    await scheduler.stop();
  });

  it("removeSchedule logs removal", async () => {
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([createTestScheduleEntry()]);
    scheduler.removeSchedule("test-schedule");
    expect(ctx.logger.has("info", "schedule_removed")).toBe(true);
    await scheduler.stop();
  });
});

// ── TickResult ──────────────────────────────────────────────────────────────

describe("Scheduler tick result", () => {
  let ctx: SchedulerTestContext;

  beforeEach(async () => {
    ctx = await createSchedulerTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns timestamp in ISO format", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([]);

    const result = await scheduler.tick();
    expect(result.timestamp).toBe("2026-02-16T06:00:00.000Z");

    await scheduler.stop();
  });

  it("returns fired and skipped arrays", async () => {
    ctx.clock.now = new Date(2026, 1, 16, 6, 0);
    const scheduler = new Scheduler(ctx.deps);
    await scheduler.start([
      createTestScheduleEntry({ id: "active", cron: "0 6 * * *" }),
      createTestScheduleEntry({ id: "disabled", cron: "0 6 * * *", enabled: false }),
    ]);

    const result = await scheduler.tick();
    expect(result.fired).toContain("active");
    expect(result.skipped.find((s) => s.id === "disabled")).toBeDefined();
    expect(result.skipped.find((s) => s.id === "disabled")?.reason).toBe("disabled");

    await scheduler.stop();
  });
});
