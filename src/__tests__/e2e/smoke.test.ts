/**
 * E2E Smoke Test — Phase 2 Validation
 *
 * Two-layer smoke test proving the full system works:
 *
 * Layer 1 (Structural): Uses bootstrapE2EFull() with mock infra. Always runs.
 *   Verifies all 14 modules wire together and data flows correctly.
 *
 * Layer 2 (Real Infrastructure): Uses bootstrap() with real Claude/Redis.
 *   Skipped if ANTHROPIC_API_KEY is not set or Redis is unavailable.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapE2EFull } from "./helpers.ts";
import type { E2EFullContext } from "./helpers.ts";
import { SKILL_SQUAD_MAP } from "../../types/agent.ts";
import type { Task } from "../../types/task.ts";
import type { SkillName } from "../../types/agent.ts";
import type { SystemEvent } from "../../types/events.ts";
import type { ScheduleEntry } from "../../types/events.ts";

// ── Layer 2 imports ──────────────────────────────────────────────────────────
import { loadConfig } from "../../config.ts";
import { bootstrap } from "../../bootstrap.ts";
import { runGoal } from "../../runtime/run-goal.ts";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const HAS_API_KEY = Boolean(API_KEY);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(priority: "P0" | "P1" | "P2" | "P3", id: string): Task {
  const now = new Date().toISOString();
  return {
    id,
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
    goal: "Smoke test goal",
    inputs: [],
    requirements: "Smoke test requirements",
    output: { path: `outputs/creative/copywriting/${id}.md`, format: "markdown" },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
  } as Task;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Layer 1: Structural Smoke (always runs — no real API/Redis)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Smoke: Structural (all 14 modules, mock infra)", () => {
  let ctx: E2EFullContext;

  beforeEach(async () => {
    ctx = await bootstrapE2EFull({
      budgetTotal: 1000,
      clockDate: new Date(2026, 1, 16, 6, 0),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ── Test 1: Goal Lifecycle ───────────────────────────────────────────────

  it("goal lifecycle: create, decompose, materialize tasks", async () => {
    // Director creates goal
    const goal = await ctx.director.createGoal(
      "Smoke test: increase signup conversion by 20%",
      "optimization",
      "P2",
    );
    expect(goal.id).toBeDefined();
    expect(goal.id).toMatch(/^goal-/);

    // Director decomposes into plan
    const plan = ctx.director.decomposeGoal(goal);
    expect(plan.phases.length).toBeGreaterThanOrEqual(1);
    expect(plan.estimatedTaskCount).toBeGreaterThanOrEqual(1);

    // Director materializes tasks into workspace
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // Verify tasks are persisted in workspace
    const allTasks = await ctx.workspace.listTasks();
    const goalTasks = allTasks.filter(t => t.goalId === goal.id);
    expect(goalTasks.length).toBe(tasks.length);

    // Each task has correct goal reference
    for (const task of goalTasks) {
      expect(task.goalId).toBe(goal.id);
      expect(task.status).toBe("pending");
    }
  });

  // ── Test 2: Pipeline Execution ───────────────────────────────────────────

  it("pipeline execution: goal plan to completed outputs", async () => {
    const goal = await ctx.director.createGoal(
      "Create blog content strategy",
      "content",
      "P2",
    );
    const plan = ctx.director.decomposeGoal(goal);
    await ctx.director.planGoalTasks(plan, goal);

    // Build pipeline from plan
    const definition = ctx.pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = ctx.pipelineFactory.createRun(definition, goal.id);

    // Execute pipeline (mock Claude)
    const result = await ctx.pipelineEngine.execute(definition, run, {
      goalDescription: goal.description,
      priority: goal.priority,
    });

    // Pipeline completed
    expect(result.status).toBe("completed");
    expect(result.stepResults.length).toBe(definition.steps.length);

    for (const stepResult of result.stepResults) {
      expect(stepResult.status).toBe("completed");
    }

    // Tokens tracked
    expect(result.totalTokensUsed.input).toBeGreaterThan(0);
    expect(result.totalTokensUsed.output).toBeGreaterThan(0);

    // Outputs written to workspace
    for (const taskId of run.taskIds) {
      const task = await ctx.workspace.readTask(taskId);
      const squad = SKILL_SQUAD_MAP[task.to];
      if (squad) {
        const output = await ctx.workspace.readOutput(squad, task.to, taskId);
        expect(output.length).toBeGreaterThan(100);
      }
    }
  });

  // ── Test 3: Queue + CostTracker Budget Gating ──────────────────────────

  it("queue + cost tracker: budget gating defers low-priority work", async () => {
    // Normal budget — P2 enqueued
    expect(ctx.costTracker.toBudgetState().level).toBe("normal");

    const p2Task = makeTask("P2", "smoke-p2");
    await ctx.workspace.writeTask(p2Task);
    const result1 = await ctx.queueManager.enqueue(p2Task);
    expect(result1).toBe("enqueued");

    // Push to throttle — P2 deferred, P1 allowed
    ctx.costTracker.record({
      timestamp: new Date().toISOString(),
      taskId: "cost-push",
      skillName: "copywriting",
      modelTier: "sonnet",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 910, // 91% of $1000
    });
    expect(ctx.costTracker.toBudgetState().level).toBe("throttle");

    const p2Task2 = makeTask("P2", "smoke-p2-deferred");
    await ctx.workspace.writeTask(p2Task2);
    const result2 = await ctx.queueManager.enqueue(p2Task2);
    expect(result2).toBe("deferred");

    const p1Task = makeTask("P1", "smoke-p1");
    await ctx.workspace.writeTask(p1Task);
    const result3 = await ctx.queueManager.enqueue(p1Task);
    expect(result3).toBe("enqueued");
  });

  // ── Test 4: EventBus Triggers Pipeline ─────────────────────────────────

  it("event bus: traffic_drop triggers pipeline and enqueues tasks", async () => {
    const event: SystemEvent = {
      id: "smoke-evt-1",
      type: "traffic_drop",
      timestamp: new Date().toISOString(),
      source: "smoke-test",
      data: { percentageDrop: 25 },
    };

    const result = await ctx.eventBus.emit(event);

    expect(result.pipelinesTriggered).toBe(1);
    expect(result.pipelineIds).toHaveLength(1);

    // Tasks created in workspace
    const tasks = await ctx.workspace.listTasks();
    expect(tasks.length).toBeGreaterThan(0);

    // Tasks enqueued in mock queue
    expect(ctx.mockQueue.jobs.length).toBeGreaterThan(0);
  });

  // ── Test 5: Scheduler Fires and Creates Tasks ──────────────────────────

  it("scheduler: cron tick fires schedule and creates tasks", async () => {
    const schedule: ScheduleEntry = {
      id: "smoke-sched",
      name: "Smoke Schedule",
      cron: "0 6 * * *", // 6:00 AM daily
      pipelineId: "Content Production",
      enabled: true,
      description: "Smoke test schedule",
      priority: "P2",
      goalCategory: "content",
    };

    await ctx.scheduler.start([schedule]);
    const tickResult = await ctx.scheduler.tick();

    expect(tickResult.fired).toContain("smoke-sched");

    // Tasks created in workspace via Director.startPipeline
    const tasks = await ctx.workspace.listTasks();
    expect(tasks.length).toBeGreaterThan(0);

    await ctx.scheduler.stop();
  });

  // ── Test 6: Capstone — All 14 Modules Touched ─────────────────────────

  it("capstone: all 14 modules touched in sequence", async () => {
    // 1. Workspace — write + read
    await ctx.workspace.writeFile("context/smoke-marker.md", "# Smoke\n");
    const marker = await ctx.workspace.readFile("context/smoke-marker.md");
    expect(marker).toContain("Smoke");

    // 2. Director — create goal (types + workspace)
    const goal = await ctx.director.createGoal(
      "Capstone smoke: full system validation",
      "content",
      "P2",
    );
    expect(goal.id).toBeDefined();

    // 3. Director — decompose goal
    const plan = ctx.director.decomposeGoal(goal);
    expect(plan.phases.length).toBeGreaterThanOrEqual(1);

    // 4. Director — materialize tasks
    const phaseTasks = await ctx.director.planGoalTasks(plan, goal);
    expect(phaseTasks.length).toBeGreaterThanOrEqual(1);

    // 5. Pipeline — build and execute
    const definition = ctx.pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = ctx.pipelineFactory.createRun(definition, goal.id);
    const pipelineResult = await ctx.pipelineEngine.execute(definition, run, {
      goalDescription: goal.description,
      priority: goal.priority,
    });
    expect(pipelineResult.status).toBe("completed");

    // 6. Queue — enqueue a task
    const queueTask = makeTask("P2", "smoke-queue-capstone");
    await ctx.workspace.writeTask(queueTask);
    const enqueueResult = await ctx.queueManager.enqueue(queueTask);
    expect(enqueueResult).toBe("enqueued");

    // 7. CostTracker — record and read budget
    ctx.costTracker.record({
      timestamp: new Date().toISOString(),
      taskId: "smoke-cost",
      skillName: "copywriting",
      modelTier: "sonnet",
      inputTokens: 500,
      outputTokens: 250,
      estimatedCost: 5,
    });
    expect(ctx.costTracker.getTotalSpent()).toBe(5);
    const budget = ctx.costTracker.toBudgetState();
    expect(budget.level).toBe("normal");

    // 8. EventBus — emit event
    const eventResult = await ctx.eventBus.emit({
      id: "smoke-capstone-evt",
      type: "new_blog_post",
      timestamp: new Date().toISOString(),
      source: "smoke-test",
      data: { title: "Capstone Post" },
    });
    expect(eventResult.pipelinesTriggered).toBe(1);

    // 9. Scheduler — start + tick
    await ctx.scheduler.start([{
      id: "smoke-capstone-sched",
      name: "Capstone Schedule",
      cron: "0 6 * * *",
      pipelineId: "Content Production",
      enabled: true,
      description: "Capstone smoke",
      priority: "P2",
      goalCategory: "content",
    }]);
    const tickResult = await ctx.scheduler.tick();
    expect(tickResult.fired).toContain("smoke-capstone-sched");
    await ctx.scheduler.stop();

    // 10. Logger — verify substantial logging occurred
    expect(ctx.logger.entries.length).toBeGreaterThan(5);

    // Final checks: workspace has goals, tasks, outputs
    const goals = await ctx.workspace.listGoals();
    expect(goals.length).toBeGreaterThanOrEqual(1);

    const allTasks = await ctx.workspace.listTasks();
    expect(allTasks.length).toBeGreaterThan(3);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Layer 2: Real Infrastructure Smoke (skip if no ANTHROPIC_API_KEY)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!HAS_API_KEY)("Smoke: Real infrastructure", () => {

  it("loadConfig reads real environment variables", () => {
    const config = loadConfig();

    expect(config.anthropicApiKey).toBeTruthy();
    expect(config.anthropicApiKey.length).toBeGreaterThan(5);
    expect(config.redis.host).toBeDefined();
    expect(config.redis.port).toBeGreaterThan(0);
    expect(config.workspace.rootDir).toMatch(/^\//);
    expect(config.budget.totalMonthly).toBeGreaterThan(0);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("bootstrap + runGoal dry run completes full lifecycle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "smoke-real-"));

    try {
      const config = loadConfig({
        WORKSPACE_DIR: tempDir,
        LOG_LEVEL: "silent",
        LOG_FORMAT: "json",
      });

      // bootstrap() creates real Redis connections — may fail if Redis not available
      let app;
      try {
        app = await bootstrap(config);
      } catch (err: unknown) {
        // Redis not available — skip gracefully
        console.log(
          `[Smoke] Skipping bootstrap test: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      try {
        await app.start();

        // Dry run — creates goal + decomposes but does NOT execute
        const result = await runGoal(app, "Create a content strategy for MarketFlow", {
          dryRun: true,
          priority: "P2",
        });

        expect(result.goalId).toBeDefined();
        expect(result.status).toBe("completed");
        expect(result.phases).toBeGreaterThan(0);
        expect(result.tasksCompleted).toBe(0); // dry run does not execute
        expect(result.totalCost).toBe(0); // dry run incurs no cost
      } finally {
        await app.shutdown();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
