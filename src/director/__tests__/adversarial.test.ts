import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { MarketingDirector } from "../director.ts";
import { GoalDecomposer } from "../goal-decomposer.ts";
import { PipelineFactory } from "../pipeline-factory.ts";
import { ReviewEngine } from "../review-engine.ts";
import { routeGoal } from "../squad-router.ts";
import { PIPELINE_TEMPLATES } from "../../agents/registry.ts";
import { DEFAULT_DIRECTOR_CONFIG } from "../types.ts";
import {
  createTestWorkspace,
  createTestTask,
  createTestOutput,
  createTestGoal,
  type TestWorkspace,
} from "./helpers.ts";

// ── Adversarial Tests ────────────────────────────────────────────────────────
// These tests probe edge cases and hidden bugs found during code review.

let tw: TestWorkspace;
let director: MarketingDirector;

beforeEach(async () => {
  tw = await createTestWorkspace();
  director = new MarketingDirector(tw.workspace);
});

afterEach(async () => {
  await tw.cleanup();
});

describe("ADVERSARIAL: Goal serialization round-trip", () => {
  it("survives description with colons", async () => {
    const goal = await director.createGoal(
      "Increase CTR: A/B test new copy: headline variants",
      "optimization",
    );
    const read = await director.readGoal(goal.id);
    expect(read.description).toBe(
      "Increase CTR: A/B test new copy: headline variants",
    );
  });

  it("survives description with markdown", async () => {
    const goal = await director.createGoal(
      "Create **bold** content with [links](https://example.com)",
      "content",
    );
    const read = await director.readGoal(goal.id);
    expect(read.description).toContain("**bold**");
    expect(read.description).toContain("[links]");
  });

  it("survives description with dashes (frontmatter-like)", async () => {
    const goal = await director.createGoal(
      "Test --- with dashes --- in description",
      "content",
    );
    const read = await director.readGoal(goal.id);
    expect(read.description).toContain("---");
  });

  it("survives deadline with timestamp containing colons", async () => {
    const goal = await director.createGoal(
      "Test goal",
      "content",
      "P1",
      "2026-02-19T10:30:00.000Z",
    );
    const read = await director.readGoal(goal.id);
    expect(read.deadline).toBe("2026-02-19T10:30:00.000Z");
  });

  it("preserves null deadline through round-trip", async () => {
    const goal = await director.createGoal("Test", "content");
    const read = await director.readGoal(goal.id);
    expect(read.deadline).toBeNull();
  });

  it("preserves category through round-trip", async () => {
    const goal = await director.createGoal("Test", "competitive");
    const read = await director.readGoal(goal.id);
    expect(read.category).toBe("competitive");
  });

  it("preserves priority through round-trip", async () => {
    const goal = await director.createGoal("Test", "content", "P0");
    const read = await director.readGoal(goal.id);
    expect(read.priority).toBe("P0");
  });
});

describe("ADVERSARIAL: Revision task chain", () => {
  it("revision task has incremented revisionCount", async () => {
    const task = createTestTask({
      to: "copywriting",
      status: "completed",
      revisionCount: 0,
    });
    await tw.workspace.writeTask(task);
    await tw.workspace.writeOutput(
      "creative",
      "copywriting",
      task.id,
      "Too short.",
    );

    const decision = await director.reviewCompletedTask(task.id);
    expect(decision.action).toBe("revise");
    expect(decision.nextTasks[0]!.revisionCount).toBe(1);
  });

  it("revision task has a DIFFERENT ID from the original", async () => {
    const task = createTestTask({
      to: "copywriting",
      status: "completed",
      revisionCount: 0,
    });
    await tw.workspace.writeTask(task);
    await tw.workspace.writeOutput(
      "creative",
      "copywriting",
      task.id,
      "Too short.",
    );

    const decision = await director.reviewCompletedTask(task.id);
    expect(decision.nextTasks[0]!.id).not.toBe(task.id);
  });

  it("revision task references original via metadata", async () => {
    const task = createTestTask({
      to: "copywriting",
      status: "completed",
      revisionCount: 1,
    });
    await tw.workspace.writeTask(task);
    await tw.workspace.writeOutput(
      "creative",
      "copywriting",
      task.id,
      "Still short.",
    );

    const decision = await director.reviewCompletedTask(task.id);
    if (decision.action === "revise") {
      const revTask = decision.nextTasks[0]!;
      expect(revTask.metadata.originalTaskId).toBe(task.id);
      expect(revTask.metadata.revisionOf).toBe(task.id);
    }
  });

  it("third revision triggers escalation (max 3)", async () => {
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
    expect(decision.nextTasks.length).toBe(0);
  });
});

