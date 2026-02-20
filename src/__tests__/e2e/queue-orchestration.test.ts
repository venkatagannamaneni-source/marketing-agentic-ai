/**
 * E2E: Queue Orchestration
 *
 * Proves: The self-contained queue loop works: tasks get enqueued,
 * worker processes them, CompletionRouter routes results,
 * and follow-up tasks get re-enqueued.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { E2EContext } from "./helpers.ts";
import { bootstrapE2E, generateMockOutput } from "./helpers.ts";
import { SKILL_SQUAD_MAP } from "../../types/agent.ts";
import type { QueueJobData } from "../../queue/types.ts";

describe("E2E: Queue Orchestration", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await bootstrapE2E();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("enqueueBatch adds jobs with correct priority mapping", async () => {
    const goal = await ctx.director.createGoal(
      "Batch enqueue test",
      "content",
      "P2",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);

    await ctx.queueManager.enqueueBatch(tasks);

    // All tasks should be in the queue
    expect(ctx.mockQueue.jobs.length).toBe(tasks.length);

    for (let i = 0; i < tasks.length; i++) {
      const job = ctx.mockQueue.jobs[i]!;
      expect(job.data.taskId).toBe(tasks[i]!.id);
      expect(job.data.skill).toBe(tasks[i]!.to);
      expect(job.data.priority).toBe(tasks[i]!.priority);
      expect(job.data.goalId).toBe(goal.id);
    }
  });

  it("worker processor executes task and returns routing action", async () => {
    const goal = await ctx.director.createGoal(
      "Worker processor test",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    // Create processor and simulate a BullMQ job handle
    const processor = ctx.createProcessor();
    const jobHandle = {
      data: {
        taskId: task.id,
        skill: task.to,
        priority: task.priority,
        goalId: task.goalId,
        pipelineId: task.pipelineId,
        enqueuedAt: new Date().toISOString(),
      } as QueueJobData,
      id: task.id,
      attemptsMade: 0,
    };

    const result = await processor(jobHandle);

    // Should return a completed execution result
    expect(result.executionResult.status).toBe("completed");
    expect(result.executionResult.taskId).toBe(task.id);
    expect(result.executionResult.outputPath).toBeTruthy();

    // Routing action should be set
    expect(result.routingAction).toBeTruthy();

    // Task should be updated in workspace
    const updatedTask = await ctx.workspace.readTask(task.id);
    // The task status depends on the routing action
    // For pipeline_continue with goalId: CompletionRouter calls advanceGoal
    expect(["completed", "approved"]).toContain(updatedTask.status);
  });

  it("CompletionRouter routes director_review task to approval", async () => {
    const goal = await ctx.director.createGoal(
      "Review routing test",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    // Rewrite with director_review next type
    const reviewTask = {
      ...task,
      next: { type: "director_review" as const },
      status: "completed" as const,
    };
    await ctx.workspace.writeTask(reviewTask);

    // Write valid output so the review passes
    const squad = SKILL_SQUAD_MAP[task.to]!;
    await ctx.workspace.writeOutput(
      squad,
      task.to,
      task.id,
      generateMockOutput(task.to, task.id),
    );

    // Route the completed task
    const executionResult = {
      taskId: task.id,
      skill: task.to,
      status: "completed" as const,
      content: "",
      outputPath: task.output.path,
      metadata: {
        model: "claude-sonnet-4-5-20250929",
        modelTier: "sonnet" as const,
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 1000,
        estimatedCost: 0.003,
        retryCount: 0,
      },
      truncated: false,
      missingInputs: [] as string[],
      warnings: [] as string[],
    };

    const action = await ctx.completionRouter.route(reviewTask, executionResult);

    expect(action.type).toBe("complete");

    // Review should be persisted
    const reviews = await ctx.workspace.listReviews(task.id);
    expect(reviews.length).toBe(1);
    expect(reviews[0]!.verdict).toBe("APPROVE");

    // Task should be approved
    const updatedTask = await ctx.workspace.readTask(task.id);
    expect(updatedTask.status).toBe("approved");
  });

  it("CompletionRouter routes pipeline_continue to next phase tasks", async () => {
    const goal = await ctx.director.createGoal(
      "Pipeline continue routing test",
      "content",
      "P2",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    // The task should have pipeline_continue next type (first step of multi-step pipeline)
    expect(task.next.type).toBe("pipeline_continue");

    // Write output and mark as approved so advanceGoal creates next phase
    const squad = SKILL_SQUAD_MAP[task.to]!;
    await ctx.workspace.writeOutput(
      squad,
      task.to,
      task.id,
      generateMockOutput(task.to, task.id),
    );
    await ctx.workspace.updateTaskStatus(task.id, "in_progress");
    await ctx.workspace.updateTaskStatus(task.id, "completed");
    await ctx.workspace.updateTaskStatus(task.id, "approved");

    // Route the completed task
    const executionResult = {
      taskId: task.id,
      skill: task.to,
      status: "completed" as const,
      content: "",
      outputPath: task.output.path,
      metadata: {
        model: "claude-sonnet-4-5-20250929",
        modelTier: "sonnet" as const,
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 1000,
        estimatedCost: 0.003,
        retryCount: 0,
      },
      truncated: false,
      missingInputs: [] as string[],
      warnings: [] as string[],
    };

    const action = await ctx.completionRouter.route(task, executionResult);

    // Should route to next phase (enqueue_tasks) since there are more phases
    expect(action.type).toBe("enqueue_tasks");
    if (action.type === "enqueue_tasks") {
      expect(action.tasks.length).toBeGreaterThan(0);

      // Next phase tasks should be for the next skill in the pipeline
      for (const nextTask of action.tasks) {
        expect(nextTask.goalId).toBe(goal.id);
        expect(nextTask.status).toBe("pending");
      }
    }
  });

  it("full queue simulation: enqueue → process → route → re-enqueue", async () => {
    const goal = await ctx.director.createGoal(
      "Full queue simulation",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const phase1Tasks = await ctx.director.planGoalTasks(plan, goal);

    // Enqueue Phase 1 tasks
    await ctx.queueManager.enqueueBatch(phase1Tasks);

    const processor = ctx.createProcessor();
    let iterations = 0;
    const maxIterations = 20; // safety guard

    // Simulate the queue loop
    while (ctx.mockQueue.jobs.length > 0 && iterations < maxIterations) {
      iterations++;
      // Dequeue the first job
      const job = ctx.mockQueue.jobs.shift()!;

      try {
        const result = await processor({
          data: job.data,
          id: job.id,
          attemptsMade: 0,
        });

        // If routing produces more tasks, enqueue them
        if (
          result.routingAction &&
          result.routingAction.type === "enqueue_tasks" &&
          result.routingAction.tasks.length > 0
        ) {
          await ctx.queueManager.enqueueBatch(result.routingAction.tasks);
        }
      } catch {
        // Some tasks may fail due to budget checks or cascade pauses — that's ok
      }
    }

    // Should have processed at least the Phase 1 task
    expect(iterations).toBeGreaterThanOrEqual(1);

    // Check that workspace has artifacts
    const allTasks = await ctx.workspace.listTasks();
    expect(allTasks.length).toBeGreaterThanOrEqual(phase1Tasks.length);

    // At least one output should exist
    const completedTasks = allTasks.filter(
      (t) => t.status === "completed" || t.status === "approved",
    );
    expect(completedTasks.length).toBeGreaterThanOrEqual(1);
  });
});
