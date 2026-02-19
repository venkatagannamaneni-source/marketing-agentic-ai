import type { SkillName } from "../types/agent.ts";
import { SKILL_SQUAD_MAP } from "../types/agent.ts";
import type { Task } from "../types/task.ts";
import type {
  Review,
  ReviewVerdict,
  ReviewFinding,
  RevisionRequest,
} from "../types/review.ts";
import type { LearningEntry } from "../types/workspace.ts";
import { generateReviewId, generateTaskId } from "../workspace/id.ts";
import type {
  DirectorDecision,
  DirectorAction,
  DirectorConfig,
  Escalation,
} from "./types.ts";

// ── Review Engine ────────────────────────────────────────────────────────────

export class ReviewEngine {
  constructor(private readonly config: DirectorConfig) {}

  /**
   * Evaluate a completed task's output and produce a DirectorDecision.
   *
   * Structural validation only — semantic review via Claude Opus is added
   * in Task 7 (Agent Executor).
   */
  evaluateTask(
    task: Task,
    outputContent: string,
    existingReviews: readonly Review[],
  ): DirectorDecision {
    const reviewIndex = existingReviews.length;
    const findings: ReviewFinding[] = [];
    const revisionRequests: RevisionRequest[] = [];

    // 1. Check output exists and is non-empty
    if (!outputContent || outputContent.trim().length === 0) {
      findings.push({
        section: "entire output",
        severity: "critical",
        description: "Output is empty",
      });
    }

    // 2. Check minimum length heuristic
    if (
      outputContent &&
      outputContent.trim().length > 0 &&
      outputContent.trim().length < 100
    ) {
      findings.push({
        section: "entire output",
        severity: "major",
        description:
          "Output is suspiciously short (less than 100 characters)",
      });
    }

    // 3. Structural validation based on skill
    if (outputContent && outputContent.trim().length >= 100) {
      const structuralFindings = this.validateOutputStructure(
        task.to,
        outputContent,
      );
      findings.push(...structuralFindings);
    }

    // 4. Determine verdict
    const hasCritical = findings.some((f) => f.severity === "critical");
    const hasMajor = findings.some((f) => f.severity === "major");

    let verdict: ReviewVerdict;
    if (hasCritical) {
      verdict = "REJECT";
    } else if (hasMajor) {
      verdict = "REVISE";
      for (const f of findings.filter((f) => f.severity === "major")) {
        revisionRequests.push({
          description: f.description,
          priority: "required",
        });
      }
    } else {
      verdict = "APPROVE";
    }

    // 5. Determine action
    const action = this.determineAction(verdict, task, existingReviews);

    // 6. Build review
    const review = this.buildReview(
      task.id,
      task.to,
      verdict,
      findings,
      revisionRequests,
      verdict === "APPROVE"
        ? "Output meets structural requirements."
        : `Output has ${findings.length} finding(s) requiring attention.`,
      reviewIndex,
    );

    // 7. Build follow-up tasks if revision is needed
    const nextTasks: Task[] = [];
    if (action === "revise") {
      nextTasks.push(this.createRevisionTask(task, revisionRequests));
    }

    // 8. Check for escalation
    let escalation: Escalation | null = null;
    if (action === "escalate_human") {
      escalation = {
        reason: "agent_loop_detected",
        severity: "warning",
        message: `Task ${task.id} has been revised ${task.revisionCount} times (max: ${this.config.maxRevisionsPerTask}). Requires human decision.`,
        context: {
          taskId: task.id,
          skill: task.to,
          revisionCount: task.revisionCount,
        },
      };
    }

    // 9. Build learning if goal is complete
    let learning: LearningEntry | null = null;
    if (action === "goal_complete" || action === "approve") {
      learning = this.buildLearning(
        task.goalId ?? "unknown",
        "director",
        "success",
        `Task ${task.id} completed by ${task.to}. Output approved.`,
        "Approved output after structural validation.",
      );
    }

    return {
      taskId: task.id,
      action,
      review,
      nextTasks,
      learning,
      escalation,
      reasoning: this.buildReasoning(verdict, action, findings),
    };
  }