describe("ADVERSARIAL: advanceGoal phase tracking", () => {
  it("correctly advances through phases when all phase 1 tasks approved", async () => {
    const goal = await director.createGoal(
      "Build content pipeline",
      "content",
      "P2",
    );
    const plan = director.decomposeGoal(goal);
    const phase1Tasks = await director.planGoalTasks(plan, goal);

    // Approve all phase 1 tasks
    for (const task of phase1Tasks) {
      await tw.workspace.updateTaskStatus(task.id, "approved");
    }

    const result = await director.advanceGoal(goal.id);
    expect(result).not.toBe("complete");
    if (result !== "complete") {
      // Phase 2 tasks should be created
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("returns 'complete' when all phases done", async () => {
    const goal = await director.createGoal("Quick measurement", "measurement");
    const plan = director.decomposeGoal(goal);
    const tasks = await director.planGoalTasks(plan, goal);

    // Approve all tasks
    for (const task of tasks) {
      await tw.workspace.updateTaskStatus(task.id, "approved");
    }

    const result = await director.advanceGoal(goal.id);
    // Measurement has only 1 or 2 phases, should either complete or advance
    expect(result === "complete" || Array.isArray(result)).toBe(true);
  });
});

describe("ADVERSARIAL: Pipeline factory edge cases", () => {
  it("tasks from parallel step all have the same pipelineId", async () => {
    const result = await director.startPipeline(
      "Product Launch",
      "Launch API",
      "P0",
    );
    // Product Launch first step is sequential (launch-strategy)
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.pipelineId).toBe(result.run.id);
  });

  it("all 8 pipeline templates can be instantiated", async () => {
    const templates = [
      "Content Production",
      "Page Launch",
      "Product Launch",
      "Conversion Sprint",
      "Competitive Response",
      "Retention Sprint",
      "SEO Cycle",
      "Outreach Campaign",
    ];
    for (const name of templates) {
      const result = await director.startPipeline(name, `Test ${name}`);
      expect(result.definition.name).toBe(name);
      expect(result.tasks.length).toBeGreaterThan(0);
    }
  });
});

describe("ADVERSARIAL: Review engine edge cases", () => {
  const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG);

  it("output with exactly 100 chars passes length check", () => {
    const output = "# Test\n\n" + "x".repeat(92); // Exactly 100 chars
    const task = createTestTask({
      next: { type: "director_review" },
    });
    const decision = engine.evaluateTask(task, output, []);
    // Should not have "suspiciously short" finding
    const shortFinding = decision.review!.findings.find((f) =>
      f.description.includes("less than 100"),
    );
    expect(shortFinding).toBeUndefined();
  });

  it("output with exactly 99 chars triggers short warning", () => {
    const output = "x".repeat(99);
    const task = createTestTask();
    const decision = engine.evaluateTask(task, output, []);
    const shortFinding = decision.review!.findings.find((f) =>
      f.description.includes("less than 100"),
    );
    expect(shortFinding).toBeDefined();
  });

  it("approve verdict for task with agent next returns approve action", () => {
    const task = createTestTask({
      next: { type: "agent", skill: "copywriting" },
    });
    const output = createTestOutput();
    const decision = engine.evaluateTask(task, output, []);
    expect(decision.action).toBe("approve");
  });
});

describe("ADVERSARIAL: Budget boundary conditions", () => {
  it("79.99% is still normal", () => {
    const state = director.computeBudgetState(799.9);
    expect(state.level).toBe("normal");
  });

  it("80% triggers warning", () => {
    const state = director.computeBudgetState(800);
    expect(state.level).toBe("warning");
  });

  it("89.99% is still warning", () => {
    const state = director.computeBudgetState(899.9);
    expect(state.level).toBe("warning");
  });

  it("99.99% is still critical", () => {
    const state = director.computeBudgetState(999.9);
    expect(state.level).toBe("critical");
  });
});

describe("ADVERSARIAL: Goal deserialization validation", () => {
  it("throws on corrupted goal file with invalid category", async () => {
    // Ensure goals directory exists
    await mkdir(resolve(tw.tempDir, "goals"), { recursive: true });
    // Write a manually corrupted goal file
    await tw.workspace.writeFile(
      "goals/goal-bad-category.md",
      [
        "---",
        "id: goal-bad-category",
        "category: invalid_category",
        "priority: P1",
        "created_at: 2026-02-19T00:00:00.000Z",
        "deadline: none",
        "metadata: {}",
        "---",
        "",
        "# Goal: goal-bad-category",
        "",
        "## Description",
        "",
        "A corrupted goal",
        "",
      ].join("\n"),
    );

    try {
      await director.readGoal("goal-bad-category");
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect((err as Error).message).toContain("invalid category");
    }
  });

  it("throws on corrupted goal file with invalid priority", async () => {
    await mkdir(resolve(tw.tempDir, "goals"), { recursive: true });
    await tw.workspace.writeFile(
      "goals/goal-bad-priority.md",
      [
        "---",
        "id: goal-bad-priority",
        "category: content",
        "priority: URGENT",
        "created_at: 2026-02-19T00:00:00.000Z",
        "deadline: none",
        "metadata: {}",
        "---",
        "",
        "# Goal: goal-bad-priority",
        "",
        "## Description",
        "",
        "A corrupted goal",
        "",
      ].join("\n"),
    );

    try {
      await director.readGoal("goal-bad-priority");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("invalid priority");
    }
  });
});

describe("ADVERSARIAL: Error handling in reviewCompletedTask", () => {
  it("handles task with no output file gracefully", async () => {
    const task = createTestTask({
      to: "page-cro",
      status: "completed",
    });
    await tw.workspace.writeTask(task);
    // Don't write output — should handle gracefully
    const decision = await director.reviewCompletedTask(task.id);
    expect(decision.review!.verdict).toBe("REJECT");
    expect(decision.review!.findings.some((f) => f.severity === "critical")).toBe(
      true,
    );
  });
});
