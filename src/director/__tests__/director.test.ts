import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { MarketingDirector, generateGoalId } from "../director.ts";
import { DIRECTOR_SYSTEM_PROMPT } from "../system-prompt.ts";
import { SKILL_NAMES, SQUAD_NAMES } from "../../types/agent.ts";
import { SkillRegistry } from "../../agents/skill-registry.ts";
import type { SkillRegistryData } from "../../agents/skill-registry.ts";
import { GOAL_CATEGORIES } from "../types.ts";
import type { GoalCategory } from "../types.ts";
import {
  createTestWorkspace,
  createTestTask,
  createTestOutput,
  type TestWorkspace,
} from "./helpers.ts";

let tw: TestWorkspace;
let director: MarketingDirector;

beforeEach(async () => {
  tw = await createTestWorkspace();
  director = new MarketingDirector(tw.workspace);
});

afterEach(async () => {
  await tw.cleanup();
});

describe("generateGoalId", () => {
  it("generates an ID with goal prefix", () => {
    const id = generateGoalId();
    expect(id).toStartWith("goal-");
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateGoalId()));
    expect(ids.size).toBe(10);
  });

  it("contains a date segment", () => {
    const id = generateGoalId();
    // Format: goal-YYYYMMDD-hex
    const parts = id.split("-");
    expect(parts.length).toBe(3);
    expect(parts[1]!.length).toBe(8); // YYYYMMDD
  });
});

