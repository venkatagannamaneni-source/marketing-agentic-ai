import { describe, expect, it } from "bun:test";
import { ReviewEngine } from "../review-engine.ts";
import { DEFAULT_DIRECTOR_CONFIG } from "../types.ts";
import { createTestTask, createTestReview, createTestOutput } from "./helpers.ts";

const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG);

describe("ReviewEngine", () => {
  describe("evaluateTask", () => {
    it("approves a task with valid non-empty output", () => {
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();
      const decision = engine.evaluateTask(task, output, []);
      expect(decision.action).toBe("goal_complete");
      expect(decision.review!.verdict).toBe("APPROVE");
    });

    it("rejects a task with empty output", () => {
      const task = createTestTask();
      const decision = engine.evaluateTask(task, "", []);
      expect(decision.review!.verdict).toBe("REJECT");
      expect(decision.action).toBe("reject_reassign");
    });

    it("rejects a task with whitespace-only output", () => {
      const task = createTestTask();
      const decision = engine.evaluateTask(task, "   \n\n   ", []);
      expect(decision.review!.verdict).toBe("REJECT");
    });

    it("revises a task with suspiciously short output", () => {
      const task = createTestTask();
      const decision = engine.evaluateTask(task, "Short output.", []);
      expect(decision.review!.verdict).toBe("REVISE");
      expect(decision.action).toBe("revise");
    });

    it("returns pipeline_next action for approved pipeline tasks", () => {
      const task = createTestTask({
        next: { type: "pipeline_continue", pipelineId: "run-123" },
      });
      const output = createTestOutput();
      const decision = engine.evaluateTask(task, output, []);
      expect(decision.action).toBe("pipeline_next");
    });

    it("returns goal_complete for approved standalone tasks", () => {
      const task = createTestTask({
        next: { type: "director_review" },
      });
      const output = createTestOutput();
      const decision = engine.evaluateTask(task, output, []);
      expect(decision.action).toBe("goal_complete");
    });

    it("returns goal_complete for tasks with complete next", () => {
      const task = createTestTask({
        next: { type: "complete" },
      });
      const output = createTestOutput();
      const decision = engine.evaluateTask(task, output, []);
      expect(decision.action).toBe("goal_complete");
    });

    it("returns escalate_human when revisions exceed max", () => {
      const task = createTestTask({ revisionCount: 3 });
      const decision = engine.evaluateTask(task, "Short.", []);
      expect(decision.action).toBe("escalate_human");
      expect(decision.escalation).not.toBeNull();
      expect(decision.escalation!.reason).toBe("agent_loop_detected");
    });

    it("produces a Review object with correct fields", () => {
      const task = createTestTask({ to: "copywriting" });
      const output = createTestOutput();
      const decision = engine.evaluateTask(task, output, []);
      expect(decision.review).not.toBeNull();
      expect(decision.review!.taskId).toBe(task.id);
      expect(decision.review!.author).toBe("copywriting");
      expect(decision.review!.reviewer).toBe("director");
      expect(decision.review!.id).toStartWith("review-");
    });

    it("produces revision requests for major findings", () => {
      const task = createTestTask();
      const decision = engine.evaluateTask(task, "Short output.", []);
      expect(decision.review!.revisionRequests.length).toBeGreaterThan(0);
      expect(decision.review!.revisionRequests[0]!.priority).toBe(
        "required",
      );
    });

    it("creates a revision task when action is revise", () => {
      const task = createTestTask({ revisionCount: 0 });
      const decision = engine.evaluateTask(task, "Short output.", []);
      expect(decision.action).toBe("revise");
      expect(decision.nextTasks.length).toBe(1);
      expect(decision.nextTasks[0]!.to).toBe(task.to);
      expect(decision.nextTasks[0]!.revisionCount).toBe(1);
    });

    it("revision task includes original output path in inputs", () => {
      const task = createTestTask({ revisionCount: 0 });
      const decision = engine.evaluateTask(task, "Short output.", []);
      const revisionTask = decision.nextTasks[0]!;
      const inputPaths = revisionTask.inputs.map((i) => i.path);
      expect(inputPaths).toContain(task.output.path);
    });

    it("revision task includes revision tag", () => {
      const task = createTestTask({ revisionCount: 0 });
      const decision = engine.evaluateTask(task, "Short output.", []);
      const revisionTask = decision.nextTasks[0]!;
      expect(revisionTask.tags).toContain("revision");
    });

    it("builds a learning entry when action is goal_complete", () => {
      const task = createTestTask({
        next: { type: "director_review" },
      });
      const output = createTestOutput();
      const decision = engine.evaluateTask(task, output, []);
      expect(decision.action).toBe("goal_complete");
      expect(decision.learning).not.toBeNull();
      expect(decision.learning!.outcome).toBe("success");
      expect(decision.learning!.agent).toBe("director");
    });

    it("builds an escalation when action is escalate_human", () => {
      const task = createTestTask({ revisionCount: 3 });
      const decision = engine.evaluateTask(task, "Short.", []);
      expect(decision.escalation).not.toBeNull();
      expect(decision.escalation!.reason).toBe("agent_loop_detected");
      expect(decision.escalation!.severity).toBe("warning");
    });

    it("includes reasoning in the decision", () => {
      const task = createTestTask();
      const output = createTestOutput();
      const decision = engine.evaluateTask(task, output, []);
      expect(decision.reasoning.length).toBeGreaterThan(0);
    });

    it("sets review index based on existing reviews count", () => {
      const task = createTestTask();
      const output = createTestOutput();
      const existingReviews = [createTestReview(), createTestReview()];
      const decision = engine.evaluateTask(task, output, existingReviews);
      expect(decision.review!.id).toContain("-2");
    });
  });

  describe("validateOutputStructure", () => {
    it("returns no critical or major findings for well-structured output", () => {
      const output = createTestOutput();
      const findings = engine.validateOutputStructure("page-cro", output);
      const criticalOrMajor = findings.filter(
        (f) => f.severity === "critical" || f.severity === "major",
      );
      expect(criticalOrMajor.length).toBe(0);
    });

    it("returns minor finding for output without headings", () => {
      const output =
        "This is a plain text output without any markdown headings.\nIt has multiple lines.\nBut no structure.";
      const findings = engine.validateOutputStructure("copywriting", output);
      const headingFinding = findings.find((f) =>
        f.description.includes("headings"),
      );
      expect(headingFinding).toBeDefined();
      expect(headingFinding!.severity).toBe("minor");
    });

    it("returns major finding for output with fewer than 3 non-empty lines", () => {
      const output = "# Heading\nSingle line of content.";
      const findings = engine.validateOutputStructure("page-cro", output);
      const depthFinding = findings.find((f) =>
        f.description.includes("depth"),
      );
      expect(depthFinding).toBeDefined();
      expect(depthFinding!.severity).toBe("major");
    });
  });

  describe("determineAction", () => {
    it("returns goal_complete for APPROVE verdict on standalone task", () => {
      const task = createTestTask({ next: { type: "director_review" } });
      const action = engine.determineAction("APPROVE", task, []);
      expect(action).toBe("goal_complete");
    });

    it("returns pipeline_next for APPROVE verdict on pipeline task", () => {
      const task = createTestTask({
        next: { type: "pipeline_continue", pipelineId: "run-123" },
      });
      const action = engine.determineAction("APPROVE", task, []);
      expect(action).toBe("pipeline_next");
    });

    it("returns approve for APPROVE verdict with agent next", () => {
      const task = createTestTask({
        next: { type: "agent", skill: "copywriting" },
      });
      const action = engine.determineAction("APPROVE", task, []);
      expect(action).toBe("approve");
    });

    it("returns revise for REVISE verdict under max revisions", () => {
      const task = createTestTask({ revisionCount: 1 });
      const action = engine.determineAction("REVISE", task, []);
      expect(action).toBe("revise");
    });

    it("returns escalate_human for REVISE verdict at max revisions", () => {
      const task = createTestTask({ revisionCount: 3 });
      const action = engine.determineAction("REVISE", task, []);
      expect(action).toBe("escalate_human");
    });

    it("returns reject_reassign for REJECT verdict under max revisions", () => {
      const task = createTestTask({ revisionCount: 0 });
      const action = engine.determineAction("REJECT", task, []);
      expect(action).toBe("reject_reassign");
    });

    it("returns escalate_human for REJECT verdict at max revisions", () => {
      const task = createTestTask({ revisionCount: 3 });
      const action = engine.determineAction("REJECT", task, []);
      expect(action).toBe("escalate_human");
    });
  });

  describe("isGoalComplete", () => {
    it("returns true when all tasks are approved", () => {
      const tasks = [
        createTestTask({ status: "approved" }),
        createTestTask({ status: "approved" }),
      ];
      expect(engine.isGoalComplete(tasks)).toBe(true);
    });

    it("returns false when any task is not approved", () => {
      const tasks = [
        createTestTask({ status: "approved" }),
        createTestTask({ status: "in_progress" }),
      ];
      expect(engine.isGoalComplete(tasks)).toBe(false);
    });

    it("returns true for empty task list", () => {
      expect(engine.isGoalComplete([])).toBe(true);
    });

    it("returns false when task is pending", () => {
      const tasks = [createTestTask({ status: "pending" })];
      expect(engine.isGoalComplete(tasks)).toBe(false);
    });
  });

  describe("buildReview", () => {
    it("creates a Review with correct fields", () => {
      const review = engine.buildReview(
        "task-123",
        "copywriting",
        "APPROVE",
        [],
        [],
        "Looks good.",
        0,
      );
      expect(review.taskId).toBe("task-123");
      expect(review.author).toBe("copywriting");
      expect(review.reviewer).toBe("director");
      expect(review.verdict).toBe("APPROVE");
      expect(review.summary).toBe("Looks good.");
      expect(review.id).toBe("review-task-123-0");
    });
  });

  describe("buildLearning", () => {
    it("creates a LearningEntry with correct fields", () => {
      const learning = engine.buildLearning(
        "goal-1",
        "director",
        "success",
        "The optimization worked",
        "Approved final output",
      );
      expect(learning.goalId).toBe("goal-1");
      expect(learning.agent).toBe("director");
      expect(learning.outcome).toBe("success");
      expect(learning.learning).toBe("The optimization worked");
      expect(learning.actionTaken).toBe("Approved final output");
      expect(learning.timestamp).toBeDefined();
    });
  });
});
