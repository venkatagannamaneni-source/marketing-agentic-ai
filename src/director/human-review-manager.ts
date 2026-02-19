import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { Task } from "../types/task.ts";
import type {
  HumanReviewItem,
  HumanFeedback,
  HumanReviewFilter,
  HumanReviewStats,
  HumanReviewUrgency,
} from "../types/human-review.ts";
import type { Escalation, DirectorConfig } from "./types.ts";
import type { LearningEntry } from "../types/workspace.ts";
import { generateHumanReviewId } from "../workspace/id.ts";
import { generateTaskId } from "../workspace/id.ts";

// ── Human Review Manager ────────────────────────────────────────────────────

export class HumanReviewManager {
  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly config: DirectorConfig,
  ) {}

  /**
   * Create a human review item when the Director escalates a task.
   */
  async escalateToHuman(
    task: Task,
    escalation: Escalation,
  ): Promise<HumanReviewItem> {
    const item: HumanReviewItem = {
      id: generateHumanReviewId(task.id),
      taskId: task.id,
      goalId: task.goalId,
      pipelineId: task.pipelineId,
      skill: task.to,
      createdAt: new Date().toISOString(),
      urgency: this.mapSeverityToUrgency(escalation.severity),
      status: "pending",
      escalationReason: escalation.reason,
      escalationMessage: escalation.message,
      escalationContext: escalation.context,
      feedback: null,
      resolvedAt: null,
      metadata: {},
    };

    await this.workspace.writeHumanReview(item);
    return item;
  }

  /**
   * Get all pending human reviews, optionally filtered.
   */
  async getPendingReviews(
    filter?: HumanReviewFilter,
  ): Promise<readonly HumanReviewItem[]> {
    const baseFilter: HumanReviewFilter = {
      ...filter,
      status: filter?.status ?? "pending",
    };
    return this.workspace.listHumanReviews(baseFilter);
  }

  /**
   * Get a specific human review item.
   */
  async getReviewItem(reviewId: string): Promise<HumanReviewItem> {
    return this.workspace.readHumanReview(reviewId);
  }

  /**
   * Find the human review item for a given task.
   */
  async getReviewByTaskId(taskId: string): Promise<HumanReviewItem | null> {
    const all = await this.workspace.listHumanReviews();
    return all.find((item) => item.taskId === taskId) ?? null;
  }

  /**
   * Get aggregate statistics about human reviews.
   */
  async getStats(): Promise<HumanReviewStats> {
    const all = await this.workspace.listHumanReviews();

    let pending = 0;
    let inReview = 0;
    let resolved = 0;
    let expired = 0;
    const byUrgency: Record<HumanReviewUrgency, number> = {
      critical: 0,
      high: 0,
      normal: 0,
    };

    const resolutionTimes: number[] = [];

    for (const item of all) {
      switch (item.status) {
        case "pending":
          pending++;
          break;
        case "in_review":
          inReview++;
          break;
        case "resolved":
          resolved++;
          if (item.resolvedAt && item.createdAt) {
            const duration =
              new Date(item.resolvedAt).getTime() -
              new Date(item.createdAt).getTime();
            if (duration >= 0) resolutionTimes.push(duration);
          }
          break;
        case "expired":
          expired++;
          break;
      }
      byUrgency[item.urgency]++;
    }

    const averageResolutionTimeMs =
      resolutionTimes.length > 0
        ? resolutionTimes.reduce((a, b) => a + b, 0) / resolutionTimes.length
        : null;

    return {
      total: all.length,
      pending,
      inReview,
      resolved,
      expired,
      byUrgency,
      averageResolutionTimeMs,
    };
  }

  /**
   * Submit human feedback for a review item.
   * Resumes the task based on the decision and returns any new tasks to enqueue.
   */
  async submitFeedback(
    reviewId: string,
    feedback: HumanFeedback,
  ): Promise<{ item: HumanReviewItem; resumedTasks: readonly Task[] }> {
    const item = await this.workspace.readHumanReview(reviewId);

    // Validate state
    if (item.status !== "pending" && item.status !== "in_review") {
      throw new Error(
        `Cannot submit feedback for review ${reviewId}: status is "${item.status}", expected "pending" or "in_review"`,
      );
    }

    // Validate revision instructions present when decision is "revise"
    if (feedback.decision === "revise" && !feedback.revisionInstructions) {
      throw new Error(
        "Revision instructions are required when decision is \"revise\"",
      );
    }

    // Read the associated task
    const task = await this.workspace.readTask(item.taskId);

    // Apply decision
    let resumedTasks: readonly Task[];
    switch (feedback.decision) {
      case "approve":
      case "override_approve":
        resumedTasks = await this.resumeApproved(task);
        break;
      case "revise":
        resumedTasks = await this.resumeRevision(
          task,
          feedback.revisionInstructions!,
        );
        break;
      case "reject":
        resumedTasks = await this.resumeRejected(task);
        break;
      case "cancel":
        resumedTasks = await this.resumeCancelled(task);
        break;
      default:
        resumedTasks = [];
    }

    // Update the review item
    const resolvedAt = new Date().toISOString();
    await this.workspace.updateHumanReview(reviewId, {
      status: "resolved",
      feedback,
      resolvedAt,
    });

    // Write learning entry
    const learning: LearningEntry = {
      timestamp: resolvedAt,
      agent: "director",
      goalId: item.goalId ?? "unknown",
      outcome: feedback.decision === "reject" || feedback.decision === "cancel"
        ? "failure"
        : "success",
      learning: `Human reviewer (${feedback.reviewer}) ${feedback.decision}d task ${item.taskId} (${item.skill}). Notes: ${feedback.notes}`,
      actionTaken: `Applied human decision: ${feedback.decision}`,
    };
    await this.workspace.appendLearning(learning);

    // Read back the updated item
    const updatedItem = await this.workspace.readHumanReview(reviewId);

    return { item: updatedItem, resumedTasks };
  }

  // ── Internal: Resume Logic ──────────────────────────────────────────────

  private async resumeApproved(task: Task): Promise<readonly Task[]> {
    // Transition blocked -> pending so the task can be re-evaluated/continued
    await this.workspace.updateTaskStatus(task.id, "pending");
    // Return the unblocked task for re-enqueue
    const updated = await this.workspace.readTask(task.id);
    return [updated];
  }

  private async resumeRevision(
    task: Task,
    instructions: string,
  ): Promise<readonly Task[]> {
    // Transition the blocked task to failed (it's being replaced by a revision)
    await this.workspace.updateTaskStatus(task.id, "failed");

    // Create a revision task with human-provided instructions
    const now = new Date().toISOString();
    const revisionTaskId = generateTaskId(task.to);

    const revisionTask: Task = {
      id: revisionTaskId,
      createdAt: now,
      updatedAt: now,
      from: "director",
      to: task.to,
      priority: task.priority,
      deadline: task.deadline,
      status: "pending",
      revisionCount: task.revisionCount + 1,
      goalId: task.goalId,
      pipelineId: task.pipelineId,
      goal: task.goal,
      inputs: [
        ...task.inputs,
        {
          path: task.output.path,
          description: "Previous output to revise",
        },
      ],
      requirements: `HUMAN REVISION REQUESTED:\n${instructions}\n\nOriginal requirements: ${task.requirements}`,
      output: task.output,
      next: task.next,
      tags: [...task.tags, "revision", "human-requested"],
      metadata: {
        ...task.metadata,
        originalTaskId: task.id,
        revisionOf: task.id,
        humanReviewed: true,
      },
    };

    await this.workspace.writeTask(revisionTask);
    return [revisionTask];
  }

  private async resumeRejected(task: Task): Promise<readonly Task[]> {
    await this.workspace.updateTaskStatus(task.id, "failed");
    return [];
  }

  private async resumeCancelled(task: Task): Promise<readonly Task[]> {
    await this.workspace.updateTaskStatus(task.id, "failed");
    return [];
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private mapSeverityToUrgency(
    severity: Escalation["severity"],
  ): HumanReviewUrgency {
    switch (severity) {
      case "critical":
        return "critical";
      case "warning":
        return "high";
      default:
        return "normal";
    }
  }
}
