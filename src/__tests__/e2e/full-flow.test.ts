/**
 * E2E: Full Flow — Capstone Tests
 *
 * Proves the Phase 1 deliverable:
 * "A working system where you give the Director a goal
 * and it orchestrates agents to deliver results."
 *
 * Two execution paths:
 * - Pipeline path: Goal → Director → PipelineEngine → Review → Complete
 * - Queue path: Goal → Director → enqueue → worker → route → re-enqueue → Complete
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { E2EContext } from "./helpers.ts";
import { bootstrapE2E, generateMockOutput } from "./helpers.ts";
import { SKILL_SQUAD_MAP } from "../../types/agent.ts";
import type { QueueJobData } from "../../queue/types.ts";

describe("E2E: Full Flow — Goal to Delivered Results", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await bootstrapE2E();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("CAPSTONE (pipeline path): goal → decompose → pipeline → review → complete", async () => {
    // 1. Director creates goal
    const goal = await ctx.director.createGoal(
      "Launch new pricing page with full content pipeline",
      "content",
      "P2",
    );

    // Goal persisted
    const readGoal = await ctx.director.readGoal(goal.id);
    expect(readGoal.description).toBe(goal.description);

    // 2. Director decomposes goal
    const plan = ctx.director.decomposeGoal(goal);
    expect(plan.phases.length).toBeGreaterThanOrEqual(2);
    expect(plan.estimatedTaskCount).toBeGreaterThanOrEqual(3);

    // Persist the plan (planGoalTasks writes the plan file + Phase 1 tasks)
    await ctx.director.planGoalTasks(plan, goal);

    // 3. Build pipeline and execute
    const definition = ctx.pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = ctx.pipelineFactory.createRun(definition, goal.id);

    const pipelineResult = await ctx.pipelineEngine.execute(
      definition,
      run,
      {
        goalDescription: goal.description,
        priority: goal.priority,
      },
    );

    expect(pipelineResult.status).toBe("completed");

    // All steps completed
    for (const stepResult of pipelineResult.stepResults) {
      expect(stepResult.status).toBe("completed");
    }

    // 4. Director reviews each completed task
    for (const taskId of run.taskIds) {
      const task = await ctx.workspace.readTask(taskId);
      if (task.status === "completed") {
        const decision = await ctx.director.reviewCompletedTask(taskId);
        expect(decision.review!.verdict).toBe("APPROVE");
      }
    }

    // 5. Verify workspace state

    // Goal file exists
    const goalFile = await ctx.workspace.readFile(`goals/${goal.id}.md`);
    expect(goalFile).toContain(goal.id);

    // Plan file exists
    const planFile = await ctx.workspace.readFile(
      `goals/${goal.id}-plan.md`,
    );
    expect(planFile).toContain(plan.pipelineTemplateName ?? "");

    // All tasks exist in workspace
    const allTasks = await ctx.workspace.listTasks();
    const goalTasks = allTasks.filter((t) => t.goalId === goal.id);
    expect(goalTasks.length).toBeGreaterThanOrEqual(definition.steps.length);

    // All outputs exist
    for (const taskId of run.taskIds) {
      const task = await ctx.workspace.readTask(taskId);
      const squad = SKILL_SQUAD_MAP[task.to];
      if (squad) {
        const output = await ctx.workspace.readOutput(
          squad,
          task.to,
          taskId,
        );
        expect(output.length).toBeGreaterThan(0);
      }
    }

    // Reviews exist for reviewed tasks
    for (const taskId of run.taskIds) {
      const reviews = await ctx.workspace.listReviews(taskId);
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      expect(reviews[0]!.verdict).toBe("APPROVE");
    }

    // Learnings accumulated
    const learnings = await ctx.workspace.readFile("memory/learnings.md");
    expect(learnings.length).toBeGreaterThan(0);

    // Pipeline run metadata
    expect(run.status).toBe("completed");
    expect(run.completedAt).toBeTruthy();
    expect(run.taskIds.length).toBe(definition.steps.length);
    expect(pipelineResult.totalTokensUsed.total).toBeGreaterThan(0);
  });

  it("CAPSTONE (queue path): goal → enqueue → worker sim → route → complete", async () => {
    // Use optimization category for a shorter pipeline
    const goal = await ctx.director.createGoal(
      "Increase signup conversion by 20%",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const phase1Tasks = await ctx.director.planGoalTasks(plan, goal);

    expect(phase1Tasks.length).toBeGreaterThanOrEqual(1);

    // Enqueue Phase 1 tasks
    await ctx.queueManager.enqueueBatch(phase1Tasks);
    expect(ctx.mockQueue.jobs.length).toBe(phase1Tasks.length);

    const processor = ctx.createProcessor();
    let iterations = 0;
    const maxIterations = 30;
    let totalTasksProcessed = 0;

    // Run the self-contained queue loop
    while (ctx.mockQueue.jobs.length > 0 && iterations < maxIterations) {
      iterations++;
      const job = ctx.mockQueue.jobs.shift()!;

      try {
        const result = await processor({
          data: job.data,
          id: job.id,
          attemptsMade: 0,
        });
        totalTasksProcessed++;

        // Re-enqueue follow-up tasks
        if (
          result.routingAction?.type === "enqueue_tasks" &&
          result.routingAction.tasks.length > 0
        ) {
          await ctx.queueManager.enqueueBatch(result.routingAction.tasks);
        }
      } catch {
        // Budget checks, cascade pauses, or other expected failures
      }
    }

    // Verify we processed multiple tasks (at least Phase 1)
    expect(totalTasksProcessed).toBeGreaterThanOrEqual(1);

    // Verify workspace state
    const allTasks = await ctx.workspace.listTasks();
    const goalTasks = allTasks.filter((t) => t.goalId === goal.id);
    expect(goalTasks.length).toBeGreaterThanOrEqual(phase1Tasks.length);

    // Verify at least some tasks reached terminal states
    const terminalTasks = goalTasks.filter(
      (t) =>
        t.status === "completed" ||
        t.status === "approved" ||
        t.status === "failed",
    );
    expect(terminalTasks.length).toBeGreaterThanOrEqual(1);

    // Goal file persisted
    const readGoal = await ctx.director.readGoal(goal.id);
    expect(readGoal.id).toBe(goal.id);
  });

  it("validates output content written to correct workspace paths", async () => {
    const goal = await ctx.director.createGoal(
      "Content for path validation",
      "content",
      "P2",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const definition = ctx.pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = ctx.pipelineFactory.createRun(definition, goal.id);

    await ctx.pipelineEngine.execute(definition, run, {
      goalDescription: goal.description,
      priority: goal.priority,
    });

    // Each task should have output at the correct squad/skill path
    for (const taskId of run.taskIds) {
      const task = await ctx.workspace.readTask(taskId);
      const squad = SKILL_SQUAD_MAP[task.to];

      if (squad) {
        // Output should be readable via workspace
        const output = await ctx.workspace.readOutput(
          squad,
          task.to,
          taskId,
        );
        expect(output).toBeTruthy();
        expect(output.length).toBeGreaterThan(100);

        // Output path should follow convention: outputs/{squad}/{skill}/{taskId}.md
        expect(task.output.path).toContain(`outputs/${squad}/${task.to}/`);
        expect(task.output.path).toContain(taskId);
      }
    }
  });
});
