import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createWorkerProcessor } from "../worker.ts";
import { BudgetDeferralError, CascadePauseError, TaskExecutionError } from "../types.ts";
import { FailureTracker } from "../failure-tracker.ts";
import { CompletionRouter } from "../completion-router.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import { MarketingDirector } from "../../director/director.ts";
import { AgentExecutor } from "../../executor/agent-executor.ts";
import { MockClaudeClient } from "../../executor/claude-client.ts";
import { createDefaultConfig } from "../../executor/types.ts";
import { createTestTask, createTestBudgetState, createTestJobData } from "./helpers.ts";
import type { SkillName } from "../../types/agent.ts";
import type { BudgetState } from "../../director/types.ts";
import type { ProcessorFn } from "../types.ts";

describe("createWorkerProcessor", () => {
  let tempDir: string;
  let workspace: FileSystemWorkspaceManager;
  let director: MarketingDirector;
  let executor: AgentExecutor;
  let failureTracker: FailureTracker;
  let completionRouter: CompletionRouter;
  let budgetState: BudgetState;
  let processor: ProcessorFn;

  beforeEach(async () => {
    tempDir = await mkdtemp(resolve(tmpdir(), "worker-test-"));
    workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
    await workspace.init();
    director = new MarketingDirector(workspace);
    failureTracker = new FailureTracker(3);
    completionRouter = new CompletionRouter(workspace, director);

    const mockClient = new MockClaudeClient();
    const config = createDefaultConfig({ projectRoot: process.cwd() });
    executor = new AgentExecutor(mockClient, workspace, config);

    budgetState = createTestBudgetState("normal");

    processor = createWorkerProcessor({
      workspace,
      executor,
      budgetProvider: () => budgetState,
      failureTracker,
      completionRouter,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("budget check", () => {
    it("throws BudgetDeferralError when priority not allowed", async () => {
      budgetState = createTestBudgetState("critical"); // only P0 allowed

      const task = createTestTask({ priority: "P2" });
      await workspace.writeTask(task);

      const job = {
        data: createTestJobData({ taskId: task.id, priority: "P2" }),
        id: task.id,
        attemptsMade: 0,
      };

      try {
        await processor(job);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetDeferralError);
        expect((err as BudgetDeferralError).taskId).toBe(task.id);
        expect((err as BudgetDeferralError).priority).toBe("P2");
      }
    });

    it("passes budget check when priority is allowed", async () => {
      budgetState = createTestBudgetState("normal");

      const task = createTestTask({
        priority: "P2",
        next: { type: "complete" },
      });
      await workspace.writeTask(task);

      const job = {
        data: createTestJobData({ taskId: task.id, priority: "P2" }),
        id: task.id,
        attemptsMade: 0,
      };

      // This will fail at execution (mock client returns generic response)
      // but shouldn't throw BudgetDeferralError
      try {
        await processor(job);
      } catch (err) {
        expect(err).not.toBeInstanceOf(BudgetDeferralError);
      }
    });
  });

  describe("cascade check", () => {
    it("throws CascadePauseError when cascade threshold reached", async () => {
      // Trigger cascade threshold
      failureTracker.recordFailure("t1", "pipe-a");
      failureTracker.recordFailure("t2", "pipe-a");
      failureTracker.recordFailure("t3", "pipe-a");

      const task = createTestTask({ pipelineId: "pipe-a" });
      await workspace.writeTask(task);

      const job = {
        data: createTestJobData({ taskId: task.id, pipelineId: "pipe-a" }),
        id: task.id,
        attemptsMade: 0,
      };

      try {
        await processor(job);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CascadePauseError);
      }
    });
  });

  describe("execution failure", () => {
    it("throws TaskExecutionError and records failure", async () => {
      // Create a task with a skill that won't load (to trigger executor failure)
      const task = createTestTask({
        to: "copywriting" as SkillName,
        status: "pending",
        next: { type: "complete" },
        // Use non-existent input to force failure
        inputs: [{ path: "nonexistent/file.md", description: "missing" }],
      });
      await workspace.writeTask(task);

      const job = {
        data: createTestJobData({ taskId: task.id }),
        id: task.id,
        attemptsMade: 0,
      };

      try {
        await processor(job);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskExecutionError);
      }

      // Verify failure was tracked
      const counts = failureTracker.getFailureCounts();
      expect(counts.get("__global__")).toBe(1);
    });
  });
});
