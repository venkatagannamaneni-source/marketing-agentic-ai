import { describe, it, expect } from "bun:test";
import {
  TASK_STATUSES,
  VALID_TRANSITIONS,
  validateTransition,
  InvalidTransitionError,
} from "../task.ts";
import type { TaskStatus } from "../task.ts";

describe("Task State Machine", () => {
  describe("VALID_TRANSITIONS", () => {
    it("covers every TaskStatus", () => {
      for (const status of TASK_STATUSES) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
        expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
      }
    });

    it("only contains valid TaskStatus values in transition targets", () => {
      const validStatuses = new Set<string>(TASK_STATUSES);
      for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
        for (const target of targets) {
          expect(validStatuses.has(target)).toBe(true);
        }
      }
    });
  });

  describe("validateTransition", () => {
    const TERMINAL_STATUSES: TaskStatus[] = ["approved", "failed", "cancelled"];

    it("allows all defined valid transitions", () => {
      for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
        for (const to of targets) {
          expect(() =>
            validateTransition("test-task", from as TaskStatus, to),
          ).not.toThrow();
        }
      }
    });

    it("rejects transitions from terminal states", () => {
      const allStatuses = [...TASK_STATUSES];
      for (const terminal of TERMINAL_STATUSES) {
        for (const target of allStatuses) {
          if (terminal === target) continue;
          expect(() =>
            validateTransition("test-task", terminal, target),
          ).toThrow(InvalidTransitionError);
        }
      }
    });

    it("rejects invalid transitions from non-terminal states", () => {
      // pending cannot go directly to approved
      expect(() =>
        validateTransition("test-task", "pending", "approved"),
      ).toThrow(InvalidTransitionError);

      // in_progress cannot go directly to approved
      expect(() =>
        validateTransition("test-task", "in_progress", "approved"),
      ).toThrow(InvalidTransitionError);

      // completed cannot go back to pending
      expect(() =>
        validateTransition("test-task", "completed", "pending"),
      ).toThrow(InvalidTransitionError);

      // revision cannot go directly to completed (must go through in_progress)
      expect(() =>
        validateTransition("test-task", "revision", "completed"),
      ).toThrow(InvalidTransitionError);
    });

    it("allows the standard execution path: pending → in_progress → completed → approved", () => {
      expect(() => validateTransition("t1", "pending", "in_progress")).not.toThrow();
      expect(() => validateTransition("t1", "in_progress", "completed")).not.toThrow();
      expect(() => validateTransition("t1", "completed", "approved")).not.toThrow();
    });

    it("allows the revision loop: completed → revision → in_progress → completed", () => {
      expect(() => validateTransition("t1", "completed", "revision")).not.toThrow();
      expect(() => validateTransition("t1", "revision", "in_progress")).not.toThrow();
      expect(() => validateTransition("t1", "in_progress", "completed")).not.toThrow();
    });

    it("allows budget-related transitions", () => {
      expect(() => validateTransition("t1", "pending", "blocked")).not.toThrow();
      expect(() => validateTransition("t1", "pending", "deferred")).not.toThrow();
      expect(() => validateTransition("t1", "blocked", "pending")).not.toThrow();
      expect(() => validateTransition("t1", "deferred", "pending")).not.toThrow();
    });

    it("allows failure from any non-terminal state", () => {
      const nonTerminal: TaskStatus[] = [
        "pending", "assigned", "in_progress", "completed",
        "in_review", "revision", "blocked", "deferred",
      ];
      for (const status of nonTerminal) {
        expect(() =>
          validateTransition("t1", status, "failed"),
        ).not.toThrow();
      }
    });
  });

  describe("InvalidTransitionError", () => {
    it("contains correct fields", () => {
      const err = new InvalidTransitionError("task-123", "approved", "pending");
      expect(err.taskId).toBe("task-123");
      expect(err.from).toBe("approved");
      expect(err.to).toBe("pending");
      expect(err.name).toBe("InvalidTransitionError");
      expect(err.message).toContain("task-123");
      expect(err.message).toContain("approved");
      expect(err.message).toContain("pending");
    });

    it("is an instance of Error", () => {
      const err = new InvalidTransitionError("t1", "failed", "pending");
      expect(err instanceof Error).toBe(true);
    });
  });
});
