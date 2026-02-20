import { describe, it, expect } from "bun:test";
import { BudgetGate } from "../budget-gate.ts";
import { createTestTask, createTestBudgetState } from "./helpers.ts";
import type { Priority } from "../../types/task.ts";
import type { BudgetLevel } from "../../director/types.ts";
import type { SystemEvent } from "../../types/events.ts";

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

  describe("event emission", () => {
    it("emits budget_critical when budget is exhausted", () => {
      const events: SystemEvent[] = [];
      const gateWithEvents = new BudgetGate((e) => events.push(e));
      const budget = createTestBudgetState("exhausted");
      const task = createTestTask({ priority: "P0" });

      gateWithEvents.check(task, budget);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("budget_critical");
      expect(events[0]!.source).toBe("budget-gate");
    });

    it("emits budget_warning when budget level is warning", () => {
      const events: SystemEvent[] = [];
      const gateWithEvents = new BudgetGate((e) => events.push(e));
      const budget = createTestBudgetState("warning");
      const task = createTestTask({ priority: "P0" });

      gateWithEvents.check(task, budget);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("budget_warning");
    });

    it("emits budget_warning when budget level is critical", () => {
      const events: SystemEvent[] = [];
      const gateWithEvents = new BudgetGate((e) => events.push(e));
      const budget = createTestBudgetState("critical");
      const task = createTestTask({ priority: "P0" });

      gateWithEvents.check(task, budget);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("budget_warning");
    });

    it("does not emit when no onEvent callback provided", () => {
      const gateNoCallback = new BudgetGate();
      const budget = createTestBudgetState("exhausted");
      const task = createTestTask({ priority: "P0" });

      // Should not throw
      gateNoCallback.check(task, budget);
    });

    it("does not emit at normal budget level", () => {
      const events: SystemEvent[] = [];
      const gateWithEvents = new BudgetGate((e) => events.push(e));
      const budget = createTestBudgetState("normal");
      const task = createTestTask({ priority: "P0" });

      gateWithEvents.check(task, budget);

      expect(events).toHaveLength(0);
    });

    it("does not emit at throttle budget level for allowed priority", () => {
      const events: SystemEvent[] = [];
      const gateWithEvents = new BudgetGate((e) => events.push(e));
      const budget = createTestBudgetState("throttle");
      const task = createTestTask({ priority: "P0" });

      gateWithEvents.check(task, budget);

      expect(events).toHaveLength(0);
    });

    it("emitted event has correct shape", () => {
      const events: SystemEvent[] = [];
      const gateWithEvents = new BudgetGate((e) => events.push(e));
      const budget = createTestBudgetState("exhausted");
      const task = createTestTask({ priority: "P0" });

      gateWithEvents.check(task, budget);

      const event = events[0]!;
      expect(typeof event.id).toBe("string");
      expect(event.id.length).toBeGreaterThan(0);
      expect(typeof event.timestamp).toBe("string");
      expect(event.source).toBe("budget-gate");
      expect(event.data.level).toBe("exhausted");
      expect(event.data.percentUsed).toBe(100);
      expect(event.data.spent).toBe(1000);
      expect(event.data.totalBudget).toBe(1000);
    });

    it("produces unique event IDs across multiple calls in the same tick", () => {
      const events: SystemEvent[] = [];
      const gateWithEvents = new BudgetGate((e) => events.push(e));
      const budget = createTestBudgetState("exhausted");

      gateWithEvents.check(createTestTask({ priority: "P0" }), budget);
      gateWithEvents.check(createTestTask({ priority: "P0" }), budget);
      gateWithEvents.check(createTestTask({ priority: "P0" }), budget);

      expect(events).toHaveLength(3);
      const ids = new Set(events.map((e) => e.id));
      expect(ids.size).toBe(3);
    });
  });
});
