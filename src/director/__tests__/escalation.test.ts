import { describe, expect, it } from "bun:test";
import { EscalationEngine } from "../escalation.ts";
import { DEFAULT_DIRECTOR_CONFIG } from "../types.ts";
import { createTestTask, createTestConfig } from "./helpers.ts";

const engine = new EscalationEngine(DEFAULT_DIRECTOR_CONFIG);

describe("EscalationEngine", () => {
  describe("computeBudgetState", () => {
    it("returns 'normal' when under 80%", () => {
      const state = engine.computeBudgetState(500);
      expect(state.level).toBe("normal");
      expect(state.percentUsed).toBe(50);
      expect(state.allowedPriorities).toEqual(["P0", "P1", "P2", "P3"]);
      expect(state.modelOverride).toBeNull();
    });

    it("returns 'warning' at 80% with P3 excluded", () => {
      const state = engine.computeBudgetState(800);
      expect(state.level).toBe("warning");
      expect(state.percentUsed).toBe(80);
      expect(state.allowedPriorities).toEqual(["P0", "P1", "P2"]);
      expect(state.modelOverride).toBeNull();
    });

    it("returns 'warning' at 85%", () => {
      const state = engine.computeBudgetState(850);
      expect(state.level).toBe("warning");
      expect(state.percentUsed).toBe(85);
    });

    it("returns 'throttle' at 90% with only P0/P1 allowed", () => {
      const state = engine.computeBudgetState(900);
      expect(state.level).toBe("throttle");
      expect(state.percentUsed).toBe(90);
      expect(state.allowedPriorities).toEqual(["P0", "P1"]);
      expect(state.modelOverride).toBeNull();
    });

    it("returns 'critical' at 95% with only P0 and haiku model override", () => {
      const state = engine.computeBudgetState(950);
      expect(state.level).toBe("critical");
      expect(state.percentUsed).toBe(95);
      expect(state.allowedPriorities).toEqual(["P0"]);
      expect(state.modelOverride).toBe("haiku");
    });

    it("returns 'exhausted' at 100% with no priorities allowed", () => {
      const state = engine.computeBudgetState(1000);
      expect(state.level).toBe("exhausted");
      expect(state.percentUsed).toBe(100);
      expect(state.allowedPriorities).toEqual([]);
      expect(state.modelOverride).toBeNull();
    });

    it("returns 'exhausted' when over 100%", () => {
      const state = engine.computeBudgetState(1200);
      expect(state.level).toBe("exhausted");
      expect(state.percentUsed).toBe(120);
    });

    it("computes percentUsed correctly", () => {
      const state = engine.computeBudgetState(333);
      expect(state.percentUsed).toBeCloseTo(33.3, 1);
      expect(state.totalBudget).toBe(1000);
      expect(state.spent).toBe(333);
    });

    it("handles zero budget gracefully", () => {
      const zeroEngine = new EscalationEngine(
        createTestConfig({
          budget: {
            totalMonthly: 0,
            warningPercent: 80,
            throttlePercent: 90,
            criticalPercent: 95,
          },
        }),
      );
      const state = zeroEngine.computeBudgetState(0);
      expect(state.level).toBe("normal");
      expect(state.percentUsed).toBe(0);
    });
  });

  describe("shouldExecuteTask", () => {
    it("allows P0 task at normal budget level", () => {
      const task = createTestTask({ priority: "P0" });
      const state = engine.computeBudgetState(500);
      expect(engine.shouldExecuteTask(task, state)).toBe(true);
    });

    it("allows P0 task at critical budget level", () => {
      const task = createTestTask({ priority: "P0" });
      const state = engine.computeBudgetState(960);
      expect(engine.shouldExecuteTask(task, state)).toBe(true);
    });

    it("blocks P0 task at exhausted budget level", () => {
      const task = createTestTask({ priority: "P0" });
      const state = engine.computeBudgetState(1000);
      expect(engine.shouldExecuteTask(task, state)).toBe(false);
    });

    it("blocks P3 task at warning level", () => {
      const task = createTestTask({ priority: "P3" });
      const state = engine.computeBudgetState(800);
      expect(engine.shouldExecuteTask(task, state)).toBe(false);
    });

    it("blocks P2 task at throttle level", () => {
      const task = createTestTask({ priority: "P2" });
      const state = engine.computeBudgetState(900);
      expect(engine.shouldExecuteTask(task, state)).toBe(false);
    });

    it("allows P1 task at throttle level", () => {
      const task = createTestTask({ priority: "P1" });
      const state = engine.computeBudgetState(900);
      expect(engine.shouldExecuteTask(task, state)).toBe(true);
    });

    it("blocks all tasks at exhausted level", () => {
      const state = engine.computeBudgetState(1000);
      for (const priority of ["P0", "P1", "P2", "P3"] as const) {
        const task = createTestTask({ priority });
        expect(engine.shouldExecuteTask(task, state)).toBe(false);
      }
    });
  });

  describe("checkBudgetEscalation", () => {
    it("returns null for normal budget", () => {
      const state = engine.computeBudgetState(500);
      expect(engine.checkBudgetEscalation(state)).toBeNull();
    });

    it("returns warning escalation at warning level", () => {
      const state = engine.computeBudgetState(800);
      const escalation = engine.checkBudgetEscalation(state);
      expect(escalation).not.toBeNull();
      expect(escalation!.reason).toBe("budget_threshold");
      expect(escalation!.severity).toBe("warning");
    });

    it("returns warning escalation at throttle level", () => {
      const state = engine.computeBudgetState(900);
      const escalation = engine.checkBudgetEscalation(state);
      expect(escalation).not.toBeNull();
      expect(escalation!.severity).toBe("warning");
    });

    it("returns critical escalation at critical level", () => {
      const state = engine.computeBudgetState(950);
      const escalation = engine.checkBudgetEscalation(state);
      expect(escalation).not.toBeNull();
      expect(escalation!.severity).toBe("critical");
    });

    it("returns critical escalation at exhausted level", () => {
      const state = engine.computeBudgetState(1000);
      const escalation = engine.checkBudgetEscalation(state);
      expect(escalation).not.toBeNull();
      expect(escalation!.severity).toBe("critical");
      expect(escalation!.message).toContain("NONE");
    });

    it("includes budget details in escalation context", () => {
      const state = engine.computeBudgetState(900);
      const escalation = engine.checkBudgetEscalation(state)!;
      expect(escalation.context).toEqual({
        spent: 900,
        total: 1000,
        level: "throttle",
      });
    });
  });

  describe("checkRevisionEscalation", () => {
    it("returns null when under max revisions", () => {
      const task = createTestTask({ revisionCount: 1 });
      expect(engine.checkRevisionEscalation(task)).toBeNull();
    });

    it("returns null at revisionCount 0", () => {
      const task = createTestTask({ revisionCount: 0 });
      expect(engine.checkRevisionEscalation(task)).toBeNull();
    });

    it("returns escalation when at max revisions", () => {
      const task = createTestTask({ revisionCount: 3 });
      const escalation = engine.checkRevisionEscalation(task);
      expect(escalation).not.toBeNull();
      expect(escalation!.reason).toBe("agent_loop_detected");
      expect(escalation!.severity).toBe("warning");
    });

    it("returns escalation when exceeding max revisions", () => {
      const task = createTestTask({ revisionCount: 5 });
      const escalation = engine.checkRevisionEscalation(task);
      expect(escalation).not.toBeNull();
    });

    it("includes task ID and revision count in context", () => {
      const task = createTestTask({
        id: "test-task-abc",
        revisionCount: 3,
        to: "copywriting",
      });
      const escalation = engine.checkRevisionEscalation(task)!;
      expect(escalation.context).toEqual({
        taskId: "test-task-abc",
        skill: "copywriting",
        revisionCount: 3,
      });
    });
  });

  describe("checkCascadingFailure", () => {
    it("returns null for fewer than 3 failures", () => {
      expect(engine.checkCascadingFailure(0, "pipeline-1")).toBeNull();
      expect(engine.checkCascadingFailure(1, "pipeline-1")).toBeNull();
      expect(engine.checkCascadingFailure(2, "pipeline-1")).toBeNull();
    });

    it("returns critical escalation for 3+ failures", () => {
      const escalation = engine.checkCascadingFailure(3, "pipeline-1");
      expect(escalation).not.toBeNull();
      expect(escalation!.reason).toBe("cascading_failure");
      expect(escalation!.severity).toBe("critical");
    });

    it("includes pipeline ID in context", () => {
      const escalation = engine.checkCascadingFailure(5, "content-production")!;
      expect(escalation.context).toEqual({
        pipelineId: "content-production",
        failedTaskCount: 5,
      });
    });
  });
});
