import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
import type { QualityScore, SkillQualityCriteria } from "../types/quality.ts";
import type { QualityScorer } from "./quality-scorer.ts";

// ── Review Depth ────────────────────────────────────────────────────────────

/**
 * Controls how deeply the semantic review analyzes the output:
 * - "quick": Structural validation only — no API call (fastest, free)
 * - "standard": Structural + Sonnet semantic review (balanced cost/quality)
 * - "deep": Structural + Opus semantic review with full SKILL.md context (most thorough)
 */
export type ReviewDepth = "quick" | "standard" | "deep";

// ── Semantic Review Config ──────────────────────────────────────────────────

export interface SemanticReviewConfig {
  /** Review depth: quick (structural only), standard (sonnet), deep (opus + SKILL.md) */
  readonly depth: ReviewDepth;
  /** Project root for loading SKILL.md files. Required for "deep" depth. */
  readonly projectRoot?: string;
  /** Maximum tokens for the review response */
  readonly maxResponseTokens?: number;
}

export const DEFAULT_SEMANTIC_REVIEW_CONFIG: SemanticReviewConfig = {
  depth: "deep",
  maxResponseTokens: 4096,
};

// ── Semantic Review Result ──────────────────────────────────────────────────

export interface SemanticReviewResult {
  readonly decision: DirectorDecision;
  readonly reviewCost: number;
  /** The review depth that was actually used (may differ from requested if client unavailable) */
  readonly reviewDepth: ReviewDepth;
}

// ── Review Engine ────────────────────────────────────────────────────────────

const VALID_SEVERITIES: ReadonlySet<string> = new Set<string>([
  "critical",
  "major",
  "minor",
  "suggestion",
]);

const VALID_VERDICTS: ReadonlySet<string> = new Set<string>([
  "APPROVE",
  "REVISE",
  "REJECT",
]);

export interface QualityReviewResult {
  readonly decision: DirectorDecision;
  readonly qualityScore: QualityScore;
  readonly reviewCost: number;
}

/**
 * Internal structured response from Claude's semantic review.
 * Contains the parsed verdict, findings, and revision instructions.
 */
interface SemanticReviewResponse {
  readonly findings: ReviewFinding[];
  readonly cost: number;
  /** Claude's recommended verdict, or null if parsing failed / legacy format */
  readonly verdict: ReviewVerdict | null;
  /** Specific revision instructions for the agent, or null if not applicable */
  readonly revisionInstructions: string | null;
  /** One-line review summary from Claude, or null if not provided */
  readonly summary: string | null;
}

