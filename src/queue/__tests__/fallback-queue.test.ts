import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { FallbackQueue } from "../fallback-queue.ts";
import { createTestJobData } from "./helpers.ts";

describe("FallbackQueue", () => {
  let tempDir: string;
  let queue: FallbackQueue;

  beforeEach(async () => {
    tempDir = await mkdtemp(resolve(tmpdir(), "fallback-queue-test-"));
    queue = new FallbackQueue(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("enqueue", () => {
    it("creates a JSON file in the directory", async () => {
      await queue.enqueue(createTestJobData({ taskId: "task-1" }));

      const files = await readdir(tempDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toEndWith(".json");
      expect(files[0]).toContain("task-1");
    });

    it("encodes priority in the filename", async () => {
      await queue.enqueue(createTestJobData({ taskId: "t1", priority: "P0" }));
      await queue.enqueue(createTestJobData({ taskId: "t2", priority: "P3" }));

      const files = (await readdir(tempDir)).sort();
      expect(files[0]).toMatch(/^001-/); // P0 = priority 1
      expect(files[1]).toMatch(/^020-/); // P3 = priority 20
    });
  });

  describe("drain", () => {
    it("returns jobs in priority order", async () => {
      await queue.enqueue(createTestJobData({ taskId: "low", priority: "P3" }));
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));
      await queue.enqueue(createTestJobData({ taskId: "high", priority: "P0" }));

      const jobs = await queue.drain();
      expect(jobs).toHaveLength(2);
      expect(jobs[0]!.taskId).toBe("high");  // P0 first (001- sorts before 020-)
      expect(jobs[1]!.taskId).toBe("low");   // P3 second
    });

    it("deletes files after draining", async () => {
      await queue.enqueue(createTestJobData({ taskId: "t1" }));
      await queue.enqueue(createTestJobData({ taskId: "t2" }));

      await queue.drain();

      const files = await readdir(tempDir);
      expect(files).toHaveLength(0);
    });

    it("returns empty array when no jobs", async () => {
      const jobs = await queue.drain();
      expect(jobs).toEqual([]);
    });

    it("preserves all job data fields", async () => {
      const original = createTestJobData({
        taskId: "test-task",
        skill: "copywriting",
        priority: "P1",
        goalId: "goal-1",
        pipelineId: "pipe-1",
      });

      await queue.enqueue(original);
      const [job] = await queue.drain();

      expect(job!.taskId).toBe("test-task");
      expect(job!.skill).toBe("copywriting");
      expect(job!.priority).toBe("P1");
      expect(job!.goalId).toBe("goal-1");
      expect(job!.pipelineId).toBe("pipe-1");
    });
  });

  describe("peek", () => {
    it("returns 0 for empty queue", async () => {
      expect(await queue.peek()).toBe(0);
    });

    it("returns count of pending jobs", async () => {
      await queue.enqueue(createTestJobData({ taskId: "t1" }));
      await queue.enqueue(createTestJobData({ taskId: "t2" }));
      await queue.enqueue(createTestJobData({ taskId: "t3" }));

      expect(await queue.peek()).toBe(3);
    });

    it("does not consume jobs", async () => {
      await queue.enqueue(createTestJobData({ taskId: "t1" }));

      await queue.peek();
      await queue.peek();

      expect(await queue.peek()).toBe(1);
    });
  });

  describe("isEmpty", () => {
    it("returns true for empty queue", async () => {
      expect(await queue.isEmpty()).toBe(true);
    });

    it("returns false when jobs exist", async () => {
      await queue.enqueue(createTestJobData({ taskId: "t1" }));
      expect(await queue.isEmpty()).toBe(false);
    });

    it("returns true after drain", async () => {
      await queue.enqueue(createTestJobData({ taskId: "t1" }));
      await queue.drain();
      expect(await queue.isEmpty()).toBe(true);
    });
  });

  describe("directory creation", () => {
    it("creates the directory if it does not exist", async () => {
      const nestedDir = resolve(tempDir, "sub", "dir");
      const nestedQueue = new FallbackQueue(nestedDir);

      await nestedQueue.enqueue(createTestJobData({ taskId: "t1" }));

      const files = await readdir(nestedDir);
      expect(files).toHaveLength(1);
    });
  });
});
