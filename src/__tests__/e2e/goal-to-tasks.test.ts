/**
 * E2E: Goal → Decomposition → Task Materialization
 *
 * Proves: Director creates goals, decomposes into phased plans,
 * materializes Phase 1 tasks with correct structure, and persists everything.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { E2EContext } from "./helpers.ts";
import { bootstrapE2E } from "./helpers.ts";

describe("E2E: Goal to Tasks", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await bootstrapE2E();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("creates goal, decomposes 'content' category, materializes Phase 1 tasks", async () => {
    // Create goal
    const goal = await ctx.director.createGoal(
      "Weekly blog content production",
      "content",
      "P2",
    );
    expect(goal.id).toMatch(/^goal-\d{8}-[0-9a-f]{6}$/);
    expect(goal.category).toBe("content");
    expect(goal.priority).toBe("P2");

    // Decompose
    const plan = ctx.director.decomposeGoal(goal);
    expect(plan.goalId).toBe(goal.id);
    expect(plan.pipelineTemplateName).toBe("Content Production");
    expect(plan.phases.length).toBeGreaterThanOrEqual(2);
    expect(plan.estimatedTaskCount).toBeGreaterThanOrEqual(3);

    // Phase 1 should be PLAN phase with content-strategy
    const phase1 = plan.phases[0]!;
    expect(phase1.skills).toContain("content-strategy");

    // Materialize Phase 1 tasks
    const tasks = await ctx.director.planGoalTasks(plan, goal);
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    const firstTask = tasks[0]!;
    expect(firstTask.to).toBe("content-strategy");
    expect(firstTask.status).toBe("pending");
    expect(firstTask.goalId).toBe(goal.id);
    expect(firstTask.pipelineId).toBeTruthy();

    // Non-last step should have pipeline_continue
    expect(firstTask.next.type).toBe("pipeline_continue");

    // Goal file persisted
    const readGoal = await ctx.director.readGoal(goal.id);
    expect(readGoal.description).toBe("Weekly blog content production");

    // Plan file persisted
    const planFile = await ctx.workspace.readFile(
      `goals/${goal.id}-plan.md`,
    );
    expect(planFile).toContain("Content Production");
  });

  it("decomposes 'optimization' category using Conversion Sprint template", async () => {
    const goal = await ctx.director.createGoal(
      "Increase signup conversion rate by 20%",
      "optimization",
      "P1",
    );

    const plan = ctx.director.decomposeGoal(goal);
    expect(plan.pipelineTemplateName).toBe("Conversion Sprint");
    expect(plan.phases.length).toBeGreaterThanOrEqual(2);

    // First phase should include page-cro
    const phase1 = plan.phases[0]!;
    expect(phase1.skills).toContain("page-cro");

    const tasks = await ctx.director.planGoalTasks(plan, goal);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0]!.to).toBe("page-cro");
    expect(tasks[0]!.priority).toBe("P1");
  });

  it("decomposes 'strategic' category with routing-based decomposition", async () => {
    const goal = await ctx.director.createGoal(
      "Define brand positioning and competitor analysis",
      "strategic",
      "P1",
    );

    const plan = ctx.director.decomposeGoal(goal);
    // Strategic goals don't use a pipeline template — they use routing
    expect(plan.pipelineTemplateName).toBeNull();
    expect(plan.phases.length).toBeGreaterThanOrEqual(2);

    // Strategy squad skills should appear
    const allSkills = plan.phases.flatMap((p) => p.skills);
    const hasStrategySkill = allSkills.some((s) =>
      [
        "content-strategy",
        "pricing-strategy",
        "launch-strategy",
        "marketing-ideas",
        "marketing-psychology",
        "competitor-alternatives",
      ].includes(s),
    );
    expect(hasStrategySkill).toBe(true);
  });

  it("persists all tasks to workspace and they can be read back", async () => {
    const goal = await ctx.director.createGoal(
      "Launch new pricing page",
      "content",
      "P2",
    );
    const plan = ctx.director.decomposeGoal(goal);
    const tasks = await ctx.director.planGoalTasks(plan, goal);

    // Every task should be readable from workspace
    for (const task of tasks) {
      const readTask = await ctx.workspace.readTask(task.id);
      expect(readTask.id).toBe(task.id);
      expect(readTask.to).toBe(task.to);
      expect(readTask.goalId).toBe(goal.id);
      expect(readTask.status).toBe("pending");
    }
  });
});
