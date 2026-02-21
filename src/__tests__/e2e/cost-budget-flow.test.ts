/**
 * E2E Integration: CostTracker → BudgetState → Queue + Scheduler Gating
 *
 * Tests that the CostTracker drives budget level transitions and that
 * both QueueManager and Scheduler correctly respond to budget constraints
 * (blocking lower-priority work as costs accumulate).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapE2EFull } from "./helpers.ts";
import type { E2EFullContext } from "./helpers.ts";
import type { ScheduleEntry } from "../../types/events.ts";
import type { Task } from "../../types/task.ts";
import type { SkillName } from "../../types/agent.ts";
import type { Priority } from "../../types/task.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function recordCost(ctx: E2EFullContext, amount: number, taskId?: string): void {
  ctx.costTracker.record({
    timestamp: new Date().toISOString(),
    taskId: taskId ?? `cost-${Date.now()}`,
    skillName: "copywriting" as SkillName,
    modelTier: "sonnet",
    inputTokens: 1000,
    outputTokens: 500,
    estimatedCost: amount,
  });
}

function createTask(priority: Priority, id?: string): Task {
  const taskId = id ?? `task-${priority}-${Date.now()}`;
  const now = new Date().toISOString();
  return {
    id: taskId,
    createdAt: now,
    updatedAt: now,
    from: "director",
    to: "copywriting" as SkillName,
    priority,
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: null,
    pipelineId: null,
    goal: "Test goal",
    inputs: [],
    requirements: "Test requirements",
    output: { path: `outputs/creative/copywriting/${taskId}.md`, format: "markdown" },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
  } as Task;
}

function createSchedule(overrides?: Partial<ScheduleEntry>): ScheduleEntry {
  return {
    id: "budget-sched",
    name: "Budget Test Schedule",
    cron: "* * * * *",
    pipelineId: "Content Production",
    enabled: true,
    description: "Budget integration test",
    priority: "P2",
    goalCategory: "content",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: CostTracker → Budget → Queue + Scheduler gating", () => {
  let ctx: E2EFullContext;

  beforeEach(async () => {
    ctx = await bootstrapE2EFull({
      budgetTotal: 100, // $100 budget for easy math
      clockDate: new Date(2026, 1, 16, 6, 0),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("Normal → Warning transition: P3 deferred, P2 allowed", async () => {
    // Under 80% — normal
    recordCost(ctx, 79);
    let budget = ctx.costTracker.toBudgetState();
    expect(budget.level).toBe("normal");
    expect(budget.allowedPriorities).toContain("P3");

    // Cross 80% — warning (P3 dropped)
    recordCost(ctx, 2); // total: $81
    budget = ctx.costTracker.toBudgetState();
    expect(budget.level).toBe("warning");
    expect(budget.allowedPriorities).not.toContain("P3");
    expect(budget.allowedPriorities).toContain("P2");

    // P3 task deferred by queue
    const p3Task = createTask("P3", "task-p3-warning");
    await ctx.workspace.writeTask(p3Task);
    const p3Result = await ctx.queueManager.enqueue(p3Task);
    expect(p3Result).toBe("deferred");

    // P2 task still allowed
    const p2Task = createTask("P2", "task-p2-warning");
    await ctx.workspace.writeTask(p2Task);
    const p2Result = await ctx.queueManager.enqueue(p2Task);
    expect(p2Result).toBe("enqueued");
  });

  it("Warning → Throttle transition: P2 deferred, P1 allowed", async () => {
    // Push to 90% — throttle
    recordCost(ctx, 91);
    const budget = ctx.costTracker.toBudgetState();
    expect(budget.level).toBe("throttle");
    expect(budget.allowedPriorities).toEqual(["P0", "P1"]);

    // P2 deferred
    const p2Task = createTask("P2", "task-p2-throttle");
    await ctx.workspace.writeTask(p2Task);
    const p2Result = await ctx.queueManager.enqueue(p2Task);
    expect(p2Result).toBe("deferred");

    // P1 allowed
    const p1Task = createTask("P1", "task-p1-throttle");
    await ctx.workspace.writeTask(p1Task);
    const p1Result = await ctx.queueManager.enqueue(p1Task);
    expect(p1Result).toBe("enqueued");

    // Scheduler: P2 schedule skipped, P1 schedule fires
    await ctx.scheduler.start([
      createSchedule({ id: "sched-p2", priority: "P2", cron: "0 6 * * *" }),
      createSchedule({ id: "sched-p1", priority: "P1", cron: "0 6 * * *" }),
    ]);
    const tickResult = await ctx.scheduler.tick();
    expect(tickResult.fired).not.toContain("sched-p2");
    expect(tickResult.skipped.find(s => s.id === "sched-p2")?.reason).toBe("budget_throttle");
    expect(tickResult.fired).toContain("sched-p1");

    await ctx.scheduler.stop();
  });

  it("Throttle → Critical transition: model downgrade to haiku, only P0", async () => {
    // Push to 95% — critical
    recordCost(ctx, 96);
    const budget = ctx.costTracker.toBudgetState();
    expect(budget.level).toBe("critical");
    expect(budget.allowedPriorities).toEqual(["P0"]);
    expect(budget.modelOverride).toBe("haiku");

    // P1 deferred
    const p1Task = createTask("P1", "task-p1-critical");
    await ctx.workspace.writeTask(p1Task);
    const p1Result = await ctx.queueManager.enqueue(p1Task);
    expect(p1Result).toBe("deferred");

    // P0 allowed
    const p0Task = createTask("P0", "task-p0-critical");
    await ctx.workspace.writeTask(p0Task);
    const p0Result = await ctx.queueManager.enqueue(p0Task);
    expect(p0Result).toBe("enqueued");
  });

  it("Critical → Exhausted: all work blocked", async () => {
    // Push to 100%+ — exhausted
    recordCost(ctx, 101);
    const budget = ctx.costTracker.toBudgetState();
    expect(budget.level).toBe("exhausted");
    expect(budget.allowedPriorities).toHaveLength(0);

    // Even P0 is blocked
    const p0Task = createTask("P0", "task-p0-exhausted");
    await ctx.workspace.writeTask(p0Task);
    const p0Result = await ctx.queueManager.enqueue(p0Task);
    expect(p0Result).toBe("deferred");

    // Scheduler: all schedules skipped
    await ctx.scheduler.start([
      createSchedule({ id: "sched-p0", priority: "P0", cron: "0 6 * * *" }),
      createSchedule({ id: "sched-p1", priority: "P1", cron: "0 6 * * *" }),
    ]);
    const tickResult = await ctx.scheduler.tick();
    expect(tickResult.fired).toHaveLength(0);
    expect(tickResult.skipped.find(s => s.id === "sched-p0")?.reason).toBe("budget_exhausted");
    expect(tickResult.skipped.find(s => s.id === "sched-p1")?.reason).toBe("budget_exhausted");

    await ctx.scheduler.stop();
  });

  it("CostTracker flush writes correct report to filesystem", async () => {
    // Record costs across different skills and models
    ctx.costTracker.record({
      timestamp: "2026-02-16T10:00:00Z",
      taskId: "task-1",
      skillName: "copywriting",
      modelTier: "sonnet",
      inputTokens: 2000,
      outputTokens: 1000,
      estimatedCost: 0.05,
    });
    ctx.costTracker.record({
      timestamp: "2026-02-16T11:00:00Z",
      taskId: "task-2",
      skillName: "seo-audit",
      modelTier: "haiku",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 0.01,
    });
    ctx.costTracker.record({
      timestamp: "2026-02-17T09:00:00Z",
      taskId: "task-3",
      skillName: "copywriting",
      modelTier: "sonnet",
      inputTokens: 3000,
      outputTokens: 1500,
      estimatedCost: 0.08,
    });

    const flushDir = await mkdtemp(join(tmpdir(), "cost-flush-"));
    const { mkdir, writeFile: writeFileFn } = await import("node:fs/promises");
    await ctx.costTracker.flush(flushDir, {
      writeFile: (path: string, content: string) => writeFileFn(path, content, "utf-8"),
      mkdir: (path: string) => mkdir(path, { recursive: true }).then(() => {}),
    });

    // Read the generated report
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = join(flushDir, `${today}-budget.md`);
    const report = await readFile(reportPath, "utf-8");

    // Verify report contents
    expect(report).toContain("# Cost Report");
    expect(report).toContain("Total entries: 3");
    expect(report).toContain("copywriting");
    expect(report).toContain("seo-audit");
    expect(report).toContain("sonnet");
    expect(report).toContain("haiku");
    expect(report).toContain("2026-02-16");
    expect(report).toContain("2026-02-17");

    await rm(flushDir, { recursive: true, force: true });
  });

  it("budget provider closure: queue and scheduler see same state", async () => {
    // Both QueueManager and Scheduler use the same budgetProvider:
    // () => costTracker.toBudgetState()

    // Start at normal — both should allow P2
    let budget = ctx.getBudget();
    expect(budget.level).toBe("normal");

    const schedule = createSchedule({ priority: "P2", cron: "* * * * *" }); // every minute
    await ctx.scheduler.start([schedule]);

    // Queue allows P2 task
    const task1 = createTask("P2", "task-shared-1");
    await ctx.workspace.writeTask(task1);
    const result1 = await ctx.queueManager.enqueue(task1);
    expect(result1).toBe("enqueued");

    // Scheduler fires P2 schedule
    const tick1 = await ctx.scheduler.tick();
    expect(tick1.fired).toContain("budget-sched");

    // Now push budget to throttle (only P0, P1 allowed)
    recordCost(ctx, 91);
    budget = ctx.getBudget();
    expect(budget.level).toBe("throttle");

    // Queue now defers P2 task
    const task2 = createTask("P2", "task-shared-2");
    await ctx.workspace.writeTask(task2);
    const result2 = await ctx.queueManager.enqueue(task2);
    expect(result2).toBe("deferred");

    // Scheduler also skips P2 schedule (advance clock + mark completed for overlap)
    ctx.scheduler.markCompleted("budget-sched");
    ctx.clock.now = new Date(2026, 1, 16, 6, 1);
    const tick2 = await ctx.scheduler.tick();
    expect(tick2.fired).not.toContain("budget-sched");
    expect(tick2.skipped.find(s => s.id === "budget-sched")?.reason).toBe("budget_throttle");

    await ctx.scheduler.stop();
  });
});
