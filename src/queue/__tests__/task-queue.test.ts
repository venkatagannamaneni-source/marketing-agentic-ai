import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TaskQueueManager } from "../task-queue.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import { MarketingDirector } from "../../director/director.ts";
import { AgentExecutor } from "../../executor/agent-executor.ts";
import { MockClaudeClient } from "../../executor/claude-client.ts";
import { createDefaultConfig } from "../../executor/types.ts";
import {
  MockQueueAdapter,
  MockWorkerAdapter,
  MockRedisClient,
  createTestTask,
  createTestBudgetState,
  createTestJobData,
} from "./helpers.ts";
import { createRedisConnectionFromClient } from "../redis-connection.ts";
import type { BudgetState } from "../../director/types.ts";

describe("TaskQueueManager", () => {
  let tempDir: string;
  let workspace: FileSystemWorkspaceManager;
  let director: MarketingDirector;
  let executor: AgentExecutor;
  let mockQueue: MockQueueAdapter;
  let mockWorker: MockWorkerAdapter;
  let mockRedis: MockRedisClient;
  let budgetState: BudgetState;
  let manager: TaskQueueManager;
  let fallbackDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(resolve(tmpdir(), "task-queue-test-"));
    fallbackDir = resolve(tempDir, "fallback");
    workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
    await workspace.init();
    director = new MarketingDirector(workspace);

    const mockClient = new MockClaudeClient();
    const config = createDefaultConfig({ projectRoot: process.cwd() });
    executor = new AgentExecutor(mockClient, workspace, config);

    mockQueue = new MockQueueAdapter();
    mockWorker = new MockWorkerAdapter();
    mockRedis = new MockRedisClient();
    budgetState = createTestBudgetState("normal");

    manager = new TaskQueueManager({
      config: {
        fallbackDir,
        healthCheckIntervalMs: 60_000, // Long interval to avoid timer in tests
      },
      workspace,
      director,
      executor,
      budgetProvider: () => budgetState,
      queue: mockQueue,
      worker: mockWorker,
      redis: createRedisConnectionFromClient(mockRedis),
    });
  });

  afterEach(async () => {
    await manager.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("enqueue", () => {
    it("adds a job to the queue with correct priority mapping", async () => {
      const task = createTestTask({ priority: "P0" });
      await workspace.writeTask(task);

      const result = await manager.enqueue(task);

      expect(result).toBe("enqueued");
      expect(mockQueue.jobs).toHaveLength(1);
      expect(mockQueue.jobs[0]!.data.taskId).toBe(task.id);
      expect(mockQueue.jobs[0]!.opts.priority).toBe(1); // P0 = 1
    });

    it("maps P2 to priority 10", async () => {
      const task = createTestTask({ priority: "P2" });
      await workspace.writeTask(task);

      await manager.enqueue(task);

      expect(mockQueue.jobs[0]!.opts.priority).toBe(10);
    });

    it("maps P3 to priority 20", async () => {
      const task = createTestTask({ priority: "P3" });
      await workspace.writeTask(task);

      await manager.enqueue(task);

      expect(mockQueue.jobs[0]!.opts.priority).toBe(20);
    });

    it("sets retry config from queue config", async () => {
      const task = createTestTask();
      await workspace.writeTask(task);

      await manager.enqueue(task);

      const opts = mockQueue.jobs[0]!.opts;
      expect(opts.attempts).toBe(3);
      expect(opts.backoff.type).toBe("exponential");
      expect(opts.backoff.delay).toBe(2000);
    });

    it("uses taskId as jobId", async () => {
      const task = createTestTask({ id: "my-task-id" });
      await workspace.writeTask(task);

      await manager.enqueue(task);

      expect(mockQueue.jobs[0]!.opts.jobId).toBe("my-task-id");
    });

    it("preserves job data fields", async () => {
      const task = createTestTask({
        goalId: "goal-123",
        pipelineId: "pipe-456",
        to: "copywriting",
        priority: "P1",
      });
      await workspace.writeTask(task);

      await manager.enqueue(task);

      const data = mockQueue.jobs[0]!.data;
      expect(data.taskId).toBe(task.id);
      expect(data.skill).toBe("copywriting");
      expect(data.priority).toBe("P1");
      expect(data.goalId).toBe("goal-123");
      expect(data.pipelineId).toBe("pipe-456");
      expect(data.enqueuedAt).toBeTruthy();
    });
  });

  describe("enqueue with budget deferral", () => {
    it("defers task when budget does not allow its priority", async () => {
      budgetState = createTestBudgetState("throttle"); // only P0, P1

      const task = createTestTask({ priority: "P2" });
      await workspace.writeTask(task);

      const result = await manager.enqueue(task);

      expect(result).toBe("deferred");
      expect(mockQueue.jobs).toHaveLength(0);

      // Verify task status was updated
      const updated = await workspace.readTask(task.id);
      expect(updated.status).toBe("deferred");
    });

    it("defers all tasks when budget is exhausted", async () => {
      budgetState = createTestBudgetState("exhausted");

      const task = createTestTask({ priority: "P0" });
      await workspace.writeTask(task);

      const result = await manager.enqueue(task);
      expect(result).toBe("deferred");
    });
  });

  describe("enqueue with Redis fallback", () => {
    it("falls back to file queue when Redis is down", async () => {
      mockQueue.shouldThrowOnAdd = true;

      const task = createTestTask();
      await workspace.writeTask(task);

      const result = await manager.enqueue(task);

      expect(result).toBe("fallback");
      expect(mockQueue.jobs).toHaveLength(0);
    });
  });

  describe("enqueueBatch", () => {
    it("enqueues multiple tasks", async () => {
      const tasks = [
        createTestTask({ id: "t1", priority: "P0" }),
        createTestTask({ id: "t2", priority: "P1" }),
        createTestTask({ id: "t3", priority: "P2" }),
      ];

      for (const t of tasks) await workspace.writeTask(t);
      await manager.enqueueBatch(tasks);

      expect(mockQueue.jobs).toHaveLength(3);
      expect(mockQueue.jobs[0]!.data.taskId).toBe("t1");
      expect(mockQueue.jobs[1]!.data.taskId).toBe("t2");
      expect(mockQueue.jobs[2]!.data.taskId).toBe("t3");
    });
  });

  describe("lifecycle", () => {
    it("start and stop", async () => {
      await manager.start();
      // Should not throw on double start
      await manager.start();

      await manager.stop();
      expect(mockWorker.isClosed()).toBe(true);
      expect(mockQueue.isClosed()).toBe(true);
    });

    it("pause and resume", async () => {
      await manager.pause();
      expect(mockQueue.isPaused()).toBe(true);

      await manager.resume();
      expect(mockQueue.isPaused()).toBe(false);
    });
  });

  describe("getHealth", () => {
    it("returns healthy status when everything is up", async () => {
      const health = await manager.getHealth();

      expect(health.redis.status).toBe("healthy");
      expect(health.queue.status).toBe("healthy");
      expect(health.worker.status).toBe("healthy");
      expect(health.queueDepth).toBeGreaterThanOrEqual(0);
    });

    it("reports redis offline when ping fails", async () => {
      mockRedis.shouldFailPing = true;

      const health = await manager.getHealth();

      expect(health.redis.status).toBe("offline");
      expect(health.queue.status).toBe("degraded");
    });

    it("reports worker offline after close", async () => {
      await mockWorker.close();

      const health = await manager.getHealth();

      expect(health.worker.status).toBe("offline");
    });
  });

  describe("dead letter queue", () => {
    it("returns empty when no failed jobs", async () => {
      const entries = await manager.getDeadLetterEntries();
      expect(entries).toHaveLength(0);
    });

    it("returns dead letter entries", async () => {
      mockQueue.addFailedJob(
        createTestJobData({ taskId: "failed-1", priority: "P1" }),
        "API timeout",
        3,
      );

      const entries = await manager.getDeadLetterEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.taskId).toBe("failed-1");
      expect(entries[0]!.lastError).toBe("API timeout");
      expect(entries[0]!.attempts).toBe(3);
      expect(entries[0]!.originalPriority).toBe("P1");
    });

    it("retries a dead letter job", async () => {
      mockQueue.addFailedJob(
        createTestJobData({ taskId: "failed-1" }),
        "Some error",
        3,
      );

      await manager.retryDeadLetter("failed-1");

      // Job should move from failed to jobs
      const failed = await mockQueue.getFailed();
      expect(failed).toHaveLength(0);
      expect(mockQueue.jobs).toHaveLength(1);
    });

    it("throws when dead letter job not found", async () => {
      try {
        await manager.retryDeadLetter("nonexistent");
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain("No dead-letter job found");
      }
    });
  });

  describe("worker event: completed with enqueue_tasks", () => {
    it("re-enqueues tasks from routing action", async () => {
      const nextTask = createTestTask({ id: "next-task" });
      await workspace.writeTask(nextTask);

      // Simulate worker completing a job with enqueue_tasks routing action
      await mockWorker.emit("completed", { data: createTestJobData() }, {
        executionResult: { taskId: "t1", status: "completed" },
        routingAction: {
          type: "enqueue_tasks",
          tasks: [nextTask],
        },
      });

      expect(mockQueue.jobs).toHaveLength(1);
      expect(mockQueue.jobs[0]!.data.taskId).toBe("next-task");
    });
  });

  describe("worker event: failed", () => {
    it("updates task status to failed", async () => {
      const task = createTestTask({ id: "failing-task" });
      await workspace.writeTask(task);

      await mockWorker.emit(
        "failed",
        { data: createTestJobData({ taskId: "failing-task" }) },
        new Error("Execution failed"),
      );

      const updated = await workspace.readTask("failing-task");
      expect(updated.status).toBe("failed");
    });
  });
});
