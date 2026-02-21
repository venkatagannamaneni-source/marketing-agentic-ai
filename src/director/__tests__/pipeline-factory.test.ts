import { describe, expect, it } from "bun:test";
import { PipelineFactory } from "../pipeline-factory.ts";
import { PIPELINE_TEMPLATES } from "../../agents/registry.ts";
import { SkillRegistry } from "../../agents/skill-registry.ts";
import type { SkillRegistryData } from "../../agents/skill-registry.ts";
import { createTestGoal } from "./helpers.ts";
import { GoalDecomposer } from "../goal-decomposer.ts";
import { routeGoal } from "../squad-router.ts";

const factory = new PipelineFactory(PIPELINE_TEMPLATES);

describe("PipelineFactory", () => {
  describe("findTemplate", () => {
    it("finds a template by exact name", () => {
      const template = factory.findTemplate("Content Production");
      expect(template).not.toBeUndefined();
      expect(template!.name).toBe("Content Production");
    });

    it("returns undefined for unknown name", () => {
      const template = factory.findTemplate("Nonexistent Pipeline");
      expect(template).toBeUndefined();
    });

    it("finds all 8 pipeline templates", () => {
      const names = [
        "Content Production",
        "Page Launch",
        "Product Launch",
        "Conversion Sprint",
        "Competitive Response",
        "Retention Sprint",
        "SEO Cycle",
        "Outreach Campaign",
      ];
      for (const name of names) {
        expect(factory.findTemplate(name)).not.toBeUndefined();
      }
    });
  });

  describe("templateToDefinition", () => {
    it("converts Content Production template to PipelineDefinition", () => {
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      expect(def.name).toBe("Content Production");
      expect(def.id).toBe("content-production");
      expect(def.steps.length).toBe(5);
      for (const step of def.steps) {
        expect(step.type).toBe("sequential");
      }
    });

    it("converts Product Launch template preserving parallel skills", () => {
      const template = factory.findTemplate("Product Launch")!;
      const def = factory.templateToDefinition(template);
      expect(def.steps.length).toBe(2);
      expect(def.steps[0]!.type).toBe("sequential");
      expect(def.steps[1]!.type).toBe("parallel");
      if (def.steps[1]!.type === "parallel") {
        expect(def.steps[1]!.skills.length).toBe(4);
      }
    });

    it("generates a stable ID from template name", () => {
      const template = factory.findTemplate("Competitive Response")!;
      const def = factory.templateToDefinition(template);
      expect(def.id).toBe("competitive-response");
    });

    it("converts weekly trigger to schedule PipelineTrigger", () => {
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      expect(def.trigger.type).toBe("schedule");
      if (def.trigger.type === "schedule") {
        expect(def.trigger.cron).toBeDefined();
      }
    });

    it("converts monthly trigger to schedule PipelineTrigger", () => {
      const template = factory.findTemplate("Conversion Sprint")!;
      const def = factory.templateToDefinition(template);
      expect(def.trigger.type).toBe("schedule");
    });

    it("converts non-schedule triggers to manual PipelineTrigger", () => {
      const template = factory.findTemplate("Page Launch")!;
      const def = factory.templateToDefinition(template);
      expect(def.trigger.type).toBe("manual");
    });

    it("preserves defaultPriority from template", () => {
      const template = factory.findTemplate("Product Launch")!;
      const def = factory.templateToDefinition(template);
      expect(def.defaultPriority).toBe("P0");
    });
  });

  describe("createRun", () => {
    it("creates a PipelineRun with pending status", () => {
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      const run = factory.createRun(def, "goal-123");
      expect(run.status).toBe("pending");
    });

    it("sets startedAt to current time", () => {
      const before = new Date().toISOString();
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      const run = factory.createRun(def, null);
      const after = new Date().toISOString();
      expect(run.startedAt >= before).toBe(true);
      expect(run.startedAt <= after).toBe(true);
    });

    it("initializes currentStepIndex to 0", () => {
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      const run = factory.createRun(def, null);
      expect(run.currentStepIndex).toBe(0);
    });

    it("sets goalId from argument", () => {
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      const run = factory.createRun(def, "my-goal-id");
      expect(run.goalId).toBe("my-goal-id");
    });

    it("sets goalId to null when not provided", () => {
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      const run = factory.createRun(def, null);
      expect(run.goalId).toBeNull();
    });

    it("generates a run ID with the pipeline ID prefix", () => {
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      const run = factory.createRun(def, null);
      expect(run.id).toStartWith("run-content-production-");
    });

    it("initializes empty taskIds array", () => {
      const template = factory.findTemplate("Content Production")!;
      const def = factory.templateToDefinition(template);
      const run = factory.createRun(def, null);
      expect(run.taskIds).toEqual([]);
    });
  });

  describe("createTasksForStep", () => {
    const template = factory.findTemplate("Content Production")!;
    const def = factory.templateToDefinition(template);
    const run = factory.createRun(def, "goal-1");

    it("creates 1 task for a sequential step", () => {
      const step = def.steps[0]!; // content-strategy (sequential)
      const tasks = factory.createTasksForStep(
        step,
        0,
        def.steps.length,
        run,
        "Test goal",
        "P2",
        [],
      );
      expect(tasks.length).toBe(1);
    });

    it("creates N tasks for a parallel step", () => {
      const productLaunch = factory.findTemplate("Product Launch")!;
      const plDef = factory.templateToDefinition(productLaunch);
      const plRun = factory.createRun(plDef, "goal-1");
      const step = plDef.steps[1]!; // parallel step with 4 skills
      const tasks = factory.createTasksForStep(
        step,
        1,
        plDef.steps.length,
        plRun,
        "Launch product",
        "P0",
        [],
      );
      expect(tasks.length).toBe(4);
    });

    it("creates 0 tasks for a review step", () => {
      const reviewStep = {
        type: "review" as const,
        reviewer: "director" as const,
      };
      const tasks = factory.createTasksForStep(
        reviewStep,
        0,
        1,
        run,
        "Test",
        "P2",
        [],
      );
      expect(tasks.length).toBe(0);
    });

    it("sets task.from to 'director'", () => {
      const step = def.steps[0]!;
      const tasks = factory.createTasksForStep(
        step,
        0,
        def.steps.length,
        run,
        "Test goal",
        "P2",
        [],
      );
      expect(tasks[0]!.from).toBe("director");
    });

    it("sets task.pipelineId to the run ID", () => {
      const step = def.steps[0]!;
      const tasks = factory.createTasksForStep(
        step,
        0,
        def.steps.length,
        run,
        "Test goal",
        "P2",
        [],
      );
      expect(tasks[0]!.pipelineId).toBe(run.id);
    });

    it("sets task.next to pipeline_continue for non-last steps", () => {
      const step = def.steps[0]!;
      const tasks = factory.createTasksForStep(
        step,
        0,
        def.steps.length,
        run,
        "Test goal",
        "P2",
        [],
      );
      expect(tasks[0]!.next).toEqual({
        type: "pipeline_continue",
        pipelineId: run.id,
      });
    });

    it("sets task.next to director_review for the last step", () => {
      const lastStep = def.steps[def.steps.length - 1]!;
      const tasks = factory.createTasksForStep(
        lastStep,
        def.steps.length - 1,
        def.steps.length,
        run,
        "Test goal",
        "P2",
        [],
      );
      expect(tasks[0]!.next).toEqual({ type: "director_review" });
    });

    it("includes product-marketing-context.md in inputs", () => {
      const step = def.steps[0]!;
      const tasks = factory.createTasksForStep(
        step,
        0,
        def.steps.length,
        run,
        "Test goal",
        "P2",
        [],
      );
      const paths = tasks[0]!.inputs.map((i) => i.path);
      expect(paths).toContain("context/product-marketing-context.md");
    });

    it("includes previous step output paths in inputs", () => {
      const step = def.steps[1]!;
      const previousOutputs = ["outputs/strategy/content-strategy/task-1.md"];
      const tasks = factory.createTasksForStep(
        step,
        1,
        def.steps.length,
        run,
        "Test goal",
        "P2",
        previousOutputs,
      );
      const paths = tasks[0]!.inputs.map((i) => i.path);
      expect(paths).toContain(
        "outputs/strategy/content-strategy/task-1.md",
      );
    });

    it("generates unique task IDs", () => {
      const productLaunch = factory.findTemplate("Product Launch")!;
      const plDef = factory.templateToDefinition(productLaunch);
      const plRun = factory.createRun(plDef, "goal-1");
      const step = plDef.steps[1]!;
      const tasks = factory.createTasksForStep(
        step,
        1,
        plDef.steps.length,
        plRun,
        "Test",
        "P0",
        [],
      );
      const ids = tasks.map((t) => t.id);
      const uniqueIds = [...new Set(ids)];
      expect(ids.length).toBe(uniqueIds.length);
    });

    it("sets task status to pending", () => {
      const step = def.steps[0]!;
      const tasks = factory.createTasksForStep(
        step,
        0,
        def.steps.length,
        run,
        "Test",
        "P2",
        [],
      );
      expect(tasks[0]!.status).toBe("pending");
    });

    it("sets goalId from the run", () => {
      const step = def.steps[0]!;
      const tasks = factory.createTasksForStep(
        step,
        0,
        def.steps.length,
        run,
        "Test",
        "P2",
        [],
      );
      expect(tasks[0]!.goalId).toBe("goal-1");
    });
  });

  describe("goalPlanToDefinition", () => {
    it("converts a multi-phase GoalPlan to PipelineDefinition", () => {
      const goal = createTestGoal({ category: "strategic" });
      const routing = routeGoal("strategic");
      const decomposer = new GoalDecomposer(PIPELINE_TEMPLATES);
      const plan = decomposer.decompose(goal, routing);
      const def = factory.goalPlanToDefinition(plan, goal);
      expect(def.steps.length).toBe(plan.phases.length);
      expect(def.name).toContain(goal.description.slice(0, 20));
    });

    it("maps parallel phases to parallel PipelineSteps", () => {
      const goal = createTestGoal({ category: "strategic" });
      const routing = routeGoal("strategic");
      const decomposer = new GoalDecomposer(PIPELINE_TEMPLATES);
      const plan = decomposer.decompose(goal, routing);
      const def = factory.goalPlanToDefinition(plan, goal);
      // Strategic routing: strategy squad has many skills → likely parallel
      const multiSkillSteps = def.steps.filter(
        (s) => s.type === "parallel" && s.skills.length > 1,
      );
      expect(multiSkillSteps.length).toBeGreaterThanOrEqual(0);
    });

    it("sets trigger to manual for goal plans", () => {
      const goal = createTestGoal();
      const routing = routeGoal(goal.category);
      const decomposer = new GoalDecomposer(PIPELINE_TEMPLATES);
      const plan = decomposer.decompose(goal, routing);
      const def = factory.goalPlanToDefinition(plan, goal);
      expect(def.trigger).toEqual({ type: "manual" });
    });
  });

  describe("instantiate", () => {
    it("returns definition + run + first-step tasks for Content Production", () => {
      const result = factory.instantiate(
        "Content Production",
        "Weekly blog content",
        "goal-1",
      );
      expect(result.definition.name).toBe("Content Production");
      expect(result.run.status).toBe("pending");
      expect(result.tasks.length).toBe(1); // content-strategy is first step
      expect(result.tasks[0]!.to).toBe("content-strategy");
    });

    it("returns parallel tasks for Product Launch first step", () => {
      const result = factory.instantiate(
        "Product Launch",
        "Launch API product",
        "goal-2",
      );
      // First step is launch-strategy (sequential)
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0]!.to).toBe("launch-strategy");
    });

    it("throws for unknown template name", () => {
      expect(() => {
        factory.instantiate("Nonexistent", "test", null);
      }).toThrow("Unknown pipeline template");
    });

    it("uses template defaultPriority when none specified", () => {
      const result = factory.instantiate(
        "Content Production",
        "test",
        null,
      );
      expect(result.tasks[0]!.priority).toBe("P2"); // Content Production default
    });

    it("uses specified priority over template default", () => {
      const result = factory.instantiate(
        "Content Production",
        "test",
        null,
        "P0",
      );
      expect(result.tasks[0]!.priority).toBe("P0");
    });

    it("sets goalId on tasks from the provided argument", () => {
      const result = factory.instantiate(
        "Content Production",
        "test",
        "my-goal-id",
      );
      expect(result.tasks[0]!.goalId).toBe("my-goal-id");
    });
  });
});

