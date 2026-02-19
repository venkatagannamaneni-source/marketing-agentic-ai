import { describe, it, expect } from "bun:test";
import {
  PRIORITY_MAP,
  taskPriorityToQueuePriority,
  queuePriorityToTaskPriority,
} from "../priority-map.ts";
import type { Priority } from "../../types/task.ts";

describe("priority-map", () => {
  describe("PRIORITY_MAP", () => {
    it("maps P0 to lowest number (highest priority)", () => {
      expect(PRIORITY_MAP.P0).toBe(1);
    });

    it("maps P3 to highest number (lowest priority)", () => {
      expect(PRIORITY_MAP.P3).toBe(20);
    });

    it("maintains ordering invariant P0 < P1 < P2 < P3", () => {
      expect(PRIORITY_MAP.P0).toBeLessThan(PRIORITY_MAP.P1);
      expect(PRIORITY_MAP.P1).toBeLessThan(PRIORITY_MAP.P2);
      expect(PRIORITY_MAP.P2).toBeLessThan(PRIORITY_MAP.P3);
    });

    it("maps all four priority levels", () => {
      expect(Object.keys(PRIORITY_MAP)).toEqual(["P0", "P1", "P2", "P3"]);
    });
  });

  describe("taskPriorityToQueuePriority", () => {
    it("converts each priority level correctly", () => {
      expect(taskPriorityToQueuePriority("P0")).toBe(1);
      expect(taskPriorityToQueuePriority("P1")).toBe(5);
      expect(taskPriorityToQueuePriority("P2")).toBe(10);
      expect(taskPriorityToQueuePriority("P3")).toBe(20);
    });
  });

  describe("queuePriorityToTaskPriority", () => {
    it("converts exact values back correctly", () => {
      expect(queuePriorityToTaskPriority(1)).toBe("P0");
      expect(queuePriorityToTaskPriority(5)).toBe("P1");
      expect(queuePriorityToTaskPriority(10)).toBe("P2");
      expect(queuePriorityToTaskPriority(20)).toBe("P3");
    });

    it("handles boundary values (uses closest match)", () => {
      expect(queuePriorityToTaskPriority(0)).toBe("P0");
      expect(queuePriorityToTaskPriority(1)).toBe("P0");
      expect(queuePriorityToTaskPriority(2)).toBe("P1");
      expect(queuePriorityToTaskPriority(6)).toBe("P2");
      expect(queuePriorityToTaskPriority(11)).toBe("P3");
      expect(queuePriorityToTaskPriority(100)).toBe("P3");
    });

    it("roundtrips through taskPriorityToQueuePriority", () => {
      const priorities: Priority[] = ["P0", "P1", "P2", "P3"];
      for (const p of priorities) {
        const numeric = taskPriorityToQueuePriority(p);
        const back = queuePriorityToTaskPriority(numeric);
        expect(back).toBe(p);
      }
    });
  });
});
