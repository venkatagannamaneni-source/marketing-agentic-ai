/**
 * E2E: Director Review Decisions
 *
 * Proves: Director review evaluates output quality, makes correct
 * approve/revise/escalate decisions, and applies all side effects
 * (status update, review persisted, learning appended, follow-up tasks).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { E2EContext } from "./helpers.ts";
import { bootstrapE2E, generateMockOutput } from "./helpers.ts";
import { SKILL_SQUAD_MAP } from "../../types/agent.ts";

describe("E2E: Director Review", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await bootstrapE2E();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("approves good output and writes review + learning", async () => {
    // Create goal and task — use director_review as next type so the action
    // is "goal_complete" (which generates a learning), not "pipeline_next".
    const goal = await ctx.director.createGoal(
      "Improve signup page",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    // Rewrite the task with next: director_review to trigger goal_complete path
    const taskWithReview = {
      ...task,
      next: { type: "director_review" as const },
    };
    await ctx.workspace.writeTask(taskWithReview);

    // Write valid output for the task
    const squad = SKILL_SQUAD_MAP[task.to]!;
    await ctx.workspace.writeOutput(
      squad,
      task.to,
      task.id,
      generateMockOutput(task.to, task.id),
    );

    // Mark task as completed (review expects completed status)
    await ctx.workspace.updateTaskStatus(task.id, "completed");

    // Review
    const decision = await ctx.director.reviewCompletedTask(task.id);

    // Should approve with goal_complete action (triggers learning)
    expect(decision.review!.verdict).toBe("APPROVE");
    expect(decision.action).toBe("goal_complete");

    // Review persisted
    const reviews = await ctx.workspace.listReviews(task.id);
    expect(reviews.length).toBe(1);
    expect(reviews[0]!.verdict).toBe("APPROVE");

    // Learning appended
    expect(decision.learning).not.toBeNull();
    const learnings = await ctx.workspace.readFile("memory/learnings.md");
    expect(learnings).toContain(task.id);

    // Task status updated
    const updatedTask = await ctx.workspace.readTask(task.id);
    expect(updatedTask.status).toBe("approved");
  });

  it("requests revision for short output", async () => {
    const goal = await ctx.director.createGoal(
      "Improve signup page",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    // Write short output (>0 but <100 chars → major finding → REVISE)
    const squad = SKILL_SQUAD_MAP[task.to]!;
    await ctx.workspace.writeOutput(
      squad,
      task.to,
      task.id,
      "Short output that is clearly insufficient for a real marketing deliverable.",
    );
    await ctx.workspace.updateTaskStatus(task.id, "completed");

    const decision = await ctx.director.reviewCompletedTask(task.id);

    expect(decision.action).toBe("revise");
    expect(decision.review!.verdict).toBe("REVISE");
    expect(decision.nextTasks.length).toBe(1);

    // Revision task has incremented revisionCount
    const revisionTask = decision.nextTasks[0]!;
    expect(revisionTask.revisionCount).toBe(1);
    expect(revisionTask.requirements).toContain("REVISION REQUESTED");
    expect(revisionTask.to).toBe(task.to);

    // Revision task written to workspace
    const readRevision = await ctx.workspace.readTask(revisionTask.id);
    expect(readRevision.revisionCount).toBe(1);
  });

  it("rejects empty output", async () => {
    const goal = await ctx.director.createGoal(
      "Improve signup page",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    // Write empty output → critical finding → REJECT
    const squad = SKILL_SQUAD_MAP[task.to]!;
    await ctx.workspace.writeOutput(squad, task.to, task.id, "");
    await ctx.workspace.updateTaskStatus(task.id, "completed");

    const decision = await ctx.director.reviewCompletedTask(task.id);

    expect(decision.action).toBe("reject_reassign");
    expect(decision.review!.verdict).toBe("REJECT");
    expect(
      decision.review!.findings.some(
        (f) => f.severity === "critical" && f.description.includes("empty"),
      ),
    ).toBe(true);
  });

  it("escalates after max revisions exceeded", async () => {
    const goal = await ctx.director.createGoal(
      "Improve signup page",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    // Manually create a task with high revisionCount to simulate revision loop
    const { generateTaskId } = await import("../../workspace/id.ts");
    const revisedTaskId = generateTaskId(task.to);
    const revisedTask = {
      ...task,
      id: revisedTaskId,
      revisionCount: 3, // equals default maxRevisionsPerTask
      output: {
        path: `outputs/${SKILL_SQUAD_MAP[task.to]}/${task.to}/${revisedTaskId}.md`,
        format: "markdown",
      },
    };
    await ctx.workspace.writeTask(revisedTask);

    // Write short output so it gets REVISE verdict → but revisionCount >= max → escalate
    const squad = SKILL_SQUAD_MAP[task.to]!;
    await ctx.workspace.writeOutput(
      squad,
      task.to,
      revisedTaskId,
      "Short output that needs more work but has been revised too many times.",
    );
    await ctx.workspace.updateTaskStatus(revisedTaskId, "completed");

    const decision = await ctx.director.reviewCompletedTask(revisedTaskId);

    expect(decision.action).toBe("escalate_human");
    expect(decision.escalation).not.toBeNull();
    expect(decision.escalation!.reason).toBe("agent_loop_detected");

    // Task status should be blocked
    const updatedTask = await ctx.workspace.readTask(revisedTaskId);
    expect(updatedTask.status).toBe("blocked");
  });

  it("executeAndReviewTask runs execution + semantic review end-to-end", async () => {
    // Need a special mock: call 1 (execution) returns real output,
    // call 2 (semantic review) returns "[]" (no findings → APPROVE).
    const mockOutput = generateMockOutput("page-cro", "test-exec-task");
    ctx = await bootstrapE2E({
      directorClientHandler: (_params, callIndex) => {
        if (callIndex === 0) {
          // Execution call — return valid marketing output
          return { content: mockOutput };
        }
        // Semantic review call — return empty findings
        return { content: "[]" };
      },
    });
    // Re-cleanup the old context (afterEach handles the new one)

    const goal = await ctx.director.createGoal(
      "Improve signup page",
      "optimization",
      "P1",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    const task = tasks[0]!;

    // Rewrite task with director_review so approval generates learning
    const taskWithReview = {
      ...task,
      next: { type: "director_review" as const },
    };
    await ctx.workspace.writeTask(taskWithReview);

    // executeAndReviewTask: Director executes the task using AgentExecutor
    // (from src/agents/executor.ts) and reviews via Claude Opus mock
    const result = await ctx.director.executeAndReviewTask(task.id);

    // Execution should have succeeded
    expect(result.execution.content).toBeTruthy();
    expect(result.execution.content.length).toBeGreaterThan(0);

    // Director client was called twice: execution + semantic review
    expect(ctx.directorClient.calls.length).toBe(2);

    // Cost tracking: total cost includes execution + review
    expect(result.totalCost).toBeGreaterThan(0);

    // Decision should be approve (mock returns "[]" → no findings)
    expect(result.decision.review!.verdict).toBe("APPROVE");
    expect(result.decision.action).toBe("goal_complete");

    // Task is approved in workspace
    const updatedTask = await ctx.workspace.readTask(task.id);
    expect(updatedTask.status).toBe("approved");

    // Output was written to workspace
    const squad = SKILL_SQUAD_MAP[task.to]!;
    const output = await ctx.workspace.readOutput(squad, task.to, task.id);
    expect(output.length).toBeGreaterThan(0);

    // Learning was appended
    const learnings = await ctx.workspace.readFile("memory/learnings.md");
    expect(learnings).toContain(task.id);
  });
});