  /**
   * Determine the action based on verdict and context.
   */
  determineAction(
    verdict: ReviewVerdict,
    task: Task,
    _existingReviews: readonly Review[],
  ): DirectorAction {
    if (verdict === "APPROVE") {
      if (task.next.type === "pipeline_continue") {
        return "pipeline_next";
      }
      if (
        task.next.type === "complete" ||
        task.next.type === "director_review"
      ) {
        return "goal_complete";
      }
      return "approve";
    }

    if (verdict === "REVISE") {
      if (task.revisionCount >= this.config.maxRevisionsPerTask) {
        return "escalate_human";
      }
      return "revise";
    }

    if (verdict === "REJECT") {
      if (task.revisionCount >= this.config.maxRevisionsPerTask) {
        return "escalate_human";
      }
      return "reject_reassign";
    }

    return "escalate_human";
  }

  /**
   * Validate output structure for a given skill.
   * Returns findings about missing or malformed sections.
   */
  validateOutputStructure(
    _skillName: SkillName,
    outputContent: string,
  ): readonly ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    // Check for markdown heading structure
    const hasHeadings = /^#+\s+.+/m.test(outputContent);
    if (!hasHeadings) {
      findings.push({
        section: "structure",
        severity: "minor",
        description: "Output lacks markdown headings for structure",
      });
    }

    // Check for substantial content (at least 3 lines of non-empty text)
    const nonEmptyLines = outputContent
      .split("\n")
      .filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length < 3) {
      findings.push({
        section: "content depth",
        severity: "major",
        description:
          "Output has fewer than 3 non-empty lines — lacks sufficient depth",
      });
    }

    return findings;
  }

  /**
   * Build a Review object.
   */
  buildReview(
    taskId: string,
    author: SkillName,
    verdict: ReviewVerdict,
    findings: readonly ReviewFinding[],
    revisionRequests: readonly RevisionRequest[],
    summary: string,
    reviewIndex: number,
  ): Review {
    return {
      id: generateReviewId(taskId, reviewIndex),
      taskId,
      createdAt: new Date().toISOString(),
      reviewer: "director",
      author,
      verdict,
      findings,
      revisionRequests,
      summary,
    };
  }

  /**
   * Build a learning entry.
   */
  buildLearning(
    goalId: string,
    agent: SkillName | "director",
    outcome: "success" | "failure" | "partial",
    learning: string,
    actionTaken: string,
  ): LearningEntry {
    return {
      timestamp: new Date().toISOString(),
      agent,
      goalId,
      outcome,
      learning,
      actionTaken,
    };
  }

  /**
   * Check if a goal is complete (all tasks approved).
   */
  isGoalComplete(goalTasks: readonly Task[]): boolean {
    if (goalTasks.length === 0) return true;
    return goalTasks.every((t) => t.status === "approved");
  }

  /**
   * Create a revision task from the original task and revision requests.
   */
  private createRevisionTask(
    original: Task,
    revisionRequests: readonly RevisionRequest[],
  ): Task {
    const now = new Date().toISOString();
    const taskId = generateTaskId(original.to);

    const revisionDetails = revisionRequests
      .map((r) => `- [${r.priority}] ${r.description}`)
      .join("\n");

    return {
      id: taskId,
      createdAt: now,
      updatedAt: now,
      from: "director",
      to: original.to,
      priority: original.priority,
      deadline: original.deadline,
      status: "pending",
      revisionCount: original.revisionCount + 1,
      goalId: original.goalId,
      pipelineId: original.pipelineId,
      goal: original.goal,
      inputs: [
        ...original.inputs,
        {
          path: original.output.path,
          description: "Previous output to revise",
        },
      ],
      requirements: `REVISION REQUESTED:\n${revisionDetails}\n\nOriginal requirements: ${original.requirements}`,
      output: original.output,
      next: original.next,
      tags: [...original.tags, "revision"],
      metadata: {
        ...original.metadata,
        originalTaskId: original.id,
        revisionOf: original.id,
      },
    };
  }

  /**
   * Build a human-readable reasoning string.
   */
  private buildReasoning(
    verdict: ReviewVerdict,
    action: DirectorAction,
    findings: readonly ReviewFinding[],
  ): string {
    if (verdict === "APPROVE" && findings.length === 0) {
      return "Output passes all structural validation checks.";
    }

    const findingSummary = findings
      .map((f) => `[${f.severity}] ${f.section}: ${f.description}`)
      .join("; ");

    return `Verdict: ${verdict}. Action: ${action}. Findings: ${findingSummary}`;
  }
}
