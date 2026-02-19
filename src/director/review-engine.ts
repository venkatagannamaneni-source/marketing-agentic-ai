import type { SkillName } from "../types/agent.ts";
import { SKILL_SQUAD_MAP } from "../types/agent.ts";
import type { Task } from "../types/task.ts";
import type {
  Review,
  ReviewVerdict,
  ReviewFinding,
  FindingSeverity,
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
import type { BudgetState } from "./types.ts";
import type { ModelTier } from "../types/agent.ts";
import type { ClaudeClient } from "../agents/claude-client.ts";
import { MODEL_MAP, estimateCost } from "../agents/claude-client.ts";

// ── Semantic Review Result ──────────────────────────────────────────────────

export interface SemanticReviewResult {
  readonly decision: DirectorDecision;
  readonly reviewCost: number;
}

// ── Review Engine ────────────────────────────────────────────────────────────

const VALID_SEVERITIES: ReadonlySet<string> = new Set<string>([
  "critical",
  "major",
  "minor",
  "suggestion",
]);

export class ReviewEngine {
  constructor(
    private readonly config: DirectorConfig,
    private readonly client?: ClaudeClient,
  ) {}

  /**
   * Evaluate a completed task's output and produce a DirectorDecision.
   *
   * Structural validation only — no API calls. Use evaluateTaskSemantic()
   * for combined structural + Claude Opus semantic review.
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
   * Evaluate a completed task's output with both structural validation
   * AND Claude Opus semantic review. Falls back to structural-only if
   * no ClaudeClient was provided.
   *
   * Returns both the decision and the cost of the semantic review (EC-4).
   */
  async evaluateTaskSemantic(
    task: Task,
    outputContent: string,
    existingReviews: readonly Review[],
    budgetState?: BudgetState,
  ): Promise<SemanticReviewResult> {
    const reviewIndex = existingReviews.length;
    const structuralFindings: ReviewFinding[] = [];
    const revisionRequests: RevisionRequest[] = [];

    // 1. Structural validation (same fast-path checks as evaluateTask)
    if (!outputContent || outputContent.trim().length === 0) {
      structuralFindings.push({
        section: "entire output",
        severity: "critical",
        description: "Output is empty",
      });
    }

    if (
      outputContent &&
      outputContent.trim().length > 0 &&
      outputContent.trim().length < 100
    ) {
      structuralFindings.push({
        section: "entire output",
        severity: "major",
        description:
          "Output is suspiciously short (less than 100 characters)",
      });
    }

    if (outputContent && outputContent.trim().length >= 100) {
      const additionalFindings = this.validateOutputStructure(
        task.to,
        outputContent,
      );
      structuralFindings.push(...additionalFindings);
    }

    // 2. Short-circuit on critical structural findings — skip Opus call
    const hasCriticalStructural = structuralFindings.some(
      (f) => f.severity === "critical",
    );
    if (hasCriticalStructural || !this.client) {
      // No client or critical structural issue → structural-only result
      const decision = this.buildDecisionFromFindings(
        task,
        structuralFindings,
        revisionRequests,
        existingReviews,
        reviewIndex,
      );
      return { decision, reviewCost: 0 };
    }

    // 3. Perform semantic review — uses opus by default, respects budget modelOverride
    const reviewModelTier: ModelTier = budgetState?.modelOverride ?? "opus";
    const { findings: semanticFindings, cost: reviewCost } =
      await this.performSemanticReview(task, outputContent, reviewModelTier);

    // 4. Merge structural + semantic findings, deduplicate
    const allFindings = this.mergeFindings(
      structuralFindings,
      semanticFindings,
    );

    // 5. Build decision from merged findings
    const decision = this.buildDecisionFromFindings(
      task,
      allFindings,
      revisionRequests,
      existingReviews,
      reviewIndex,
    );

    return { decision, reviewCost };
  }

  /**
   * Build a DirectorDecision from a set of findings.
   * Shared logic between evaluateTask and evaluateTaskSemantic.
   */
  private buildDecisionFromFindings(
    task: Task,
    findings: ReviewFinding[],
    callerRevisionRequests: readonly RevisionRequest[],
    existingReviews: readonly Review[],
    reviewIndex: number,
  ): DirectorDecision {
    // Build a local copy to avoid mutating the caller's array
    const revisionRequests: RevisionRequest[] = [...callerRevisionRequests];

    // Determine verdict
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

    const action = this.determineAction(verdict, task, existingReviews);

    const review = this.buildReview(
      task.id,
      task.to,
      verdict,
      findings,
      revisionRequests,
      verdict === "APPROVE"
        ? "Output meets structural and semantic requirements."
        : `Output has ${findings.length} finding(s) requiring attention.`,
      reviewIndex,
    );

    const nextTasks: Task[] = [];
    if (action === "revise") {
      nextTasks.push(this.createRevisionTask(task, revisionRequests));
    }

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

    let learning: LearningEntry | null = null;
    if (action === "goal_complete" || action === "approve") {
      learning = this.buildLearning(
        task.goalId ?? "unknown",
        "director",
        "success",
        `Task ${task.id} completed by ${task.to}. Output approved.`,
        "Approved output after structural and semantic validation.",
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
   * Perform semantic review via Claude Opus.
   * Returns findings and the cost of the API call.
   * Degrades gracefully on parse errors — returns empty findings.
   */
  private async performSemanticReview(
    task: Task,
    outputContent: string,
    modelTier: ModelTier = "opus",
  ): Promise<{ findings: ReviewFinding[]; cost: number }> {
    const systemPrompt = `You are the Marketing Director reviewing agent output for quality.

Evaluate the output against these criteria:
1. **Completeness**: Does the output address all requirements in the task?
2. **Quality**: Is the output specific, actionable, and well-structured?
3. **Brand alignment**: Does it match professional marketing standards?
4. **Data-driven**: Are recommendations backed by evidence or principles?
5. **Actionability**: Can the next agent or human actually use this output?

Respond with ONLY a JSON array of findings. Each finding must have:
- "section": the part of the output with the issue
- "severity": one of "critical", "major", "minor", "suggestion"
- "description": a specific, actionable description of the issue

If the output is good and has no issues, respond with an empty array: []

Example response:
[{"section":"recommendations","severity":"minor","description":"Recommendations lack specific metrics or KPIs to measure success"}]`;

    const userMessage = `Task: ${task.to}
Goal: ${task.goal}
Requirements: ${task.requirements}

Agent Output:
${outputContent}`;

    try {
      const result = await this.client!.createMessage({
        model: MODEL_MAP[modelTier],
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        maxTokens: 4096,
        timeoutMs: 60_000,
      });

      const cost = estimateCost(
        modelTier,
        result.inputTokens,
        result.outputTokens,
      );

      // Parse JSON response
      const findings = this.parseSemanticFindings(result.content);
      return { findings, cost };
    } catch {
      // Graceful degradation — log would go here in production
      return { findings: [], cost: 0 };
    }
  }

  /**
   * Parse the Opus response as a JSON array of ReviewFinding[].
   * Validates severity values and discards invalid findings.
   */
  private parseSemanticFindings(content: string): ReviewFinding[] {
    try {
      // Extract JSON from response (Opus might wrap it in markdown code blocks)
      let jsonStr = content.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1]!.trim();
      }

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [];

      const findings: ReviewFinding[] = [];
      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          typeof item.section === "string" &&
          typeof item.severity === "string" &&
          typeof item.description === "string" &&
          VALID_SEVERITIES.has(item.severity)
        ) {
          findings.push({
            section: item.section,
            severity: item.severity as FindingSeverity,
            description: item.description,
          });
        }
        // Discard findings with unknown severity
      }
      return findings;
    } catch {
      // Graceful degradation — Opus returned prose instead of JSON
      return [];
    }
  }

  /**
   * Merge structural and semantic findings, deduplicating by (section, description).
   */
  private mergeFindings(
    structural: readonly ReviewFinding[],
    semantic: readonly ReviewFinding[],
  ): ReviewFinding[] {
    const seen = new Set<string>();
    const merged: ReviewFinding[] = [];

    for (const f of structural) {
      const key = `${f.section}::${f.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(f);
      }
    }

    for (const f of semantic) {
      const key = `${f.section}::${f.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(f);
      }
    }

    return merged;
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
