import { describe, expect, it } from "bun:test";
import { runWithConcurrency } from "../concurrency.ts";
import type { ConcurrencyOptions } from "../concurrency.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A result type for testing — has a status field like ExecutionResult. */
interface MockResult {
  index: number;
  status: "completed" | "failed";
}

/** Create a task that resolves after a delay. */
function delayedTask(
  index: number,
  delayMs: number,
  status: "completed" | "failed" = "completed",
): (signal: AbortSignal) => Promise<MockResult> {
  return (signal: AbortSignal) =>
    new Promise<MockResult>((resolve, reject) => {
      if (signal.aborted) {
        resolve({ index, status: "failed" });
        return;
      }

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve({ index, status });
      }, delayMs);

      function onAbort() {
        clearTimeout(timer);
        resolve({ index, status: "failed" });
      }

      signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** Create a task that resolves immediately. */
function immediateTask(
  index: number,
  status: "completed" | "failed" = "completed",
): (signal: AbortSignal) => Promise<MockResult> {
  return (_signal: AbortSignal) =>
    Promise.resolve({ index, status });
}

const isFailed = (r: MockResult) => r.status === "failed";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runWithConcurrency — happy path", () => {
  it("executes all tasks and returns results in input order", async () => {
    const tasks = [
      immediateTask(0),
      immediateTask(1),
      immediateTask(2),
      immediateTask(3),
      immediateTask(4),
    ];

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 3,
      isFailed,
    });

    expect(result.results).toHaveLength(5);
    expect(result.firstFailureIndex).toBeNull();
    expect(result.aborted).toBe(false);
    // Verify input order
    for (let i = 0; i < 5; i++) {
      expect(result.results[i]!.index).toBe(i);
      expect(result.results[i]!.status).toBe("completed");
    }
  });

  it("handles single task", async () => {
    const result = await runWithConcurrency({
      tasks: [immediateTask(0)],
      maxConcurrency: 3,
      isFailed,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.index).toBe(0);
    expect(result.firstFailureIndex).toBeNull();
    expect(result.aborted).toBe(false);
  });

  it("handles empty tasks array", async () => {
    const result = await runWithConcurrency({
      tasks: [],
      maxConcurrency: 3,
      isFailed,
    });

    expect(result.results).toHaveLength(0);
    expect(result.firstFailureIndex).toBeNull();
    expect(result.aborted).toBe(false);
  });

  it("works when maxConcurrency > task count", async () => {
    const tasks = [immediateTask(0), immediateTask(1)];

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 10,
      isFailed,
    });

    expect(result.results).toHaveLength(2);
    expect(result.firstFailureIndex).toBeNull();
  });
});

describe("runWithConcurrency — concurrency enforcement", () => {
  it("respects maxConcurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 5 }, (_, i) => {
      return (signal: AbortSignal) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        return new Promise<MockResult>((resolve) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            concurrent--;
            resolve({ index: i, status: "completed" });
          }, 30);

          function onAbort() {
            clearTimeout(timer);
            concurrent--;
            resolve({ index: i, status: "failed" });
          }

          signal.addEventListener("abort", onAbort, { once: true });
        });
      };
    });

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 2,
      isFailed,
    });

    expect(result.results).toHaveLength(5);
    expect(result.firstFailureIndex).toBeNull();
    expect(maxConcurrent).toBe(2);
  });

  it("maxConcurrency=1 executes tasks sequentially", async () => {
    const executionOrder: number[] = [];

    const tasks = Array.from({ length: 4 }, (_, i) => {
      return (_signal: AbortSignal) => {
        executionOrder.push(i);
        return Promise.resolve<MockResult>({ index: i, status: "completed" });
      };
    });

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 1,
      isFailed,
    });

    expect(result.results).toHaveLength(4);
    // With concurrency=1, tasks must execute in exact input order
    expect(executionOrder).toEqual([0, 1, 2, 3]);
  });
});

