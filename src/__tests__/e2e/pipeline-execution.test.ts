/**
 * E2E: Pipeline Execution
 *
 * Proves: SequentialPipelineEngine executes multi-step pipelines,
 * wires outputs between steps, handles parallel steps, and pauses
 * at review steps for Director intervention.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { E2EContext } from "./helpers.ts";
import { bootstrapE2E, generateMockOutput } from "./helpers.ts";

describe("E2E: Pipeline Execution", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await bootstrapE2E();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("executes Content Production pipeline end-to-end", async () => {
    const goal = await ctx.director.createGoal(
      "Weekly blog content production",
      "content",
      "P2",
    );
    const plan = ctx.director.decomposeGoal(goal);
    expect(plan.pipelineTemplateName).toBe("Content Production");

    const definition = ctx.pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = ctx.pipelineFactory.createRun(definition, goal.id);

    const result = await ctx.pipelineEngine.execute(definition, run, {
      goalDescription: goal.description,
      priority: goal.priority,
    });

    // Pipeline should complete
    expect(result.status).toBe("completed");
    expect(result.stepResults.length).toBe(definition.steps.length);

    // All steps completed
    for (const stepResult of result.stepResults) {
      expect(stepResult.status).toBe("completed");
    }

    // Pipeline client was called once per step
    expect(ctx.pipelineClient.calls.length).toBe(definition.steps.length);

    // Run metadata
    expect(run.status).toBe("completed");
    expect(run.completedAt).toBeTruthy();
    expect(run.taskIds.length).toBe(definition.steps.length);

    // Token tracking
    expect(result.totalTokensUsed.total).toBeGreaterThan(0);
  });

  it("executes Product Launch pipeline with parallel step", async () => {
    // Product Launch: [launch-strategy] → [copywriting, email-sequence, social-content, paid-ads]
    const goal = await ctx.director.createGoal(
      "Launch new pricing feature",
      "content",
      "P1",
    );
    const template = ctx.pipelineFactory.findTemplate("Product Launch");
    expect(template).toBeTruthy();

    const { definition, run } = ctx.pipelineFactory.instantiate(
      "Product Launch",
      goal.description,
      goal.id,
      goal.priority,
    );

    const result = await ctx.pipelineEngine.execute(definition, run, {
      goalDescription: goal.description,
      priority: goal.priority,
    });

    expect(result.status).toBe("completed");
    expect(result.stepResults.length).toBe(2);

    // Step 0: sequential (launch-strategy)
    const step0 = result.stepResults[0]!;
    expect(step0.status).toBe("completed");
    expect(step0.tasks.length).toBe(1);
    expect(step0.tasks[0]!.to).toBe("launch-strategy");

    // Step 1: parallel (4 skills)
    const step1 = result.stepResults[1]!;
    expect(step1.status).toBe("completed");
    expect(step1.tasks.length).toBe(4);

    const parallelSkills = step1.tasks.map((t) => t.to as string).sort();
    expect(parallelSkills).toEqual(
      ["copywriting", "email-sequence", "paid-ads", "social-content"].sort(),
    );

    // Total calls = 1 (sequential) + 4 (parallel) = 5
    expect(ctx.pipelineClient.calls.length).toBe(5);

    // All tasks persisted
    for (const taskId of run.taskIds) {
      const task = await ctx.workspace.readTask(taskId);
      expect(task.status).toBe("completed");
    }
  });

  it("wires upstream outputs from step N to step N+1", async () => {
    // Track what each pipeline call receives as user message
    const receivedMessages: string[] = [];
    ctx = await bootstrapE2E({
      pipelineClientGenerator: (params) => {
        receivedMessages.push(
          typeof params.messages[0]?.content === 'string' ? params.messages[0].content : '',
        );
        return {
          content: generateMockOutput("agent", "task"),
        };
      },
    });

    const goal = await ctx.director.createGoal(
      "Content pipeline",
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

    // Step 1+ should reference upstream output in their user messages
    // (the prompt builder includes "Output from previous pipeline step")
    if (receivedMessages.length > 1) {
      for (let i = 1; i < receivedMessages.length; i++) {
        // The pipeline engine passes upstream outputs as task inputs,
        // and the prompt builder includes them in the user message
        expect(receivedMessages[i]!.length).toBeGreaterThan(0);
      }
    }

    // More importantly: the step results should show output wiring
    // Each step after the first should have outputs from the previous step as inputs
    const allTasks = await ctx.workspace.listTasks();
    const pipelineTasks = allTasks.filter((t) =>
      run.taskIds.includes(t.id),
    );

    // First task should have no upstream task inputs (only product-marketing-context)
    const firstTask = pipelineTasks.find(
      (t) => t.id === run.taskIds[0],
    );
    expect(firstTask).toBeTruthy();

    // Subsequent tasks should reference prior step's output path
    if (pipelineTasks.length > 1) {
      const secondTask = pipelineTasks.find(
        (t) => t.id === run.taskIds[1],
      );
      if (secondTask) {
        const hasUpstreamInput = secondTask.inputs.some(
          (inp) =>
            inp.path.includes("outputs/") &&
            inp.description.includes("Output from previous pipeline step"),
        );
        expect(hasUpstreamInput).toBe(true);
      }
    }
  });

  it("pauses at review step and can resume", async () => {
    // Create a review step definition manually
    const { definition, run } = ctx.pipelineFactory.instantiate(
      "Content Production",
      "Test content with review",
      null,
      "P2",
    );

    // Insert a review step after step 0
    const reviewStep = {
      type: "review" as const,
      reviewer: "director" as const,
    };

    // Build a definition with review step: [step0, review, step1, step2...]
    const modifiedSteps = [
      definition.steps[0]!,
      reviewStep,
      ...definition.steps.slice(1),
    ] as const;
    const modifiedDefinition = {
      ...definition,
      steps: modifiedSteps,
    };

    // First execution: should pause at review step
    const result1 = await ctx.pipelineEngine.execute(
      modifiedDefinition,
      run,
      {
        goalDescription: "Test content with review",
        priority: "P2",
      },
    );

    expect(result1.status).toBe("paused");
    expect(run.status).toBe("paused");
    // Step 0 completed, step 1 (review) paused
    expect(result1.stepResults.length).toBe(2);
    expect(result1.stepResults[0]!.status).toBe("completed");
    expect(result1.stepResults[1]!.status).toBe("paused");

    // Get output paths from completed step for resume
    const outputPaths = result1.stepResults[0]!.outputPaths;

    // Resume from paused state
    const result2 = await ctx.pipelineEngine.execute(
      modifiedDefinition,
      run,
      {
        goalDescription: "Test content with review",
        priority: "P2",
        initialInputPaths: outputPaths,
      },
    );

    expect(result2.status).toBe("completed");
    expect(run.status).toBe("completed");
    expect(run.completedAt).toBeTruthy();
  });
});
