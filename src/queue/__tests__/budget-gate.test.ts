import { describe, it, expect } from "bun:test";
import { BudgetGate } from "../budget-gate.ts";
import { createTestTask, createTestBudgetState } from "./helpers.ts";
import type { Priority } from "../../types/task.ts";
import type { BudgetLevel } from "../../director/types.ts";

describe("BudgetGate", () => {
  const gate = new BudgetGate();

  describe("check", () => {
    it("allows all priorities at normal budget", () => {
      const budget = createTestBudgetState("normal");
      for (const p of ["P0", "P1", "P2", "P3"] as Priority[]) {
        const task = createTestTask({ priority: p });
        expect(gate.check(task, budget)).toBe("allow");
      }
    });

    it("defers P3 at warning level", () => {
      const budget = createTestBudgetState("warning");
      expect(gate.check(createTestTask({ priority: "P0" }), budget)).toBe("allow");
      expect(gate.check(createTestTask({ priority: "P1" }), budget)).toBe("allow");
      expect(gate.check(createTestTask({ priority: "P2" }), budget)).toBe("allow");
      expect(gate.check(createTestTask({ priority: "P3" }), budget)).toBe("defer");
    });

    it("defers P2 and P3 at throttle level", () => {
      const budget = createTestBudgetState("throttle");
      expect(gate.check(createTestTask({ priority: "P0" }), budget)).toBe("allow");
      expect(gate.check(createTestTask({ priority: "P1" }), budget)).toBe("allow");
      expect(gate.check(createTestTask({ priority: "P2" }), budget)).toBe("defer");
      expect(gate.check(createTestTask({ priority: "P3" }), budget)).toBe("defer");
    });

    it("allows only P0 at critical level", () => {
      const budget = createTestBudgetState("critical");
      expect(gate.check(createTestTask({ priority: "P0" }), budget)).toBe("allow");
      expect(gate.check(createTestTask({ priority: "P1" }), budget)).toBe("defer");
      expect(gate.check(createTestTask({ priority: "P2" }), budget)).toBe("defer");
      expect(gate.check(createTestTask({ priority: "P3" }), budget)).toBe("defer");
    });

    it("blocks everything at exhausted level", () => {
      const budget = createTestBudgetState("exhausted");
      for (const p of ["P0", "P1", "P2", "P3"] as Priority[]) {
        const task = createTestTask({ priority: p });
        expect(gate.check(task, budget)).toBe("block");
      }
    });
  });

  describe("filterBatch", () => {
    it("splits tasks into allowed and deferred", () => {
      const budget = createTestBudgetState("throttle"); // P0, P1 allowed

      const tasks = [
        createTestTask({ id: "t1", priority: "P0" }),
        createTestTask({ id: "t2", priority: "P1" }),
        createTestTask({ id: "t3", priority: "P2" }),
        createTestTask({ id: "t4", priority: "P3" }),
      ];

      const { allowed, deferred } = gate.filterBatch(tasks, budget);

      expect(allowed).toHaveLength(2);
      expect(allowed[0]!.id).toBe("t1");
      expect(allowed[1]!.id).toBe("t2");

      expect(deferred).toHaveLength(2);
      expect(deferred[0]!.id).toBe("t3");
      expect(deferred[1]!.id).toBe("t4");
    });

    it("returns all in allowed when budget is normal", () => {
      const budget = createTestBudgetState("normal");
      const tasks = [
        createTestTask({ id: "t1", priority: "P3" }),
        createTestTask({ id: "t2", priority: "P3" }),
      ];

      const { allowed, deferred } = gate.filterBatch(tasks, budget);
      expect(allowed).toHaveLength(2);
      expect(deferred).toHaveLength(0);
    });

    it("returns all in deferred when budget is exhausted", () => {
      const budget = createTestBudgetState("exhausted");
      const tasks = [
        createTestTask({ id: "t1", priority: "P0" }),
        createTestTask({ id: "t2", priority: "P1" }),
      ];

      const { allowed, deferred } = gate.filterBatch(tasks, budget);
      expect(allowed).toHaveLength(0);
      expect(deferred).toHaveLength(2);
    });

    it("handles empty batch", () => {
      const budget = createTestBudgetState("normal");
      const { allowed, deferred } = gate.filterBatch([], budget);
      expect(allowed).toHaveLength(0);
      expect(deferred).toHaveLength(0);
    });
  });
});