export class ReviewEngine {
  constructor(
    private readonly config: DirectorConfig,
    private readonly client?: ClaudeClient,
    private readonly qualityScorer?: QualityScorer,
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
   * AND Claude semantic review. Falls back to structural-only if
   * no ClaudeClient was provided.
   *
   * Accepts an optional SemanticReviewConfig to control review depth:
   * - "quick": Structural only (no API call)
   * - "standard": Structural + Sonnet review (cost-effective)
   * - "deep": Structural + Opus review with SKILL.md context (most thorough)
   *
   * Returns the decision, cost, and actual review depth used.
   */
  async evaluateTaskSemantic(
    task: Task,
    outputContent: string,
    existingReviews: readonly Review[],
    budgetState?: BudgetState,
    reviewConfig?: SemanticReviewConfig,
  ): Promise<SemanticReviewResult> {
    const config = reviewConfig ?? DEFAULT_SEMANTIC_REVIEW_CONFIG;
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

    // 2. Short-circuit: quick depth, critical findings, or no client
    const hasCriticalStructural = structuralFindings.some(
      (f) => f.severity === "critical",
    );
    if (config.depth === "quick" || hasCriticalStructural || !this.client) {
      const decision = this.buildDecisionFromFindings(
        task,
        structuralFindings,
        revisionRequests,
        existingReviews,
        reviewIndex,
      );
      return { decision, reviewCost: 0, reviewDepth: "quick" };
    }

    // 3. Determine model tier based on depth + budget
    let reviewModelTier: ModelTier;
    if (budgetState?.modelOverride) {
      reviewModelTier = budgetState.modelOverride;
    } else if (config.depth === "standard") {
      reviewModelTier = "sonnet";
    } else {
      reviewModelTier = "opus";
    }

    // 4. Load SKILL.md content for deep reviews
    let skillContent: string | null = null;
    if (config.depth === "deep" && config.projectRoot) {
      skillContent = await this.loadSkillContent(task.to, config.projectRoot);
    }

    // 5. Perform semantic review with skill context
    const semanticResult = await this.performSemanticReview(
      task,
      outputContent,
      reviewModelTier,
      skillContent,
      config.maxResponseTokens,
    );

    // 6. Merge structural + semantic findings, deduplicate
    const allFindings = this.mergeFindings(
      structuralFindings,
      semanticResult.findings,
    );

    // 7. Build decision — use Claude's verdict if available, else derive from findings
    const decision = this.buildDecisionFromSemanticResult(
      task,
      allFindings,
      semanticResult,
      existingReviews,
      reviewIndex,
    );

    return {
      decision,
      reviewCost: semanticResult.cost,
      reviewDepth: config.depth,
    };
  }

  /**
   * Evaluate a completed task with dimensional quality scoring.
   * Returns both a DirectorDecision and a QualityScore.
   * Requires a QualityScorer to be provided in the constructor.
   * Falls back to structural-only scoring if no ClaudeClient.
   */
  async evaluateTaskWithQuality(
    task: Task,
    outputContent: string,
    existingReviews: readonly Review[],
    criteria: SkillQualityCriteria,
    budgetState?: BudgetState,
  ): Promise<QualityReviewResult> {
    if (!this.qualityScorer) {
      // No quality scorer — fall back to standard semantic evaluation
      const result = await this.evaluateTaskSemantic(
        task,
        outputContent,
        existingReviews,
        budgetState,
      );
      // Return a placeholder quality score
      const placeholderScore: QualityScore = {
        taskId: task.id,
        skill: task.to,
        dimensions: [],
        overallScore: 0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural",
      };
      return {
        decision: result.decision,
        qualityScore: placeholderScore,
        reviewCost: result.reviewCost,
      };
    }

    // Score using the quality scorer
    const { score: qualityScore, cost } = this.client
      ? await this.qualityScorer.scoreSemantic(
          task,
          outputContent,
          criteria,
          budgetState,
        )
      : { score: this.qualityScorer.scoreStructural(task, outputContent, criteria), cost: 0 };

    // Convert quality score to verdict
    const verdict = this.qualityScorer.scoreToVerdict(qualityScore, criteria);

    // Convert to findings for the review
    const findings = this.qualityScorer.scoreToFindings(qualityScore);

    // Build decision using existing infrastructure
    const reviewIndex = existingReviews.length;
    const decision = this.buildDecisionFromFindings(
      task,
      findings,
      [],
      existingReviews,
      reviewIndex,
    );

    return {
      decision,
      qualityScore,
      reviewCost: cost,
    };
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
   * Perform semantic review via Claude.
   *
   * Enhanced prompt asks Claude for a structured JSON response containing:
   * - verdict: APPROVE / REVISE / REJECT
   * - findings: array of issues found
   * - revisionInstructions: specific feedback for the agent to improve (if REVISE)
   * - summary: one-line summary of the review
   *
   * When skillContent is provided (deep mode), the review is contextualized
   * against the skill's quality criteria from its SKILL.md file.
   *
   * Degrades gracefully on parse errors — returns empty findings.
   */
  private async performSemanticReview(
    task: Task,
    outputContent: string,
    modelTier: ModelTier = "opus",
    skillContent?: string | null,
    maxResponseTokens?: number,
  ): Promise<SemanticReviewResponse> {
    const skillContext = skillContent
      ? `\n\nThe agent's SKILL.md (quality criteria and output expectations):\n<skill-definition>\n${skillContent}\n</skill-definition>`
      : "";

    const revisionContext = task.revisionCount > 0
      ? `\n\nThis is revision #${task.revisionCount}. The original requirements include revision feedback from a prior review. Pay special attention to whether the revision feedback has been addressed.`
      : "";

    const systemPrompt = `You are the Marketing Director reviewing an agent's output for quality.
You are an expert evaluator of marketing content, strategy, and copy.${skillContext}

Evaluate the output against these criteria:
1. **Completeness**: Does the output address ALL requirements in the task? Are any sections missing?
2. **Quality**: Is the output specific, actionable, and well-structured? Does it go beyond generic advice?
3. **Brand alignment**: Does it match professional marketing standards? Is the tone appropriate?
4. **Data-driven**: Are recommendations backed by evidence, principles, or specific metrics?
5. **Actionability**: Can the next agent or human actually implement these recommendations?
6. **Specificity**: Does it reference the actual product/context rather than using generic placeholders?${revisionContext}

Respond with ONLY a JSON object (no markdown code blocks, no prose before/after):

{
  "verdict": "APPROVE" | "REVISE" | "REJECT",
  "findings": [
    {
      "section": "the part of the output with the issue",
      "severity": "critical" | "major" | "minor" | "suggestion",
      "description": "specific, actionable description of the issue"
    }
  ],
  "revisionInstructions": "If verdict is REVISE: specific, prioritized instructions for the agent to improve the output. Be concrete — reference specific sections, suggest exact changes, and explain why. If APPROVE: leave empty string.",
  "summary": "One-line summary of the review decision."
}

Severity guide:
- critical: Output is fundamentally wrong, off-topic, or harmful. Must be rejected.
- major: Significant gap that makes the output insufficient for its purpose. Must be revised.
- minor: Small issue that could improve quality but doesn't block approval.
- suggestion: Optional improvement that would make good output better.

Verdict rules:
- APPROVE: No critical or major findings. Output is ready to use.
- REVISE: Has major findings but is salvageable. Agent should fix and resubmit.
- REJECT: Has critical findings or is fundamentally unsuitable.`;

    const userMessage = `Task skill: ${task.to}
Goal: ${task.goal}
Requirements: ${task.requirements}

Agent Output:
${outputContent}`;

    try {
      const result = await this.client!.createMessage({
        model: MODEL_MAP[modelTier],
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        maxTokens: maxResponseTokens ?? 4096,
        timeoutMs: 60_000,
      });

      const cost = estimateCost(
        modelTier,
        result.inputTokens,
        result.outputTokens,
      );

      // Parse structured JSON response
      return this.parseSemanticResponse(result.content, cost);
    } catch {
      // Graceful degradation
      return { findings: [], cost: 0, verdict: null, revisionInstructions: null, summary: null };
    }
  }

  /**
   * Load a skill's SKILL.md content for context-aware review.
   * Returns null if the file cannot be read (non-fatal).
   */
  private async loadSkillContent(
    skillName: SkillName,
    projectRoot: string,
  ): Promise<string | null> {
    try {
      const skillPath = resolve(projectRoot, ".agents", "skills", skillName, "SKILL.md");
      return await readFile(skillPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Parse the Claude response as a structured JSON review result.
   *
   * Supports two response formats for backward compatibility:
   * 1. New structured format: { verdict, findings, revisionInstructions, summary }
   * 2. Legacy array format: [ { section, severity, description } ]
   *
   * Validates severity and verdict values, discards invalid entries.
   */
  private parseSemanticResponse(content: string, cost: number): SemanticReviewResponse {
    try {
      const jsonStr = this.extractJson(content);
      const parsed = JSON.parse(jsonStr);

      // Handle legacy array format (backward compatibility)
      if (Array.isArray(parsed)) {
        const findings = this.validateFindings(parsed);
        return { findings, cost, verdict: null, revisionInstructions: null, summary: null };
      }

      // Handle new structured format
      if (typeof parsed === "object" && parsed !== null) {
        const findings = Array.isArray(parsed.findings)
          ? this.validateFindings(parsed.findings)
          : [];

        const verdict: ReviewVerdict | null =
          typeof parsed.verdict === "string" && VALID_VERDICTS.has(parsed.verdict)
            ? (parsed.verdict as ReviewVerdict)
            : null;

        const revisionInstructions =
          typeof parsed.revisionInstructions === "string" && parsed.revisionInstructions.trim().length > 0
            ? parsed.revisionInstructions.trim()
            : null;

        const summary =
          typeof parsed.summary === "string" && parsed.summary.trim().length > 0
            ? parsed.summary.trim()
            : null;

        return { findings, cost, verdict, revisionInstructions, summary };
      }

      return { findings: [], cost, verdict: null, revisionInstructions: null, summary: null };
    } catch {
      // Graceful degradation — Claude returned prose instead of JSON
      return { findings: [], cost, verdict: null, revisionInstructions: null, summary: null };
    }
  }

  /**
   * Extract JSON string from Claude's response, handling markdown code blocks.
   */
  private extractJson(content: string): string {
    let jsonStr = content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1]!.trim();
    }
    return jsonStr;
  }

  /**
   * Validate and filter an array of raw finding objects.
   * Discards entries with missing fields or unknown severity values.
   */
  private validateFindings(items: unknown[]): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    for (const item of items) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).section === "string" &&
        typeof (item as Record<string, unknown>).severity === "string" &&
        typeof (item as Record<string, unknown>).description === "string" &&
        VALID_SEVERITIES.has((item as Record<string, unknown>).severity as string)
      ) {
        findings.push({
          section: (item as Record<string, unknown>).section as string,
          severity: (item as Record<string, unknown>).severity as FindingSeverity,
          description: (item as Record<string, unknown>).description as string,
        });
      }
    }
    return findings;
  }

  /**
   * Build a DirectorDecision using semantic review results.
   *
   * If Claude provided a verdict, uses it directly (semantic intelligence).
   * Otherwise falls back to deriving verdict from finding severities.
   *
   * When revisionInstructions are available, they are included in the
   * revision requests for richer feedback to the agent.
   */
  private buildDecisionFromSemanticResult(
    task: Task,
    allFindings: ReviewFinding[],
    semanticResult: SemanticReviewResponse,
    existingReviews: readonly Review[],
    reviewIndex: number,
  ): DirectorDecision {
    const revisionRequests: RevisionRequest[] = [];

    // Determine verdict: prefer Claude's verdict, fall back to finding-based
    let verdict: ReviewVerdict;
    if (semanticResult.verdict) {
      verdict = semanticResult.verdict;
    } else {
      const hasCritical = allFindings.some((f) => f.severity === "critical");
      const hasMajor = allFindings.some((f) => f.severity === "major");
      if (hasCritical) verdict = "REJECT";
      else if (hasMajor) verdict = "REVISE";
      else verdict = "APPROVE";
    }

    // Build revision requests from findings + semantic instructions
    if (verdict === "REVISE") {
      // Add semantic revision instructions as the primary request (if available)
      if (semanticResult.revisionInstructions) {
        revisionRequests.push({
          description: semanticResult.revisionInstructions,
          priority: "required",
        });
      }
      // Add major findings as additional requests
      for (const f of allFindings.filter((f) => f.severity === "major")) {
        revisionRequests.push({
          description: f.description,
          priority: "required",
        });
      }
    }

    const action = this.determineAction(verdict, task, existingReviews);

    const summary = semanticResult.summary
      ?? (verdict === "APPROVE"
        ? "Output meets structural and semantic requirements."
        : `Output has ${allFindings.length} finding(s) requiring attention.`);

    const review = this.buildReview(
      task.id,
      task.to,
      verdict,
      allFindings,
      revisionRequests,
      summary,
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
        summary,
      );
    }

    return {
      taskId: task.id,
      action,
      review,
      nextTasks,
      learning,
      escalation,
      reasoning: this.buildReasoning(verdict, action, allFindings),
    };
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
