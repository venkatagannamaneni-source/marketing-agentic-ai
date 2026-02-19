import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HumanReviewManager } from "../human-review-manager.ts";
import type { HumanFeedback } from "../../types/human-review.ts";
import type { Escalation } from "../types.ts";
import type { Task } from "../../types/task.ts";
import {
  createTestWorkspace,
  createTestTask,
  createTestConfig,
  type TestWorkspace,
} from "./helpers.ts";

// ── Shared Setup ────────────────────────────────────────────────────────────

let tw: TestWorkspace;
let manager: HumanReviewManager;

beforeEach(async () => {
  tw = await createTestWorkspace();
  manager = new HumanReviewManager(tw.workspace, createTestConfig());
});

afterEach(async () => {
  await tw.cleanup();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function createEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    reason: "budget_threshold",
    severity: "warning",
    message: "Budget exceeded threshold",
    context: { spent: 900, total: 1000 },
    ...overrides,
  };
}

function createApproveFeedback(overrides: Partial<HumanFeedback> = {}): HumanFeedback {
  return {
    decision: "approve",
    reviewer: "test-reviewer",
    notes: "Looks good",
    revisionInstructions: null,
    providedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Write a task to the workspace and transition it to "blocked" status,
 * then escalate it to create a human review item. Returns both task and review item.
 */
async function setupBlockedTaskWithReview(
  taskOverrides: Partial<Task> = {},
  escalationOverrides: Partial<Escalation> = {},
): Promise<{ task: Task; reviewItem: Awaited<ReturnType<HumanReviewManager["escalateToHuman"]>> }> {
  const task = createTestTask({
    status: "pending",
    ...taskOverrides,
  });
  await tw.workspace.writeTask(task);
  // pending -> blocked is a valid transition
  await tw.workspace.updateTaskStatus(task.id, "blocked");

  const escalation = createEscalation(escalationOverrides);
  const reviewItem = await manager.escalateToHuman(task, escalation);
  return { task, reviewItem };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("HumanReviewManager", () => {
  // ── escalateToHuman ─────────────────────────────────────────────────────

  describe("escalateToHuman", () => {
    it("creates a HumanReviewItem with correct fields", async () => {
      const task = createTestTask({ status: "pending" });
      const escalation = createEscalation();

      const item = await manager.escalateToHuman(task, escalation);

      expect(item.id).toContain("hr-");
      expect(item.id).toContain(task.id);
      expect(item.taskId).toBe(task.id);
      expect(item.goalId).toBe(task.goalId);
      expect(item.pipelineId).toBe(task.pipelineId);
      expect(item.skill).toBe(task.to);
      expect(item.createdAt).toBeTruthy();
      expect(item.feedback).toBeNull();
      expect(item.resolvedAt).toBeNull();
      expect(item.metadata).toEqual({});
    });

    it('maps "critical" severity to "critical" urgency', async () => {
      const task = createTestTask({ status: "pending" });
      const escalation = createEscalation({ severity: "critical" });

      const item = await manager.escalateToHuman(task, escalation);

      expect(item.urgency).toBe("critical");
    });

    it('maps "warning" severity to "high" urgency', async () => {
      const task = createTestTask({ status: "pending" });
      const escalation = createEscalation({ severity: "warning" });

      const item = await manager.escalateToHuman(task, escalation);

      expect(item.urgency).toBe("high");
    });

    it('status is "pending" and feedback is null', async () => {
      const task = createTestTask({ status: "pending" });
      const escalation = createEscalation();

      const item = await manager.escalateToHuman(task, escalation);

      expect(item.status).toBe("pending");
      expect(item.feedback).toBeNull();
    });

    it("persists to workspace (can be read back)", async () => {
      const task = createTestTask({ status: "pending" });
      const escalation = createEscalation();

      const item = await manager.escalateToHuman(task, escalation);
      const readBack = await manager.getReviewItem(item.id);

      expect(readBack.id).toBe(item.id);
      expect(readBack.taskId).toBe(item.taskId);
      expect(readBack.status).toBe("pending");
    });

    it("preserves escalation context", async () => {
      const task = createTestTask({ status: "pending" });
      const escalation = createEscalation({
        context: { spent: 950, total: 1000, level: "critical" },
      });

      const item = await manager.escalateToHuman(task, escalation);

      expect(item.escalationContext).toEqual({
        spent: 950,
        total: 1000,
        level: "critical",
      });
    });

    it("preserves escalation reason and message", async () => {
      const task = createTestTask({ status: "pending" });
      const escalation = createEscalation({
        reason: "legal_risk",
        message: "Content may contain legal issues",
      });

      const item = await manager.escalateToHuman(task, escalation);

      expect(item.escalationReason).toBe("legal_risk");
      expect(item.escalationMessage).toBe("Content may contain legal issues");
    });
  });

  // ── getPendingReviews ───────────────────────────────────────────────────

  describe("getPendingReviews", () => {
    it("returns pending reviews", async () => {
      const task = createTestTask({ status: "pending" });
      const escalation = createEscalation();
      const item = await manager.escalateToHuman(task, escalation);

      const pending = await manager.getPendingReviews();

      expect(pending.length).toBe(1);
      expect(pending[0]!.id).toBe(item.id);
    });

    it("returns empty array when no reviews", async () => {
      const pending = await manager.getPendingReviews();

      expect(pending).toEqual([]);
    });

    it("filters by urgency", async () => {
      const task1 = createTestTask({ id: "page-cro-20260219-aaa001", status: "pending" });
      const task2 = createTestTask({ id: "page-cro-20260219-bbb002", status: "pending" });
      await manager.escalateToHuman(task1, createEscalation({ severity: "critical" }));
      await manager.escalateToHuman(task2, createEscalation({ severity: "warning" }));

      const criticalOnly = await manager.getPendingReviews({ urgency: "critical" });

      expect(criticalOnly.length).toBe(1);
      expect(criticalOnly[0]!.urgency).toBe("critical");
    });

    it("filters by skill", async () => {
      const task1 = createTestTask({ id: "page-cro-20260219-aaa001", to: "page-cro", status: "pending" });
      const task2 = createTestTask({ id: "copywriting-20260219-bbb002", to: "copywriting", status: "pending" });
      await manager.escalateToHuman(task1, createEscalation());
      await manager.escalateToHuman(task2, createEscalation());

      const pageCroOnly = await manager.getPendingReviews({ skill: "page-cro" });

      expect(pageCroOnly.length).toBe(1);
      expect(pageCroOnly[0]!.skill).toBe("page-cro");
    });

    it("filters by goalId", async () => {
      const task1 = createTestTask({ id: "page-cro-20260219-aaa001", goalId: "goal-A", status: "pending" });
      const task2 = createTestTask({ id: "page-cro-20260219-bbb002", goalId: "goal-B", status: "pending" });
      await manager.escalateToHuman(task1, createEscalation());
      await manager.escalateToHuman(task2, createEscalation());

      const goalAOnly = await manager.getPendingReviews({ goalId: "goal-A" });

      expect(goalAOnly.length).toBe(1);
      expect(goalAOnly[0]!.goalId).toBe("goal-A");
    });

    it("does not return resolved reviews by default", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      // Submit feedback to resolve the review
      await manager.submitFeedback(reviewItem.id, createApproveFeedback());

      const pending = await manager.getPendingReviews();

      expect(pending.length).toBe(0);
    });
  });

  // ── getReviewByTaskId ───────────────────────────────────────────────────

  describe("getReviewByTaskId", () => {
    it("returns the review for a given task", async () => {
      const task = createTestTask({ status: "pending" });
      const item = await manager.escalateToHuman(task, createEscalation());

      const found = await manager.getReviewByTaskId(task.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(item.id);
      expect(found!.taskId).toBe(task.id);
    });

    it("returns null when no review exists for task", async () => {
      const found = await manager.getReviewByTaskId("nonexistent-task-id");

      expect(found).toBeNull();
    });
  });

  // ── getStats ────────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("returns correct counts for empty state", async () => {
      const stats = await manager.getStats();

      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.inReview).toBe(0);
      expect(stats.resolved).toBe(0);
      expect(stats.expired).toBe(0);
    });

    it("returns correct counts with mixed statuses", async () => {
      // Create a pending review
      const task1 = createTestTask({ id: "page-cro-20260219-aaa001", status: "pending" });
      await tw.workspace.writeTask(task1);
      await tw.workspace.updateTaskStatus(task1.id, "blocked");
      await manager.escalateToHuman(task1, createEscalation());

      // Create another review and resolve it
      const { reviewItem: review2 } = await setupBlockedTaskWithReview({
        id: "page-cro-20260219-bbb002",
      });
      await manager.submitFeedback(review2.id, createApproveFeedback());

      const stats = await manager.getStats();

      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(1);
      expect(stats.resolved).toBe(1);
    });

    it("computes average resolution time for resolved items", async () => {
      // Create and resolve a review
      const { reviewItem } = await setupBlockedTaskWithReview();
      await manager.submitFeedback(reviewItem.id, createApproveFeedback());

      const stats = await manager.getStats();

      // The average should be a non-negative number (possibly 0 if resolved quickly)
      expect(stats.averageResolutionTimeMs).not.toBeNull();
      expect(stats.averageResolutionTimeMs!).toBeGreaterThanOrEqual(0);
    });

    it("returns null average when no resolved items", async () => {
      // Create a pending review only
      const task = createTestTask({ status: "pending" });
      await manager.escalateToHuman(task, createEscalation());

      const stats = await manager.getStats();

      expect(stats.averageResolutionTimeMs).toBeNull();
    });

    it("counts by urgency correctly", async () => {
      const task1 = createTestTask({ id: "page-cro-20260219-aaa001", status: "pending" });
      const task2 = createTestTask({ id: "page-cro-20260219-bbb002", status: "pending" });
      const task3 = createTestTask({ id: "page-cro-20260219-ccc003", status: "pending" });

      await manager.escalateToHuman(task1, createEscalation({ severity: "critical" }));
      await manager.escalateToHuman(task2, createEscalation({ severity: "warning" }));
      await manager.escalateToHuman(task3, createEscalation({ severity: "warning" }));

      const stats = await manager.getStats();

      expect(stats.byUrgency.critical).toBe(1);
      expect(stats.byUrgency.high).toBe(2);
      expect(stats.byUrgency.normal).toBe(0);
    });
  });

  // ── submitFeedback: approve ─────────────────────────────────────────────

  describe("submitFeedback - approve", () => {
    it("transitions task from blocked to pending", async () => {
      const { task, reviewItem } = await setupBlockedTaskWithReview();

      await manager.submitFeedback(reviewItem.id, createApproveFeedback());

      const updatedTask = await tw.workspace.readTask(task.id);
      expect(updatedTask.status).toBe("pending");
    });

    it("returns the task for re-enqueue", async () => {
      const { task, reviewItem } = await setupBlockedTaskWithReview();

      const result = await manager.submitFeedback(reviewItem.id, createApproveFeedback());

      expect(result.resumedTasks.length).toBe(1);
      expect(result.resumedTasks[0]!.id).toBe(task.id);
      expect(result.resumedTasks[0]!.status).toBe("pending");
    });

    it("updates review item to resolved", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      const result = await manager.submitFeedback(reviewItem.id, createApproveFeedback());

      expect(result.item.status).toBe("resolved");
      expect(result.item.resolvedAt).toBeTruthy();
      expect(result.item.feedback).not.toBeNull();
      expect(result.item.feedback!.decision).toBe("approve");
    });

    it("writes learning entry", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      await manager.submitFeedback(reviewItem.id, createApproveFeedback());

      const learnings = await tw.workspace.readLearnings();
      expect(learnings).toContain("approve");
      expect(learnings).toContain("test-reviewer");
    });
  });

  // ── submitFeedback: override_approve ────────────────────────────────────

  describe("submitFeedback - override_approve", () => {
    it("has the same behavior as approve (transitions task, resolves review)", async () => {
      const { task, reviewItem } = await setupBlockedTaskWithReview();

      const feedback = createApproveFeedback({ decision: "override_approve" });
      const result = await manager.submitFeedback(reviewItem.id, feedback);

      // Task goes back to pending
      const updatedTask = await tw.workspace.readTask(task.id);
      expect(updatedTask.status).toBe("pending");

      // Review is resolved
      expect(result.item.status).toBe("resolved");

      // Task is returned for re-enqueue
      expect(result.resumedTasks.length).toBe(1);
      expect(result.resumedTasks[0]!.id).toBe(task.id);
    });

    it('records "override_approve" decision in feedback', async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      const feedback = createApproveFeedback({ decision: "override_approve" });
      const result = await manager.submitFeedback(reviewItem.id, feedback);

      expect(result.item.feedback!.decision).toBe("override_approve");
    });
  });

  // ── submitFeedback: revise ──────────────────────────────────────────────

  describe("submitFeedback - revise", () => {
    const reviseFeedback: HumanFeedback = {
      decision: "revise",
      reviewer: "test-reviewer",
      notes: "Needs improvement",
      revisionInstructions: "Please add more data points and examples",
      providedAt: new Date().toISOString(),
    };

    it("creates a revision task with human instructions", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      const result = await manager.submitFeedback(reviewItem.id, reviseFeedback);

      expect(result.resumedTasks.length).toBe(1);
      const revisionTask = result.resumedTasks[0]!;
      expect(revisionTask.requirements).toContain("HUMAN REVISION REQUESTED");
      expect(revisionTask.requirements).toContain("Please add more data points and examples");
    });

    it("revision task has incremented revisionCount", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview({
        revisionCount: 1,
      });

      const result = await manager.submitFeedback(reviewItem.id, reviseFeedback);

      const revisionTask = result.resumedTasks[0]!;
      expect(revisionTask.revisionCount).toBe(2);
    });

    it('revision task has "human-requested" tag', async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      const result = await manager.submitFeedback(reviewItem.id, reviseFeedback);

      const revisionTask = result.resumedTasks[0]!;
      expect(revisionTask.tags).toContain("human-requested");
      expect(revisionTask.tags).toContain("revision");
    });

    it("revision task includes previous output path in inputs", async () => {
      const { task, reviewItem } = await setupBlockedTaskWithReview();

      const result = await manager.submitFeedback(reviewItem.id, reviseFeedback);

      const revisionTask = result.resumedTasks[0]!;
      const outputInput = revisionTask.inputs.find(
        (i) => i.path === task.output.path,
      );
      expect(outputInput).toBeDefined();
      expect(outputInput!.description).toBe("Previous output to revise");
    });

    it("original task transitions to failed", async () => {
      const { task, reviewItem } = await setupBlockedTaskWithReview();

      await manager.submitFeedback(reviewItem.id, reviseFeedback);

      const originalTask = await tw.workspace.readTask(task.id);
      expect(originalTask.status).toBe("failed");
    });

    it("revision instructions are in the requirements", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      const result = await manager.submitFeedback(reviewItem.id, reviseFeedback);

      const revisionTask = result.resumedTasks[0]!;
      expect(revisionTask.requirements).toContain(
        "Please add more data points and examples",
      );
      expect(revisionTask.requirements).toContain("Original requirements:");
    });

    it("requires revisionInstructions (throws if null)", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      const badFeedback: HumanFeedback = {
        decision: "revise",
        reviewer: "test-reviewer",
        notes: "Needs work",
        revisionInstructions: null,
        providedAt: new Date().toISOString(),
      };

      expect(
        manager.submitFeedback(reviewItem.id, badFeedback),
      ).rejects.toThrow("Revision instructions are required");
    });
  });

  // ── submitFeedback: reject ──────────────────────────────────────────────

  describe("submitFeedback - reject", () => {
    const rejectFeedback: HumanFeedback = {
      decision: "reject",
      reviewer: "test-reviewer",
      notes: "Not acceptable quality",
      revisionInstructions: null,
      providedAt: new Date().toISOString(),
    };

    it("transitions task from blocked to failed", async () => {
      const { task, reviewItem } = await setupBlockedTaskWithReview();

      await manager.submitFeedback(reviewItem.id, rejectFeedback);

      const updatedTask = await tw.workspace.readTask(task.id);
      expect(updatedTask.status).toBe("failed");
    });

    it("returns empty resumedTasks array", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      const result = await manager.submitFeedback(reviewItem.id, rejectFeedback);

      expect(result.resumedTasks).toEqual([]);
    });

    it('records learning with "failure" outcome', async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      await manager.submitFeedback(reviewItem.id, rejectFeedback);

      const learnings = await tw.workspace.readLearnings();
      expect(learnings).toContain("reject");
      expect(learnings).toContain("test-reviewer");
    });
  });

  // ── submitFeedback: cancel ──────────────────────────────────────────────

  describe("submitFeedback - cancel", () => {
    const cancelFeedback: HumanFeedback = {
      decision: "cancel",
      reviewer: "test-reviewer",
      notes: "No longer needed",
      revisionInstructions: null,
      providedAt: new Date().toISOString(),
    };

    it("transitions task from blocked to failed", async () => {
      const { task, reviewItem } = await setupBlockedTaskWithReview();

      await manager.submitFeedback(reviewItem.id, cancelFeedback);

      const updatedTask = await tw.workspace.readTask(task.id);
      expect(updatedTask.status).toBe("failed");
    });

    it("returns empty resumedTasks", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      const result = await manager.submitFeedback(reviewItem.id, cancelFeedback);

      expect(result.resumedTasks).toEqual([]);
    });
  });

  // ── Validation ──────────────────────────────────────────────────────────

  describe("validation", () => {
    it("throws when submitting feedback for resolved item", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      // First feedback resolves the item
      await manager.submitFeedback(reviewItem.id, createApproveFeedback());

      // Second feedback should throw
      expect(
        manager.submitFeedback(reviewItem.id, createApproveFeedback()),
      ).rejects.toThrow(/status is "resolved"/);
    });

    it("throws when submitting feedback for expired item", async () => {
      const { reviewItem } = await setupBlockedTaskWithReview();

      // Manually set the review item to expired status
      await tw.workspace.updateHumanReview(reviewItem.id, {
        status: "expired",
      });

      expect(
        manager.submitFeedback(reviewItem.id, createApproveFeedback()),
      ).rejects.toThrow(/status is "expired"/);
    });
  });
});
