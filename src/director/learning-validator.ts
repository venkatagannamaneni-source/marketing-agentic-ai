import type { Task } from "../types/task.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { AgentExecutor, ExecutionResult } from "../agents/executor.ts";
import type { QualityScorer } from "./quality-scorer.ts";
import { getSkillCriteria } from "./quality-criteria.ts";
import { NULL_LOGGER } from "../observability/logger.ts";
import type { Logger } from "../observability/logger.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface LearningValidationResult {
  readonly taskId: string;
  readonly skill: string;
  readonly withLearnings: {
    readonly score: number;
    readonly outputLength: number;
    readonly executionCost: number;
  };
  readonly withoutLearnings: {
    readonly score: number;
    readonly outputLength: number;
    readonly executionCost: number;
  };
  readonly scoreDelta: number; // positive = learnings helped
  readonly learningsUsed: string;
  readonly validatedAt: string;
}

export interface LearningEffectivenessReport {
  readonly totalTests: number;
  readonly averageLift: number; // average score delta
  readonly positiveImpactCount: number; // tests where learnings helped
  readonly negativeImpactCount: number; // tests where learnings hurt
  readonly neutralImpactCount: number; // no significant difference (delta < 0.5)
  readonly topPerformingSkills: readonly string[];
  readonly recommendPruning: readonly string[]; // skills where learnings hurt
}

// ── Learning Validator ───────────────────────────────────────────────────────

export class LearningValidator {
  private readonly logger: Logger;

  constructor(
    private readonly executor: AgentExecutor,
    private readonly workspace: WorkspaceManager,
    private readonly qualityScorer?: QualityScorer,
    logger?: Logger,
  ) {
    this.logger = (logger ?? NULL_LOGGER).child({ module: "learning-validator" });
  }

  /**
   * Run A/B test: execute a task with and without learnings, then compare quality.
   */
  async validateLearningImpact(
    task: Task,
    learnings: string,
  ): Promise<LearningValidationResult> {
    this.logger.info("learning_validation_started", {
      taskId: task.id,
      skill: task.to,
    });

    // Run WITH learnings
    const withResult = await this.safeExecute(task);

    // Create task copy WITHOUT learnings-related inputs
    const taskWithoutLearnings = this.removeLearningsInputs(task);
    const withoutResult = await this.safeExecute(taskWithoutLearnings);

    // Score both outputs
    const withScore = this.scoreOutput(task, withResult);
    const withoutScore = this.scoreOutput(task, withoutResult);

    const result: LearningValidationResult = {
      taskId: task.id,
      skill: task.to,
      withLearnings: {
        score: withScore,
        outputLength: withResult?.content.length ?? 0,
        executionCost: withResult?.metadata.estimatedCost ?? 0,
      },
      withoutLearnings: {
        score: withoutScore,
        outputLength: withoutResult?.content.length ?? 0,
        executionCost: withoutResult?.metadata.estimatedCost ?? 0,
      },
      scoreDelta: withScore - withoutScore,
      learningsUsed: learnings,
      validatedAt: new Date().toISOString(),
    };

    this.logger.info("learning_validation_completed", {
      taskId: task.id,
      skill: task.to,
      scoreDelta: result.scoreDelta,
    });

    return result;
  }