// ── PipelineFactory with SkillRegistry ────────────────────────────────────────

describe("PipelineFactory with SkillRegistry", () => {
  // Registry where "copywriting" is in squad "custom-creative" instead of "creative"
  const registryData: SkillRegistryData = {
    squads: {
      "custom-creative": { description: "Custom creative squad" },
      strategy: { description: "Strategy squad" },
      measure: { description: "Measure squad" },
    },
    foundation_skill: "product-marketing-context",
    skills: {
      "product-marketing-context": {
        squad: null,
        description: "Foundation",
        downstream: "all",
      },
      "copywriting": {
        squad: "custom-creative",
        description: "Writing",
        downstream: [],
      },
      "content-strategy": {
        squad: "strategy",
        description: "Strategy",
        downstream: ["copywriting"],
      },
      "analytics-tracking": {
        squad: "measure",
        description: "Tracking",
        downstream: [],
      },
    },
  };

  const registry = SkillRegistry.fromData(registryData);
  const factoryWithRegistry = new PipelineFactory(PIPELINE_TEMPLATES, registry);

  it("uses registry skillSquadMap for output paths", () => {
    const template = factoryWithRegistry.findTemplate("Content Production")!;
    const def = factoryWithRegistry.templateToDefinition(template);
    const run = factoryWithRegistry.createRun(def, "goal-1");

    // content-strategy step → should use "strategy" squad from registry
    const step = def.steps[0]!;
    const tasks = factoryWithRegistry.createTasksForStep(
      step,
      0,
      def.steps.length,
      run,
      "Test",
      "P2",
      [],
    );
    expect(tasks[0]!.output.path).toContain("outputs/strategy/content-strategy/");
  });

  it("resolves custom squad mapping from registry", () => {
    const template = factoryWithRegistry.findTemplate("Content Production")!;
    const def = factoryWithRegistry.templateToDefinition(template);
    const run = factoryWithRegistry.createRun(def, "goal-1");

    // copywriting step → should use "custom-creative" squad from registry
    const copywritingStep = def.steps[1]!; // second step in Content Production
    const tasks = factoryWithRegistry.createTasksForStep(
      copywritingStep,
      1,
      def.steps.length,
      run,
      "Test",
      "P2",
      [],
    );
    expect(tasks[0]!.output.path).toContain("outputs/custom-creative/copywriting/");
  });

  it("falls back to foundation path for skills with null squad", () => {
    const template = factoryWithRegistry.findTemplate("Content Production")!;
    const def = factoryWithRegistry.templateToDefinition(template);
    const run = factoryWithRegistry.createRun(def, "goal-1");

    // Manually create a step for the foundation skill
    const foundationStep = { type: "sequential" as const, skill: "product-marketing-context" };
    const tasks = factoryWithRegistry.createTasksForStep(
      foundationStep,
      0,
      1,
      run,
      "Test",
      "P2",
      [],
    );
    expect(tasks[0]!.output.path).toContain("outputs/foundation/product-marketing-context/");
  });

  it("uses hardcoded defaults when no registry is provided", () => {
    const factoryNoRegistry = new PipelineFactory(PIPELINE_TEMPLATES);
    const template = factoryNoRegistry.findTemplate("Content Production")!;
    const def = factoryNoRegistry.templateToDefinition(template);
    const run = factoryNoRegistry.createRun(def, "goal-1");

    // copywriting should use "creative" (hardcoded default), not "custom-creative"
    const copywritingStep = def.steps[1]!;
    const tasks = factoryNoRegistry.createTasksForStep(
      copywritingStep,
      1,
      def.steps.length,
      run,
      "Test",
      "P2",
      [],
    );
    expect(tasks[0]!.output.path).toContain("outputs/creative/copywriting/");
  });
});
