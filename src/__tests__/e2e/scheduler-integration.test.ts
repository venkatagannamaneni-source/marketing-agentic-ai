/**
 * E2E Integration: Scheduler → Director → Workspace
 *
 * Tests the cron-based scheduling flow where the Scheduler fires on
 * deterministic clock ticks, creates goals/pipelines via the Director,
 * and persists schedule state to the workspace.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { bootstrapE2EFull } from "./helpers.ts";
import type { E2EFullContext } from "./helpers.ts";
import type { ScheduleEntry } from "../../types/events.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function createSchedule(overrides?: Partial<ScheduleEntry>): ScheduleEntry {
  return {
    id: "test-sched",
    name: "Test Schedule",
    cron: "* * * * *", // every minute (always matches)
    pipelineId: "Content Production",
    enabled: true,
    description: "Integration test schedule",
    priority: "P2",
    goalCategory: "content",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Scheduler → Director → Workspace", () => {
  let ctx: E2EFullContext;

  beforeEach(async () => {
    ctx = await bootstrapE2EFull({
      clockDate: new Date(2026, 1, 16, 6, 0), // Monday 6:00 AM
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("template-based schedule fires on cron match and creates tasks", async () => {
    const schedule = createSchedule({
      cron: "0 6 * * *", // 6:00 AM daily
      pipelineId: "Content Production",
    });

    await ctx.scheduler.start([schedule]);
    const result = await ctx.scheduler.tick();

    // Fired
    expect(result.fired).toContain("test-sched");

    // Tasks created in workspace by Director.startPipeline
    const tasks = await ctx.workspace.listTasks();
    expect(tasks.length).toBeGreaterThan(0);

    // State persisted
    const state = await ctx.workspace.readScheduleState("test-sched");
    expect(state).not.toBeNull();
    expect(state!.fireCount).toBe(1);
    expect(state!.lastFiredAt).toBe(new Date(2026, 1, 16, 6, 0).toISOString());

    await ctx.scheduler.stop();
  });

  it("goal-based schedule creates goal via Director", async () => {
    const schedule = createSchedule({
      cron: "0 6 * * *",
      pipelineId: "goal:social-content",
      goalCategory: "content",
    });

    await ctx.scheduler.start([schedule]);
    const result = await ctx.scheduler.tick();

    expect(result.fired).toContain("test-sched");

    // Goal created in workspace
    const goals = await ctx.workspace.listGoals();
    expect(goals.length).toBeGreaterThan(0);

    // Verify logged
    expect(ctx.logger.has("info", "schedule_fired_goal")).toBe(true);

    await ctx.scheduler.stop();
  });

  it("budget gating skips low-priority schedule", async () => {
    // Record costs to push budget to throttle (90%+ of $1000)
    ctx.costTracker.record({
      timestamp: new Date().toISOString(),
      taskId: "cost-push",
      skillName: "copywriting",
      modelTier: "sonnet",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 910, // 91% of $1000
    });

    const budget = ctx.costTracker.toBudgetState();
    expect(budget.level).toBe("throttle");

    const schedule = createSchedule({
      cron: "0 6 * * *",
      priority: "P2", // Not in throttle allowed (P0, P1 only)
    });

    await ctx.scheduler.start([schedule]);
    const result = await ctx.scheduler.tick();

    expect(result.fired).toHaveLength(0);
    expect(result.skipped.find(s => s.id === "test-sched")?.reason).toBe("budget_throttle");

    // State updated with skip reason
    const states = ctx.scheduler.getScheduleStates();
    const state = states.get("test-sched");
    expect(state?.lastSkipReason).toBe("budget_throttle");

    await ctx.scheduler.stop();
  });

  it("overlap protection prevents re-fire while pipeline is running", async () => {
    const schedule = createSchedule({ cron: "* * * * *" });

    await ctx.scheduler.start([schedule]);

    // First tick fires
    const result1 = await ctx.scheduler.tick();
    expect(result1.fired).toContain("test-sched");

    // Advance clock to next minute (still running, not completed)
    ctx.clock.now = new Date(2026, 1, 16, 6, 1);
    const result2 = await ctx.scheduler.tick();
    expect(result2.fired).not.toContain("test-sched");
    expect(result2.skipped.find(s => s.id === "test-sched")?.reason).toBe(
      "pipeline_still_running",
    );

    // Mark completed, advance again
    ctx.scheduler.markCompleted("test-sched");
    ctx.clock.now = new Date(2026, 1, 16, 6, 2);
    const result3 = await ctx.scheduler.tick();
    expect(result3.fired).toContain("test-sched");

    await ctx.scheduler.stop();
  });

  it("catch-up fires missed schedules on start", async () => {
    // Persist state showing last fire was 2 days ago
    await ctx.workspace.writeScheduleState("daily-catchup", {
      scheduleId: "daily-catchup",
      lastFiredAt: new Date(2026, 1, 14, 6, 0).toISOString(),
      lastSkipReason: null,
      fireCount: 5,
    });

    // Create scheduler with catch-up enabled
    const { Scheduler } = await import("../../scheduler/scheduler.ts");
    const catchupScheduler = new Scheduler({
      director: ctx.director,
      workspace: ctx.workspace,
      logger: ctx.logger,
      budgetProvider: ctx.getBudget,
      clock: () => ctx.clock.now,
      config: { tickIntervalMs: 60_000, catchUpOnStart: true },
    });

    const schedule = createSchedule({
      id: "daily-catchup",
      cron: "0 6 * * *",
    });

    await catchupScheduler.start([schedule]);

    // Catch-up should have fired
    expect(ctx.logger.has("info", "schedule_catchup_fired")).toBe(true);

    const state = catchupScheduler.getScheduleStates().get("daily-catchup");
    expect(state!.fireCount).toBe(6);

    await catchupScheduler.stop();
  });

  it("dedup prevents double-fire within same minute", async () => {
    const schedule = createSchedule({ cron: "0 6 * * *" });

    await ctx.scheduler.start([schedule]);

    // First tick fires
    const result1 = await ctx.scheduler.tick();
    expect(result1.fired).toContain("test-sched");

    // Second tick at same time (same minute)
    const result2 = await ctx.scheduler.tick();
    expect(result2.fired).not.toContain("test-sched");
    expect(result2.skipped.find(s => s.id === "test-sched")?.reason).toBe(
      "already_fired_this_minute",
    );

    await ctx.scheduler.stop();
  });

  it("state persistence roundtrip: stop and restart preserves state", async () => {
    const schedule = createSchedule({ cron: "0 6 * * *" });

    // First scheduler instance: fire and stop
    await ctx.scheduler.start([schedule]);
    await ctx.scheduler.tick();
    await ctx.scheduler.stop();

    // Verify state persisted
    const persistedState = await ctx.workspace.readScheduleState("test-sched");
    expect(persistedState).not.toBeNull();
    expect(persistedState!.fireCount).toBe(1);

    // Second scheduler instance: starts with restored state
    const { Scheduler } = await import("../../scheduler/scheduler.ts");
    const scheduler2 = new Scheduler({
      director: ctx.director,
      workspace: ctx.workspace,
      logger: ctx.logger,
      budgetProvider: ctx.getBudget,
      clock: () => ctx.clock.now,
      config: { tickIntervalMs: 60_000, catchUpOnStart: false },
    });

    await scheduler2.start([schedule]);

    const states = scheduler2.getScheduleStates();
    const restoredState = states.get("test-sched");
    expect(restoredState).toBeDefined();
    expect(restoredState!.fireCount).toBe(1);
    expect(restoredState!.lastFiredAt).toBe(persistedState!.lastFiredAt);

    // Tick at 7:00 — should NOT fire (cron is 0 6 * * *)
    ctx.clock.now = new Date(2026, 1, 16, 7, 0);
    const result = await scheduler2.tick();
    expect(result.fired).toHaveLength(0);

    await scheduler2.stop();
  });
});