  /**
   * Fast structural quality scoring without Claude API calls.
   * Returns a score 0-10.
   */
  structuralQualityScore(content: string): number {
    if (!content || content.trim().length === 0) {
      return 0;
    }

    let score = 0;

    // Content length (0-3 points)
    const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
    if (wordCount >= 500) {
      score += 3;
    } else if (wordCount >= 200) {
      score += 2;
    } else if (wordCount >= 50) {
      score += 1;
    }

    // Markdown structure (0-2 points)
    const headings = content.match(/^#{1,6}\s+.+/gm) ?? [];
    if (headings.length >= 4) {
      score += 2;
    } else if (headings.length >= 2) {
      score += 1;
    }

    // Section depth (0-1 point)
    const deepHeadings = content.match(/^#{3,6}\s+.+/gm) ?? [];
    if (deepHeadings.length >= 2) {
      score += 1;
    }

    // Lists and structure (0-1 point)
    const hasBullets = /^[-*]\s+/m.test(content);
    const hasNumberedList = /^\d+[.)]\s+/m.test(content);
    if (hasBullets || hasNumberedList) {
      score += 1;
    }

    // Specificity vs generic (0-3 points)
    const genericPhrases = (
      content.match(/\b(e\.g\.|for example|such as|in general|generally speaking|best practices)\b/gi) ?? []
    ).length;
    const specificIndicators = (
      content.match(/\b(\d+%|\$\d+|\d+x|Q[1-4]|ROI|CTR|CPA|LTV|MRR|ARR)\b/gi) ?? []
    ).length;

    if (specificIndicators >= 5 && genericPhrases <= 2) {
      score += 3;
    } else if (specificIndicators >= 2) {
      score += 2;
    } else if (genericPhrases <= 1) {
      score += 1;
    }

    return Math.min(score, 10);
  }

  /**
   * Aggregate multiple A/B results into an effectiveness report.
   */
  analyzeLearningEffectiveness(
    results: readonly LearningValidationResult[],
  ): LearningEffectivenessReport {
    if (results.length === 0) {
      return {
        totalTests: 0,
        averageLift: 0,
        positiveImpactCount: 0,
        negativeImpactCount: 0,
        neutralImpactCount: 0,
        topPerformingSkills: [],
        recommendPruning: [],
      };
    }

    const totalTests = results.length;
    const totalLift = results.reduce((sum, r) => sum + r.scoreDelta, 0);
    const averageLift = Math.round((totalLift / totalTests) * 100) / 100;

    let positiveImpactCount = 0;
    let negativeImpactCount = 0;
    let neutralImpactCount = 0;

    // Track per-skill deltas for aggregation
    const skillDeltas = new Map<string, number[]>();

    for (const result of results) {
      if (result.scoreDelta >= 0.5) {
        positiveImpactCount++;
      } else if (result.scoreDelta <= -0.5) {
        negativeImpactCount++;
      } else {
        neutralImpactCount++;
      }

      const existing = skillDeltas.get(result.skill) ?? [];
      existing.push(result.scoreDelta);
      skillDeltas.set(result.skill, existing);
    }

    // Identify top performing skills (average delta >= 0.5)
    const topPerformingSkills: string[] = [];
    const recommendPruning: string[] = [];

    for (const [skill, deltas] of skillDeltas) {
      const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
      if (avgDelta >= 0.5) {
        topPerformingSkills.push(skill);
      }
      if (avgDelta <= -0.5) {
        recommendPruning.push(skill);
      }
    }

    // Sort by impact (highest first for top, lowest first for pruning)
    topPerformingSkills.sort((a, b) => {
      const avgA = average(skillDeltas.get(a)!);
      const avgB = average(skillDeltas.get(b)!);
      return avgB - avgA;
    });

    recommendPruning.sort((a, b) => {
      const avgA = average(skillDeltas.get(a)!);
      const avgB = average(skillDeltas.get(b)!);
      return avgA - avgB;
    });

    return {
      totalTests,
      averageLift,
      positiveImpactCount,
      negativeImpactCount,
      neutralImpactCount,
      topPerformingSkills,
      recommendPruning,
    };
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  private async safeExecute(task: Task): Promise<ExecutionResult | null> {
    try {
      return await this.executor.execute(task);
    } catch (err: unknown) {
      this.logger.error("learning_validation_execution_failed", {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private removeLearningsInputs(task: Task): Task {
    const filteredInputs = task.inputs.filter(
      (input) =>
        !input.path.includes("learnings") &&
        !input.path.includes("memory/"),
    );
    return {
      ...task,
      inputs: filteredInputs,
    };
  }

  private scoreOutput(task: Task, result: ExecutionResult | null): number {
    if (!result || result.status === "failed" || !result.content) {
      return 0;
    }

    // Use QualityScorer if available
    if (this.qualityScorer) {
      const criteria = getSkillCriteria(task.to);
      const qualityScore = this.qualityScorer.scoreStructural(
        task,
        result.content,
        criteria,
      );
      return qualityScore.overallScore;
    }

    // Fall back to structural heuristic
    return this.structuralQualityScore(result.content);
  }
}

// ── Module-level Helpers ─────────────────────────────────────────────────────

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
