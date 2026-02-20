/**
 * E2E: Budget Gating and Failure Handling
 *
 * Proves: Budget gating correctly defers/blocks tasks,
 * failure tracking works, and cascading failures pause the system.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { E2EContext } from "./helpers.ts";
import { bootstrapE2E } from "./helpers.ts";
import { ExecutionError } from "../../agents/claude-client.ts";

describe("E2E: Budget Gating", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await bootstrapE2E();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("defers P3 task at throttle budget level", async () => {
    ctx.setBudget({
      totalBudget: 1000,
      spent: 900,
      percentUsed: 90,
      level: "throttle",
      allowedPriorities: ["P0", "P1"],
      modelOverride: null,
    });

    const goal = await ctx.director.createGoal(
      "Low priority content",
      "content",
      "P3",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    const result = await ctx.queueManager.enqueue(task);
    expect(result).toBe("deferred");

    // Task status updated in workspace
    const updatedTask = await ctx.workspace.readTask(task.id);
    expect(updatedTask.status).toBe("deferred");

    // Queue should be empty
    expect(ctx.mockQueue.jobs.length).toBe(0);
  });

  it("blocks all tasks when budget exhausted", async () => {
    ctx.setBudget({
      totalBudget: 1000,
      spent: 1000,
      percentUsed: 100,
      level: "exhausted",
      allowedPriorities: [],
      modelOverride: "haiku",
    });

    const goal = await ctx.director.createGoal(
      "Critical content",
      "content",
      "P0",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    const result = await ctx.queueManager.enqueue(task);
    expect(result).toBe("deferred");

    // Task should be blocked
    const updatedTask = await ctx.workspace.readTask(task.id);
    expect(updatedTask.status).toBe("blocked");
    expect(ctx.mockQueue.jobs.length).toBe(0);
  });

  it("allows P0 task through throttle level", async () => {
    ctx.setBudget({
      totalBudget: 1000,
      spent: 900,
      percentUsed: 90,
      level: "throttle",
      allowedPriorities: ["P0", "P1"],
      modelOverride: null,
    });

    const goal = await ctx.director.createGoal(
      "High priority optimization",
      "optimization",
      "P0",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    const result = await ctx.queueManager.enqueue(task);
    expect(result).toBe("enqueued");

    // Job should be in queue
    expect(ctx.mockQueue.jobs.length).toBe(1);
    expect(ctx.mockQueue.jobs[0]!.data.taskId).toBe(task.id);
  });
});

describe("E2E: Failure Handling", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await bootstrapE2E();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("pipeline execution failure at step N stops pipeline", async () => {
    let callCount = 0;
    ctx = await bootstrapE2E({
      pipelineClientGenerator: () => {
        callCount++;
        if (callCount === 2) {
          // Fail on the second step
          throw new ExecutionError(
            "Simulated API error",
            "API_ERROR",
            "test",
            false,
          );
        }
        return {
          content: `# Output\n\n## Summary\n\nValid output for step ${callCount}.\nLine 2.\nLine 3.\n`,
        };
      },
    });

    const goal = await ctx.director.createGoal(
      "Content pipeline with failure",
      "content",
      "P2",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const definition = ctx.pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = ctx.pipelineFactory.createRun(definition, goal.id);

    const result = await ctx.pipelineEngine.execute(definition, run, {
      goalDescription: goal.description,
      priority: goal.priority,
    });

    // Pipeline should fail
    expect(result.status).toBe("failed");
    expect(run.status).toBe("failed");

    // Step 0 completed, step 1 failed, remaining steps never ran
    expect(result.stepResults.length).toBe(2);
    expect(result.stepResults[0]!.status).toBe("completed");
    expect(result.stepResults[1]!.status).toBe("failed");
  });

  it("cascading failure tracker pauses after threshold", () => {
    const tracker = ctx.failureTracker;
    const pipelineId = "test-pipeline-001";

    // Record 3 consecutive failures (threshold is 3)
    tracker.recordFailure("task-1", pipelineId);
    tracker.recordFailure("task-2", pipelineId);
    expect(tracker.shouldPause(pipelineId)).toBe(false);

    tracker.recordFailure("task-3", pipelineId);
    expect(tracker.shouldPause(pipelineId)).toBe(true);

    // Success resets the counter
    tracker.recordSuccess("task-4", pipelineId);
    expect(tracker.shouldPause(pipelineId)).toBe(false);
  });

  it("Redis fallback: enqueue to file when Redis unavailable", async () => {
    ctx.mockQueue.shouldThrowOnAdd = true;

    const goal = await ctx.director.createGoal(
      "Content with Redis down",
      "content",
      "P2",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    const result = await ctx.queueManager.enqueue(task);
    expect(result).toBe("fallback");

    // Job should NOT be in Redis queue
    expect(ctx.mockQueue.jobs.length).toBe(0);
  });
});