describe("MarketingDirector", () => {
  describe("createGoal", () => {
    it("creates a Goal and persists it to workspace", async () => {
      const goal = await director.createGoal(
        "Increase signups by 20%",
        "optimization",
      );
      expect(goal.id).toStartWith("goal-");
      expect(goal.description).toBe("Increase signups by 20%");
      expect(goal.category).toBe("optimization");

      // Verify persistence
      const content = await tw.workspace.readFile(`goals/${goal.id}.md`);
      expect(content).toContain("Increase signups by 20%");
      expect(content).toContain("optimization");
    });

    it("generates a unique goal ID", async () => {
      const goal1 = await director.createGoal("Goal 1", "content");
      const goal2 = await director.createGoal("Goal 2", "content");
      expect(goal1.id).not.toBe(goal2.id);
    });

    it("uses default priority when not specified", async () => {
      const goal = await director.createGoal("Test", "content");
      expect(goal.priority).toBe("P2"); // DEFAULT_DIRECTOR_CONFIG default
    });

    it("uses specified priority", async () => {
      const goal = await director.createGoal(
        "Urgent goal",
        "competitive",
        "P0",
      );
      expect(goal.priority).toBe("P0");
    });

    it("sets deadline when provided", async () => {
      const goal = await director.createGoal(
        "Test",
        "content",
        "P1",
        "2026-03-01",
      );
      expect(goal.deadline).toBe("2026-03-01");
    });

    it("sets deadline to null when not provided", async () => {
      const goal = await director.createGoal("Test", "content");
      expect(goal.deadline).toBeNull();
    });
  });

  describe("readGoal", () => {
    it("reads a persisted goal", async () => {
      const created = await director.createGoal(
        "Increase signups",
        "optimization",
        "P1",
      );
      const read = await director.readGoal(created.id);
      expect(read.id).toBe(created.id);
      expect(read.description).toBe("Increase signups");
      expect(read.category).toBe("optimization");
      expect(read.priority).toBe("P1");
    });
  });

  describe("decomposeGoal", () => {
    it("decomposes a content goal into a multi-phase plan", async () => {
      const goal = await director.createGoal(
        "Create blog content pipeline",
        "content",
      );
      const plan = director.decomposeGoal(goal);
      expect(plan.goalId).toBe(goal.id);
      expect(plan.phases.length).toBeGreaterThan(0);
      expect(plan.pipelineTemplateName).toBe("Content Production");
    });

    it("decomposes a strategic goal using custom routing", async () => {
      const goal = await director.createGoal(
        "Develop market positioning",
        "strategic",
      );
      const plan = director.decomposeGoal(goal);
      expect(plan.pipelineTemplateName).toBeNull();
      expect(plan.phases.length).toBeGreaterThan(0);
    });

    it("decomposes an optimization goal using Conversion Sprint template", async () => {
      const goal = await director.createGoal(
        "Improve conversion rate",
        "optimization",
      );
      const plan = director.decomposeGoal(goal);
      expect(plan.pipelineTemplateName).toBe("Conversion Sprint");
    });

    it("returns correct estimatedTaskCount", async () => {
      const goal = await director.createGoal(
        "Build content pipeline",
        "content",
      );
      const plan = director.decomposeGoal(goal);
      const totalSkills = plan.phases.reduce(
        (sum, p) => sum + p.skills.length,
        0,
      );
      expect(plan.estimatedTaskCount).toBe(totalSkills);
    });

    it("handles all goal categories", async () => {
      for (const category of GOAL_CATEGORIES) {
        const goal = await director.createGoal(
          `Test ${category}`,
          category,
        );
        const plan = director.decomposeGoal(goal);
        expect(plan.phases.length).toBeGreaterThan(0);
      }
    });
  });

  describe("planGoalTasks", () => {
    it("creates tasks for phase 1 and writes them to workspace", async () => {
      const goal = await director.createGoal(
        "Create content",
        "content",
      );
      const plan = director.decomposeGoal(goal);
      const tasks = await director.planGoalTasks(plan, goal);
      expect(tasks.length).toBeGreaterThan(0);

      // Verify tasks exist in workspace
      for (const task of tasks) {
        const readTask = await tw.workspace.readTask(task.id);
        expect(readTask.id).toBe(task.id);
      }
    });

    it("all created tasks have status 'pending'", async () => {
      const goal = await director.createGoal(
        "Test goal",
        "optimization",
      );
      const plan = director.decomposeGoal(goal);
      const tasks = await director.planGoalTasks(plan, goal);
      for (const task of tasks) {
        expect(task.status).toBe("pending");
      }
    });

    it("all created tasks reference the goal ID", async () => {
      const goal = await director.createGoal(
        "Test goal",
        "retention",
      );
      const plan = director.decomposeGoal(goal);
      const tasks = await director.planGoalTasks(plan, goal);
      for (const task of tasks) {
        expect(task.goalId).toBe(goal.id);
      }
    });

    it("all created tasks have 'director' as from", async () => {
      const goal = await director.createGoal("Test", "content");
      const plan = director.decomposeGoal(goal);
      const tasks = await director.planGoalTasks(plan, goal);
      for (const task of tasks) {
        expect(task.from).toBe("director");
      }
    });

    it("persists the goal plan", async () => {
      const goal = await director.createGoal("Test", "content");
      const plan = director.decomposeGoal(goal);
      await director.planGoalTasks(plan, goal);

      const planFile = await tw.workspace.readFile(
        `goals/${plan.goalId}-plan.md`,
      );
      expect(planFile).toContain(plan.goalId);
    });
  });

  describe("startPipeline", () => {
    it("creates definition + run + tasks for Content Production", async () => {
      const result = await director.startPipeline(
        "Content Production",
        "Weekly blog content",
      );
      expect(result.definition.name).toBe("Content Production");
      expect(result.run.status).toBe("pending");
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0]!.to).toBe("content-strategy");
    });

    it("writes all created tasks to workspace", async () => {
      const result = await director.startPipeline(
        "Content Production",
        "Test",
      );
      for (const task of result.tasks) {
        const readTask = await tw.workspace.readTask(task.id);
        expect(readTask.id).toBe(task.id);
      }
    });

    it("throws for unknown template name", async () => {
      try {
        await director.startPipeline("Nonexistent", "Test");
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect((err as Error).message).toContain("Unknown pipeline template");
      }
    });

    it("uses specified priority", async () => {
      const result = await director.startPipeline(
        "Content Production",
        "Test",
        "P0",
      );
      expect(result.tasks[0]!.priority).toBe("P0");
    });
  });

  describe("reviewCompletedTask", () => {
    it("approves a task with good output and updates status", async () => {
      // Create and write a task
      const task = createTestTask({
        to: "page-cro",
        status: "completed",
        next: { type: "director_review" },
      });
      await tw.workspace.writeTask(task);

      // Write output
      const output = createTestOutput();
      await tw.workspace.writeOutput("convert", "page-cro", task.id, output);

      // Review
      const decision = await director.reviewCompletedTask(task.id);
      expect(decision.action).toBe("goal_complete");
      expect(decision.review!.verdict).toBe("APPROVE");

      // Verify status updated
      const updatedTask = await tw.workspace.readTask(task.id);
      expect(updatedTask.status).toBe("approved");
    });

    it("revises a task with short output and creates revision task", async () => {
      const task = createTestTask({
        to: "copywriting",
        status: "completed",
        revisionCount: 0,
      });
      await tw.workspace.writeTask(task);

      // Write short output
      await tw.workspace.writeOutput(
        "creative",
        "copywriting",
        task.id,
        "Too short.",
      );

      const decision = await director.reviewCompletedTask(task.id);
      expect(decision.action).toBe("revise");
      expect(decision.nextTasks.length).toBe(1);

      // Verify revision task is in workspace
      const revisionTask = decision.nextTasks[0]!;
      const readRevision = await tw.workspace.readTask(revisionTask.id);
      expect(readRevision.revisionCount).toBe(1);
    });

    it("escalates a task that exceeded max revisions", async () => {
      const task = createTestTask({
        to: "copywriting",
        status: "completed",
        revisionCount: 3,
      });
      await tw.workspace.writeTask(task);

      await tw.workspace.writeOutput(
        "creative",
        "copywriting",
        task.id,
        "Still short.",
      );

      const decision = await director.reviewCompletedTask(task.id);
      expect(decision.action).toBe("escalate_human");
      expect(decision.escalation).not.toBeNull();
    });

    it("writes review to workspace", async () => {
      const task = createTestTask({
        to: "page-cro",
        status: "completed",
        next: { type: "director_review" },
      });
      await tw.workspace.writeTask(task);
      await tw.workspace.writeOutput(
        "convert",
        "page-cro",
        task.id,
        createTestOutput(),
      );

      await director.reviewCompletedTask(task.id);

      const reviews = await tw.workspace.listReviews(task.id);
      expect(reviews.length).toBe(1);
      expect(reviews[0]!.reviewer).toBe("director");
    });

    it("appends learning when goal completes", async () => {
      const task = createTestTask({
        to: "page-cro",
        status: "completed",
        next: { type: "director_review" },
        goalId: "goal-test",
      });
      await tw.workspace.writeTask(task);
      await tw.workspace.writeOutput(
        "convert",
        "page-cro",
        task.id,
        createTestOutput(),
      );

      const decision = await director.reviewCompletedTask(task.id);
      expect(decision.learning).not.toBeNull();

      const learnings = await tw.workspace.readLearnings();
      expect(learnings.length).toBeGreaterThan(0);
    });

    it("handles missing output gracefully", async () => {
      const task = createTestTask({
        to: "page-cro",
        status: "completed",
      });
      await tw.workspace.writeTask(task);

      // Don't write any output — should reject
      const decision = await director.reviewCompletedTask(task.id);
      expect(decision.review!.verdict).toBe("REJECT");
    });
  });

  describe("routeGoal", () => {
    it("delegates to squad router correctly", () => {
      const decision = director.routeGoal("optimization");
      expect(decision.goalCategory).toBe("optimization");
      expect(decision.routes.length).toBeGreaterThan(0);
      expect(decision.measureSquadFinal).toBe(true);
    });
  });

  describe("computeBudgetState", () => {
    it("delegates to escalation engine correctly", () => {
      const state = director.computeBudgetState(500);
      expect(state.level).toBe("normal");
      expect(state.totalBudget).toBe(1000);
    });
  });

  describe("shouldExecuteTask", () => {
    it("allows tasks within budget", () => {
      const task = createTestTask({ priority: "P1" });
      const state = director.computeBudgetState(500);
      expect(director.shouldExecuteTask(task, state)).toBe(true);
    });

    it("blocks tasks outside budget", () => {
      const task = createTestTask({ priority: "P3" });
      const state = director.computeBudgetState(850);
      expect(director.shouldExecuteTask(task, state)).toBe(false);
    });
  });

  describe("getSystemPrompt", () => {
    it("returns the DIRECTOR_SYSTEM_PROMPT constant", () => {
      const prompt = director.getSystemPrompt();
      expect(prompt).toBe(DIRECTOR_SYSTEM_PROMPT);
    });

    it("contains all 5 squad names in the prompt", () => {
      const prompt = director.getSystemPrompt();
      expect(prompt).toContain("Strategy Squad");
      expect(prompt).toContain("Creative Squad");
      expect(prompt).toContain("Convert Squad");
      expect(prompt).toContain("Activate Squad");
      expect(prompt).toContain("Measure Squad");
    });

    it("contains key agent names", () => {
      const prompt = director.getSystemPrompt();
      expect(prompt).toContain("content-strategy");
      expect(prompt).toContain("copywriting");
      expect(prompt).toContain("page-cro");
      expect(prompt).toContain("analytics-tracking");
      expect(prompt).toContain("onboarding-cro");
    });

    it("contains decision rules", () => {
      const prompt = director.getSystemPrompt();
      expect(prompt).toContain("APPROVE");
      expect(prompt).toContain("REVISE");
      expect(prompt).toContain("REJECT");
    });

    it("contains escalation criteria", () => {
      const prompt = director.getSystemPrompt();
      expect(prompt).toContain("Escalat");
      expect(prompt).toContain("Budget");
    });
  });

  describe("createGoal with learnings", () => {
    it("attaches relevant learnings to goal metadata", async () => {
      // Write learnings for skills in the optimization routing
      await tw.workspace.appendLearning({
        timestamp: "2026-02-19T10:00:00.000Z",
        agent: "page-cro",
        goalId: null,
        outcome: "success",
        learning: "CTA above fold boosts conversions",
        actionTaken: "Place CTA above fold",
      });

      const goal = await director.createGoal(
        "Increase signups by 30%",
        "optimization",
      );

      const learnings = goal.metadata.relevantLearnings as Array<{
        agent: string;
        learning: string;
      }>;
      expect(learnings).toBeDefined();
      expect(learnings.length).toBeGreaterThan(0);
      expect(learnings[0]!.agent).toBe("page-cro");
      expect(learnings[0]!.learning).toBe("CTA above fold boosts conversions");
    });

    it("includes director learnings in goal metadata", async () => {
      await tw.workspace.appendLearning({
        timestamp: "2026-02-19T10:00:00.000Z",
        agent: "director",
        goalId: null,
        outcome: "partial",
        learning: "Director-level insight",
        actionTaken: "Adjusted strategy",
      });

      const goal = await director.createGoal(
        "Launch new feature",
        "strategic",
      );

      const learnings = goal.metadata.relevantLearnings as Array<{
        agent: string;
      }>;
      expect(learnings).toBeDefined();
      expect(learnings.some(l => l.agent === "director")).toBe(true);
    });

    it("works normally when no learnings exist", async () => {
      const goal = await director.createGoal(
        "Simple goal",
        "content",
      );

      expect(goal.metadata.relevantLearnings).toBeUndefined();
      expect(goal.id).toStartWith("goal-");
      expect(goal.description).toBe("Simple goal");
    });

    it("limits learnings to 5 most recent", async () => {
      // Write 8 learnings for page-cro
      for (let i = 0; i < 8; i++) {
        const hour = i.toString().padStart(2, "0");
        await tw.workspace.appendLearning({
          timestamp: `2026-02-19T${hour}:00:00.000Z`,
          agent: "page-cro",
          goalId: null,
          outcome: "success",
          learning: `Learning ${i}`,
          actionTaken: `Action ${i}`,
        });
      }

      const goal = await director.createGoal(
        "Optimize conversions",
        "optimization",
      );

      const learnings = goal.metadata.relevantLearnings as Array<unknown>;
      expect(learnings).toBeDefined();
      expect(learnings.length).toBeLessThanOrEqual(5);
    });

    it("excludes learnings from unrelated skills", async () => {
      // cold-email is not in the optimization routing
      await tw.workspace.appendLearning({
        timestamp: "2026-02-19T10:00:00.000Z",
        agent: "cold-email",
        goalId: null,
        outcome: "success",
        learning: "Irrelevant learning",
        actionTaken: "Irrelevant action",
      });

      const goal = await director.createGoal(
        "Optimize signup page",
        "optimization",
      );

      // Should have no learnings (cold-email is not in optimization routing)
      expect(goal.metadata.relevantLearnings).toBeUndefined();
    });
  });
});

