import { describe, expect, it } from "bun:test";
import { BufferLogger, NULL_LOGGER } from "../logger.ts";
import { AgentExecutor } from "../../agents/executor.ts";
import { CompletionRouter } from "../../queue/completion-router.ts";
import type { ClaudeClient } from "../../agents/claude-client.ts";
import type { WorkspaceManager } from "../../workspace/workspace-manager.ts";
import type { ExecutorConfig, ExecutionResult } from "../../agents/executor.ts";
import type { Task } from "../../types/task.ts";
import type { MarketingDirector } from "../../director/director.ts";

// ── Minimal mocks ──────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-001",
    skill: "copywriting",
    squad: "creative",
    status: "pending",
    priority: "medium",
    input: { brief: "Write a landing page headline" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeMockClient(): ClaudeClient {
  return {
    createMessage: async () => ({
      content: "Generated copy",
      model: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 50,
      stopReason: "end_turn" as const,
      durationMs: 500,
    }),
  };
}

function makeMockWorkspace(): WorkspaceManager {
  return {
    readTask: async () => makeTask(),
    updateTask: async () => {},
    writeOutput: async () => "/outputs/task-001.md",
    readLearnings: async () => [],
    init: async () => {},
    createTask: async () => "task-001",
    listTasks: async () => [],
    deleteTask: async () => {},
    writeReview: async () => {},
    readReviews: async () => [],
    readOutput: async () => null,
    appendLearning: async () => {},
  } as unknown as WorkspaceManager;
}

const testExecutorConfig: ExecutorConfig = {
  projectRoot: "/tmp/test",
  defaultModel: "sonnet",
  defaultTimeoutMs: 5_000,
  defaultMaxTokens: 4096,
  maxRetries: 1,
  maxContextTokens: 150_000,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Logger integration", () => {
  describe("BufferLogger child bindings", () => {
    it("child logger includes module binding in all log entries", () => {
      const root = new BufferLogger();
      const child = root.child({ module: "executor" });
      child.info("test_event", { extra: "data" });

      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!.data).toEqual({
        module: "executor",
        extra: "data",
      });
    });

    it("nested child loggers merge bindings", () => {
      const root = new BufferLogger();
      const child1 = root.child({ module: "director" });
      const child2 = child1.child({ submodule: "review" });
      child2.info("test_event");

      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!.data).toEqual({
        module: "director",
        submodule: "review",
      });
    });

    it("parent sees all child log entries", () => {
      const root = new BufferLogger();
      const child1 = root.child({ module: "a" });
      const child2 = root.child({ module: "b" });

      child1.info("from_a");
      child2.warn("from_b");
      root.error("from_root");

      expect(root.entries).toHaveLength(3);
      expect(root.entries.map((e) => e.msg)).toEqual([
        "from_a",
        "from_b",
        "from_root",
      ]);
    });
  });

  describe("NullLogger produces zero output", () => {
    it("NullLogger.child returns itself (singleton)", () => {
      const child = NULL_LOGGER.child({ module: "test" });
      expect(child).toBe(NULL_LOGGER);
    });

    it("NullLogger does not capture entries (no shared state pollution)", () => {
      NULL_LOGGER.info("should_vanish", { key: "value" });
      NULL_LOGGER.error("also_vanish");
      NULL_LOGGER.debug("gone");

      // NullLogger has no entries property — verify it doesn't throw
      expect(() => NULL_LOGGER.info("safe")).not.toThrow();
    });
  });

  describe("AgentExecutor logs through BufferLogger", () => {
    it("logs executor_task_started on execute", async () => {
      const logger = new BufferLogger();
      const executor = new AgentExecutor(
        makeMockClient(),
        makeMockWorkspace(),
        testExecutorConfig,
        logger,
      );

      const task = makeTask({ status: "pending" });
      try {
        await executor.execute(task);
      } catch {
        // May fail due to skill loading — that's fine, we just check initial log
      }

      expect(logger.has("debug", "executor_task_started")).toBe(true);
      // Verify module binding propagated
      const startEntry = logger.entries.find((e) =>
        e.msg === "executor_task_started"
      );
      expect(startEntry?.data?.module).toBe("executor");
    });
  });

  describe("CompletionRouter logs through BufferLogger", () => {
    it("logs router_route_started on route", async () => {
      const logger = new BufferLogger();
      const mockDirector = {
        reviewCompletedTask: async () => ({
          verdict: "approve",
          action: "none",
          findings: [],
        }),
      } as unknown as MarketingDirector;

      const router = new CompletionRouter(
        makeMockWorkspace(),
        mockDirector,
        logger,
      );

      const task = makeTask({
        status: "completed",
        next: { type: "complete" as const },
      });
      const result: ExecutionResult = {
        taskId: "task-001",
        skill: "copywriting",
        status: "completed",
        content: "Generated copy",
        outputPath: "/outputs/task-001.md",
        metadata: {
          model: "claude-sonnet-4-20250514",
          modelTier: "sonnet" as const,
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 500,
          estimatedCost: 0.001,
          retryCount: 0,
        },
        truncated: false,
        missingInputs: [],
        warnings: [],
      };
      try {
        await router.route(task, result);
      } catch {
        // May fail — we just check the log was emitted
      }

      expect(logger.has("debug", "router_route_started")).toBe(true);
      const routeEntry = logger.entries.find((e) =>
        e.msg === "router_route_started"
      );
      expect(routeEntry?.data?.module).toBe("completion-router");
    });
  });

  describe("Modules default to NullLogger silently", () => {
    it("AgentExecutor works without logger (backward compat)", () => {
      // No logger param = uses NULL_LOGGER internally
      const executor = new AgentExecutor(
        makeMockClient(),
        makeMockWorkspace(),
        testExecutorConfig,
      );
      expect(executor).toBeDefined();
    });

    it("CompletionRouter works without logger (backward compat)", () => {
      const router = new CompletionRouter(
        makeMockWorkspace(),
        {} as unknown as MarketingDirector,
      );
      expect(router).toBeDefined();
    });
  });
});
