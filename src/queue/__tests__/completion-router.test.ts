import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CompletionRouter } from "../completion-router.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import { MarketingDirector } from "../../director/director.ts";
import { createTestTask, createTestExecutionResult } from "./helpers.ts";
import type { SkillName } from "../../types/agent.ts";

describe("CompletionRouter", () => {
  let tempDir: string;
  let workspace: FileSystemWorkspaceManager;
  let director: MarketingDirector;
  let router: CompletionRouter;

  beforeEach(async () => {
    tempDir = await mkdtemp(resolve(tmpdir(), "router-test-"));
    workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
    await workspace.init();
    director = new MarketingDirector(workspace);
    router = new CompletionRouter(workspace, director);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("route with next.type = 'complete'", () => {
    it("returns complete action", async () => {
      const task = createTestTask({
        next: { type: "complete" },
      });
      const result = createTestExecutionResult({ taskId: task.id });

      const action = await router.route(task, result);

      expect(action.type).toBe("complete");
      if (action.type === "complete") {
        expect(action.taskId).toBe(task.id);
      }
    });
  });

  describe("route with next.type = 'agent'", () => {
    it("creates a follow-up task and returns enqueue_tasks", async () => {
      const task = createTestTask({
        next: { type: "agent", skill: "copy-editing" as SkillName },
        goalId: "goal-123",
      });
      await workspace.writeTask(task);

      const result = createTestExecutionResult({
        taskId: task.id,
        outputPath: task.output.path,
      });

      const action = await router.route(task, result);

      expect(action.type).toBe("enqueue_tasks");
      if (action.type === "enqueue_tasks") {
        expect(action.tasks).toHaveLength(1);
        const followUp = action.tasks[0]!;
        expect(followUp.to).toBe("copy-editing");
        expect(followUp.from).toBe(task.to);
        expect(followUp.goalId).toBe("goal-123");
        expect(followUp.status).toBe("pending");
        expect(followUp.inputs).toHaveLength(1);
        expect(followUp.inputs[0]!.path).toBe(task.output.path);
      }
    });

    it("writes the follow-up task to workspace", async () => {
      const task = createTestTask({
        next: { type: "agent", skill: "copy-editing" as SkillName },
      });
      await workspace.writeTask(task);

      const result = createTestExecutionResult({
        taskId: task.id,
        outputPath: task.output.path,
      });

      const action = await router.route(task, result);

      if (action.type === "enqueue_tasks") {
        const followUp = action.tasks[0]!;
        // Verify task was persisted
        const readBack = await workspace.readTask(followUp.id);
        expect(readBack.to).toBe("copy-editing");
      }
    });
  });

  describe("route with next.type = 'director_review'", () => {
    it("calls director review and returns result", async () => {
      const task = createTestTask({
        next: { type: "director_review" },
        to: "copywriting" as SkillName,
      });
      await workspace.writeTask(task);

      // Write output so director can review it
      await workspace.writeOutput("creative", "copywriting", task.id, "# Great copy\n\nSome marketing copy here.");

      // Mark task as completed (required for review)
      await workspace.updateTaskStatus(task.id, "completed");

      const result = createTestExecutionResult({ taskId: task.id });
      const action = await router.route(task, result);

      // Director review returns one of the defined actions
      expect(["complete", "enqueue_tasks", "dead_letter"]).toContain(action.type);
    });
  });

  describe("route with next.type = 'pipeline_continue'", () => {
    it("returns complete when goalId is null", async () => {
      const task = createTestTask({
        next: { type: "pipeline_continue", pipelineId: "pipe-1" },
        goalId: null,
      });

      const result = createTestExecutionResult({ taskId: task.id });
      const action = await router.route(task, result);

      expect(action.type).toBe("complete");
    });
  });
});