// ── MarketingDirector with SkillRegistry ──────────────────────────────────────

describe("MarketingDirector with SkillRegistry", () => {
  // Registry where page-cro is in squad "custom-convert" instead of "convert"
  const registryData: SkillRegistryData = {
    squads: {
      "custom-convert": { description: "Custom convert squad" },
      creative: { description: "Creative squad" },
      strategy: { description: "Strategy squad" },
      activate: { description: "Activate squad" },
      measure: { description: "Measure squad" },
    },
    foundation_skill: "product-marketing-context",
    skills: {
      "product-marketing-context": {
        squad: null,
        description: "Foundation",
        downstream: "all",
      },
      "page-cro": {
        squad: "custom-convert",
        description: "Page CRO",
        downstream: [],
      },
      "copywriting": {
        squad: "creative",
        description: "Copy",
        downstream: ["page-cro"],
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
      "ab-test-setup": {
        squad: "measure",
        description: "A/B Tests",
        downstream: [],
      },
      "seo-audit": {
        squad: "measure",
        description: "SEO Audit",
        downstream: [],
      },
      "onboarding-cro": {
        squad: "activate",
        description: "Onboarding",
        downstream: [],
      },
      "email-sequence": {
        squad: "activate",
        description: "Email",
        downstream: [],
      },
    },
  };

  const registry = SkillRegistry.fromData(registryData);

  let twReg: TestWorkspace;
  let directorWithRegistry: MarketingDirector;

  beforeEach(async () => {
    twReg = await createTestWorkspace();
    directorWithRegistry = new MarketingDirector(
      twReg.workspace,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
    );
  });

  afterEach(async () => {
    await twReg.cleanup();
  });

  it("resolves output path using registry skillSquadMap in review", async () => {
    // Create a task targeting page-cro
    const task = createTestTask({
      to: "page-cro",
      status: "completed",
      next: { type: "director_review" },
    });
    await twReg.workspace.writeTask(task);

    // Create the custom squad output directory (workspace.init() only creates
    // hardcoded squad dirs; registry-driven dirs need explicit creation)
    await mkdir(resolve(twReg.tempDir, "outputs", "custom-convert", "page-cro"), {
      recursive: true,
    });

    // Write output at the registry-driven path (custom-convert squad)
    await twReg.workspace.writeOutput(
      "custom-convert",
      "page-cro",
      task.id,
      createTestOutput(),
    );

    // Review should succeed — output found via registry's squad map
    const decision = await directorWithRegistry.reviewCompletedTask(task.id);
    expect(decision.review!.verdict).toBe("APPROVE");
    expect(decision.action).toBe("goal_complete");
  });

  it("propagates registry to pipeline factory for task creation", async () => {
    const result = await directorWithRegistry.startPipeline(
      "Content Production",
      "Weekly blog",
    );
    // First step is content-strategy → squad should be "strategy" from registry
    expect(result.tasks[0]!.output.path).toContain("outputs/strategy/content-strategy/");
  });

  it("still creates goals normally with registry", async () => {
    const goal = await directorWithRegistry.createGoal(
      "Test with registry",
      "content",
    );
    expect(goal.id).toStartWith("goal-");
    expect(goal.description).toBe("Test with registry");
    expect(goal.category).toBe("content");
  });

  it("getSystemPrompt returns dynamic prompt from registry", () => {
    const prompt = directorWithRegistry.getSystemPrompt();
    // Dynamic prompt reflects registry, not the hardcoded 26/5
    expect(prompt).toContain("8 specialized marketing AI agents");
    expect(prompt).toContain("5 squads");
    expect(prompt).toContain("### Custom-convert Squad (custom convert squad)");
    expect(prompt).toContain("- page-cro: Page CRO");
    expect(prompt).toContain("- copywriting: Copy");
    // Should NOT contain hardcoded "26" count
    expect(prompt).not.toContain("26 specialized");
  });

  it("decomposeGoal still works with registry", async () => {
    const goal = await directorWithRegistry.createGoal(
      "Build content pipeline",
      "content",
    );
    const plan = directorWithRegistry.decomposeGoal(goal);
    expect(plan.pipelineTemplateName).toBe("Content Production");
    expect(plan.phases.length).toBeGreaterThan(0);
  });
});
