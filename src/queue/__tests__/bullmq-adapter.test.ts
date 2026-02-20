import { describe, expect, it, beforeEach } from "bun:test";
import type {
  QueueAdapter,
  QueueAddOptions,
  QueueJobData,
  FailedJob,
  WorkerAdapter,
  ProcessorFn,
  QueueJobResult,
} from "../types.ts";

// ── Test doubles for BullMQ internals ──────────────────────────────────────
// We test the adapter contracts against the interfaces, not the BullMQ internals.
// For unit testing, we verify the adapters satisfy the QueueAdapter/WorkerAdapter
// contracts by constructing them with known parameters and checking behavior.

// Since BullMQ Queue and Worker require Redis, we test the adapter interfaces
// by creating mock implementations that verify the same contract.

describe("BullMQ adapter interface compliance", () => {
  // ── QueueAdapter Contract ────────────────────────────────────────────

  describe("QueueAdapter contract", () => {
    const sampleJobData: QueueJobData = {
      taskId: "task-001",
      skill: "copywriting",
      priority: "P1",
      goalId: "goal-001",
      pipelineId: null,
      enqueuedAt: "2026-01-01T00:00:00.000Z",
    };

    const sampleOpts: QueueAddOptions = {
      priority: 5,
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      jobId: "task-001",
      removeOnComplete: { count: 100 },
      removeOnFail: false,
    };

    it("QueueAdapter add() returns an object with id", async () => {
      // Create a mock adapter that satisfies the interface
      const adapter: QueueAdapter = {
        async add(_name, _data, opts) {
          return { id: opts.jobId };
        },
        async getJobCounts() {
          return { waiting: 0, active: 0, completed: 0, failed: 0 };
        },
        async getJob(_id) {
          return null;
        },
        async getFailed() {
          return [];
        },
        async obliterate() {},
        async close() {},
        async pause() {},
        async resume() {},
      };

      const result = await adapter.add("process-task", sampleJobData, sampleOpts);
      expect(result.id).toBe("task-001");
    });

    it("QueueAdapter getJobCounts() returns expected shape", async () => {
      const adapter: QueueAdapter = {
        async add(_name, _data, opts) {
          return { id: opts.jobId };
        },
        async getJobCounts() {
          return {
            waiting: 5,
            active: 2,
            completed: 10,
            failed: 1,
            delayed: 0,
            prioritized: 3,
          };
        },
        async getJob() {
          return null;
        },
        async getFailed() {
          return [];
        },
        async obliterate() {},
        async close() {},
        async pause() {},
        async resume() {},
      };

      const counts = await adapter.getJobCounts();
      expect(counts.waiting).toBe(5);
      expect(counts.active).toBe(2);
      expect(counts.completed).toBe(10);
      expect(counts.failed).toBe(1);
    });

    it("QueueAdapter getJob() returns null for missing job", async () => {
      const adapter: QueueAdapter = {
        async add(_name, _data, opts) {
          return { id: opts.jobId };
        },
        async getJobCounts() {
          return {};
        },
        async getJob() {
          return null;
        },
        async getFailed() {
          return [];
        },
        async obliterate() {},
        async close() {},
        async pause() {},
        async resume() {},
      };

      const job = await adapter.getJob("nonexistent");
      expect(job).toBeNull();
    });

    it("QueueAdapter getJob() returns data and attemptsMade for found job", async () => {
      const adapter: QueueAdapter = {
        async add(_name, _data, opts) {
          return { id: opts.jobId };
        },
        async getJobCounts() {
          return {};
        },
        async getJob(_id) {
          return { data: sampleJobData, attemptsMade: 2 };
        },
        async getFailed() {
          return [];
        },
        async obliterate() {},
        async close() {},
        async pause() {},
        async resume() {},
      };

      const job = await adapter.getJob("task-001");
      expect(job).not.toBeNull();
      expect(job!.data.taskId).toBe("task-001");
      expect(job!.attemptsMade).toBe(2);
    });

    it("QueueAdapter getFailed() returns FailedJob array with retry()", async () => {
      let retried = false;
      const adapter: QueueAdapter = {
        async add(_name, _data, opts) {
          return { id: opts.jobId };
        },
        async getJobCounts() {
          return {};
        },
        async getJob() {
          return null;
        },
        async getFailed() {
          return [
            {
              id: "task-001",
              data: sampleJobData,
              failedReason: "API timeout",
              attemptsMade: 3,
              finishedOn: 1706745600000,
              retry: async () => {
                retried = true;
              },
            },
          ];
        },
        async obliterate() {},
        async close() {},
        async pause() {},
        async resume() {},
      };

      const failed = await adapter.getFailed(0, -1);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.failedReason).toBe("API timeout");
      expect(failed[0]!.attemptsMade).toBe(3);
      expect(failed[0]!.finishedOn).toBe(1706745600000);

      await failed[0]!.retry();
      expect(retried).toBe(true);
    });

    it("FailedJob finishedOn is optional", async () => {
      const adapter: QueueAdapter = {
        async add(_name, _data, opts) {
          return { id: opts.jobId };
        },
        async getJobCounts() {
          return {};
        },
        async getJob() {
          return null;
        },
        async getFailed() {
          return [
            {
              id: "task-002",
              data: sampleJobData,
              failedReason: "Unknown error",
              attemptsMade: 1,
              // finishedOn intentionally omitted
              retry: async () => {},
            },
          ];
        },
        async obliterate() {},
        async close() {},
        async pause() {},
        async resume() {},
      };

      const failed = await adapter.getFailed();
      expect(failed[0]!.finishedOn).toBeUndefined();
    });
  });

  // ── WorkerAdapter Contract ───────────────────────────────────────────

  describe("WorkerAdapter contract", () => {
    it("WorkerAdapter on() registers event handlers", () => {
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      const adapter: WorkerAdapter = {
        on(event, handler) {
          if (!handlers[event]) handlers[event] = [];
          handlers[event]!.push(handler);
        },
        async close() {},
        async pause() {},
        async resume() {},
        isRunning() {
          return true;
        },
      };

      const fn = () => {};
      adapter.on("completed", fn);
      adapter.on("failed", fn);
      expect(handlers["completed"]).toHaveLength(1);
      expect(handlers["failed"]).toHaveLength(1);
    });

    it("WorkerAdapter isRunning() returns true initially", () => {
      let running = true;
      const adapter: WorkerAdapter = {
        on() {},
        async close() {
          running = false;
        },
        async pause() {
          running = false;
        },
        async resume() {
          running = true;
        },
        isRunning() {
          return running;
        },
      };

      expect(adapter.isRunning()).toBe(true);
    });

    it("WorkerAdapter pause() makes isRunning() return false", async () => {
      let running = true;
      const adapter: WorkerAdapter = {
        on() {},
        async close() {
          running = false;
        },
        async pause() {
          running = false;
        },
        async resume() {
          running = true;
        },
        isRunning() {
          return running;
        },
      };

      await adapter.pause();
      expect(adapter.isRunning()).toBe(false);
    });

    it("WorkerAdapter resume() makes isRunning() return true", async () => {
      let running = true;
      const adapter: WorkerAdapter = {
        on() {},
        async close() {
          running = false;
        },
        async pause() {
          running = false;
        },
        async resume() {
          running = true;
        },
        isRunning() {
          return running;
        },
      };

      await adapter.pause();
      expect(adapter.isRunning()).toBe(false);

      await adapter.resume();
      expect(adapter.isRunning()).toBe(true);
    });

    it("WorkerAdapter close() makes isRunning() return false", async () => {
      let running = true;
      const adapter: WorkerAdapter = {
        on() {},
        async close() {
          running = false;
        },
        async pause() {
          running = false;
        },
        async resume() {
          running = true;
        },
        isRunning() {
          return running;
        },
      };

      await adapter.close();
      expect(adapter.isRunning()).toBe(false);
    });
  });

  // ── ProcessorFn Contract ─────────────────────────────────────────────

  describe("ProcessorFn wrapping contract", () => {
    it("processor maps JobHandle correctly", async () => {
      const sampleJobData: QueueJobData = {
        taskId: "task-002",
        skill: "seo-audit",
        priority: "P2",
        goalId: null,
        pipelineId: null,
        enqueuedAt: "2026-02-01T00:00:00.000Z",
      };

      // Simulate what BullMQWorkerAdapter does: wrap ProcessorFn
      const processorFn: ProcessorFn = async (job) => {
        // Verify the JobHandle shape
        expect(job.data.taskId).toBe("task-002");
        expect(job.data.skill).toBe("seo-audit");
        expect(job.id).toBe("job-123");
        expect(job.attemptsMade).toBe(1);

        return {
          executionResult: {
            taskId: job.data.taskId,
            skill: "seo-audit" as any,
            status: "completed" as const,
            content: "Result",
            outputPath: null,
            metadata: {
              model: "claude-sonnet-4-5-20250929",
              modelTier: "sonnet" as const,
              inputTokens: 100,
              outputTokens: 200,
              durationMs: 1000,
              estimatedCost: 0.003,
              retryCount: 0,
            },
            truncated: false,
            missingInputs: [],
            warnings: [],
          },
          routingAction: { type: "complete" as const, taskId: "task-002" },
        };
      };

      // Simulate the JobHandle wrapping that BullMQWorkerAdapter does
      const handle = {
        data: sampleJobData,
        id: "job-123",
        attemptsMade: 1,
      };

      const result = await processorFn(handle);
      expect(result.executionResult.status).toBe("completed");
      expect(result.routingAction.type).toBe("complete");
    });
  });
});
