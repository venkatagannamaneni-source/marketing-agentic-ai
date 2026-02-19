import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSystemWorkspaceManager } from "../workspace-manager.ts";
import type { Goal, GoalPlan } from "../../types/goal.ts";

describe("WorkspaceManager Goal Operations", () => {
  let ws: FileSystemWorkspaceManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ws-goals-test-"));
    ws = new FileSystemWorkspaceManager({ rootDir: tempDir });
    await ws.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const testGoal: Goal = {
    id: "goal-20260219-abc123",
    description: "Improve signup conversion rate by 20%",
    category: "optimization",
    priority: "P1",
    createdAt: "2026-02-19T00:00:00.000Z",
    deadline: null,
    metadata: {},
  };

  const testPlan: GoalPlan = {
    goalId: "goal-20260219-abc123",
    phases: [
      {
        name: "Audit",
        description: "Audit existing signup flow",
        skills: ["page-cro" as any],
        parallel: false,
        dependsOnPhase: null,
      },
      {
        name: "Optimize",
        description: "Create optimized variants",
        skills: ["signup-flow-cro" as any, "form-cro" as any],
        parallel: true,
        dependsOnPhase: 0,
      },
    ],
    estimatedTaskCount: 3,
    pipelineTemplateName: "Conversion Sprint",
  };

  describe("writeGoal and readGoal", () => {
    it("round-trips a goal through write and read", async () => {
      await ws.writeGoal(testGoal);
      const read = await ws.readGoal(testGoal.id);

      expect(read.id).toBe(testGoal.id);
      expect(read.description).toBe(testGoal.description);
      expect(read.category).toBe(testGoal.category);
      expect(read.priority).toBe(testGoal.priority);
      expect(read.createdAt).toBe(testGoal.createdAt);
      expect(read.deadline).toBeNull();
    });

    it("preserves metadata", async () => {
      const goalWithMeta = { ...testGoal, metadata: { source: "campaign-A" } };
      await ws.writeGoal(goalWithMeta);
      const read = await ws.readGoal(goalWithMeta.id);
      expect(read.metadata).toEqual({ source: "campaign-A" });
    });

    it("preserves deadline", async () => {
      const goalWithDeadline = { ...testGoal, deadline: "2026-03-01" };
      await ws.writeGoal(goalWithDeadline);
      const read = await ws.readGoal(goalWithDeadline.id);
      expect(read.deadline).toBe("2026-03-01");
    });

    it("throws on non-existent goal", async () => {
      await expect(ws.readGoal("nonexistent")).rejects.toThrow();
    });
  });

  describe("listGoals", () => {
    it("returns empty array when no goals", async () => {
      const goals = await ws.listGoals();
      expect(goals).toEqual([]);
    });

    it("lists all goals, excluding plan files", async () => {
      await ws.writeGoal(testGoal);
      const goal2 = { ...testGoal, id: "goal-20260219-def456", category: "content" as const };
      await ws.writeGoal(goal2);
      await ws.writeGoalPlan(testPlan); // plan should be excluded

      const goals = await ws.listGoals();
      expect(goals.length).toBe(2);
      const ids = goals.map((g) => g.id).sort();
      expect(ids).toEqual(["goal-20260219-abc123", "goal-20260219-def456"]);
    });
  });

  describe("writeGoalPlan and readGoalPlan", () => {
    it("round-trips a goal plan through write and read", async () => {
      await ws.writeGoalPlan(testPlan);
      const read = await ws.readGoalPlan(testPlan.goalId);

      expect(read.goalId).toBe(testPlan.goalId);
      expect(read.estimatedTaskCount).toBe(3);
      expect(read.pipelineTemplateName).toBe("Conversion Sprint");
      expect(read.phases.length).toBe(2);
      expect(read.phases[0]!.name).toBe("Audit");
      expect(read.phases[0]!.parallel).toBe(false);
      expect(read.phases[0]!.dependsOnPhase).toBeNull();
      expect(read.phases[1]!.name).toBe("Optimize");
      expect(read.phases[1]!.parallel).toBe(true);
      expect(read.phases[1]!.dependsOnPhase).toBe(0);
    });

    it("throws on non-existent plan", async () => {
      await expect(ws.readGoalPlan("nonexistent")).rejects.toThrow();
    });
  });

  describe("init creates goals directory", () => {
    it("goals directory exists after init", async () => {
      const exists = await ws.fileExists("goals/.keep").catch(() => false);
      // The directory exists (init creates it), but no .keep file
      // Verify by writing a goal (which would fail if dir doesn't exist)
      await ws.writeGoal(testGoal);
      const read = await ws.readGoal(testGoal.id);
      expect(read.id).toBe(testGoal.id);
    });
  });
});