describe("runWithConcurrency — fail-fast", () => {
  it("stops launching tasks after first failure", async () => {
    const started: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) => {
      return (signal: AbortSignal) => {
        started.push(i);
        if (i === 1) {
          // Task 1 fails immediately
          return Promise.resolve<MockResult>({ index: i, status: "failed" });
        }
        // Other tasks take time
        return new Promise<MockResult>((resolve) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve({ index: i, status: "completed" });
          }, 100);

          function onAbort() {
            clearTimeout(timer);
            resolve({ index: i, status: "failed" });
          }

          signal.addEventListener("abort", onAbort, { once: true });
        });
      };
    });

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 2,
      isFailed,
    });

    expect(result.firstFailureIndex).toBe(1);
    // Tasks 0 and 1 were launched (concurrency=2), tasks 2-4 were never started
    expect(started).not.toContain(3);
    expect(started).not.toContain(4);
    // Results only include started tasks
    expect(result.results.length).toBeLessThanOrEqual(started.length);
  });

  it("aborts in-flight sibling tasks on failure", async () => {
    const abortedTasks: number[] = [];

    const tasks = Array.from({ length: 3 }, (_, i) => {
      return (signal: AbortSignal) => {
        if (i === 0) {
          // Task 0 fails after a tiny delay
          return new Promise<MockResult>((resolve) => {
            setTimeout(() => resolve({ index: 0, status: "failed" }), 10);
          });
        }
        // Tasks 1 and 2 wait for abort
        return new Promise<MockResult>((resolve) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve({ index: i, status: "completed" });
          }, 200);

          function onAbort() {
            clearTimeout(timer);
            abortedTasks.push(i);
            resolve({ index: i, status: "failed" });
          }

          signal.addEventListener("abort", onAbort, { once: true });
        });
      };
    });

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 3,
      isFailed,
    });

    expect(result.firstFailureIndex).toBe(0);
    // Sibling tasks should have received the abort signal
    expect(abortedTasks.length).toBeGreaterThan(0);
  });

  it("sets firstFailureIndex to the earliest failing task index", async () => {
    // Two tasks fail, but task 1 is the first by index
    const tasks = [
      delayedTask(0, 50, "completed"),
      delayedTask(1, 10, "failed"),     // fails first chronologically AND by index
      delayedTask(2, 20, "failed"),     // also would fail, but index 1 wins
      delayedTask(3, 100, "completed"),
    ];

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 4,
      isFailed,
    });

    expect(result.firstFailureIndex).toBe(1);
  });
});

describe("runWithConcurrency — parent abort", () => {
  it("returns aborted=true when parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runWithConcurrency({
      tasks: [immediateTask(0), immediateTask(1)],
      maxConcurrency: 2,
      signal: controller.signal,
      isFailed,
    });

    expect(result.aborted).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it("cancels in-flight tasks when parent signal fires", async () => {
    const controller = new AbortController();

    const tasks = Array.from({ length: 3 }, (_, i) => {
      return (signal: AbortSignal) =>
        new Promise<MockResult>((resolve) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve({ index: i, status: "completed" });
          }, 200);

          function onAbort() {
            clearTimeout(timer);
            resolve({ index: i, status: "failed" });
          }

          signal.addEventListener("abort", onAbort, { once: true });
        });
    });

    // Abort after 30ms
    setTimeout(() => controller.abort(), 30);

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 3,
      signal: controller.signal,
      isFailed,
    });

    expect(result.aborted).toBe(true);
  });
});

describe("runWithConcurrency — results ordering", () => {
  it("returns results in input order regardless of completion order", async () => {
    // Task 0 takes longest, task 2 completes first
    const tasks = [
      delayedTask(0, 60),   // slowest
      delayedTask(1, 30),   // medium
      delayedTask(2, 10),   // fastest
    ];

    const result = await runWithConcurrency({
      tasks,
      maxConcurrency: 3,
      isFailed,
    });

    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.index).toBe(0);
    expect(result.results[1]!.index).toBe(1);
    expect(result.results[2]!.index).toBe(2);
  });
});
