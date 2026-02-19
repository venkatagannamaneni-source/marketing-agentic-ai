import type { Task } from "../types/task.ts";
import type {
  QualityScore,
  DimensionScore,
  QualityDimension,
  SkillQualityCriteria,
  QualityThreshold,
} from "../types/quality.ts";
import type { ReviewFinding, FindingSeverity, ReviewVerdict } from "../types/review.ts";
import type { ClaudeClient } from "../agents/claude-client.ts";
import { MODEL_MAP, estimateCost } from "../agents/claude-client.ts";
import type { BudgetState } from "./types.ts";
import type { ModelTier } from "../types/agent.ts";
import { QUALITY_DIMENSIONS } from "../types/quality.ts";

// ── Quality Scorer ──────────────────────────────────────────────────────────

export class QualityScorer {
  constructor(private readonly client?: ClaudeClient) {}

  /**
   * Score output using structural heuristics only. No API call.
   */
  scoreStructural(
    task: Task,
    outputContent: string,
    criteria: SkillQualityCriteria,
  ): QualityScore {
    const dimensions: DimensionScore[] = [];

    for (const dim of criteria.dimensions) {
      const score = this.scoreStructuralDimension(
        dim.dimension,
        outputContent,
        criteria,
      );
      dimensions.push({
        dimension: dim.dimension,
        score,
        weight: dim.weight,
        rationale: this.structuralRationale(dim.dimension, score),
      });
    }

    const overallScore = this.computeWeightedAverage(dimensions);

    return {
      taskId: task.id,
      skill: task.to,
      dimensions,
      overallScore,
      scoredAt: new Date().toISOString(),
      scoredBy: "structural",
    };
  }

  /**
   * Score output using Claude semantic analysis.
   * Falls back to structural scoring if no client.
   */
  async scoreSemantic(
    task: Task,
    outputContent: string,
    criteria: SkillQualityCriteria,
    budgetState?: BudgetState,
  ): Promise<{ score: QualityScore; cost: number }> {
    if (!this.client) {
      return { score: this.scoreStructural(task, outputContent, criteria), cost: 0 };
    }

    const modelTier: ModelTier = budgetState?.modelOverride ?? "opus";

    try {
      const { dimensions, cost } = await this.performSemanticScoring(
        task,
        outputContent,
        criteria,
        modelTier,
      );

      const overallScore = this.computeWeightedAverage(dimensions);

      return {
        score: {
          taskId: task.id,
          skill: task.to,
          dimensions,
          overallScore,
          scoredAt: new Date().toISOString(),
          scoredBy: "semantic",
        },
        cost,
      };
    } catch {
      // Fall back to structural on any failure
      return { score: this.scoreStructural(task, outputContent, criteria), cost: 0 };
    }
  }

  /**
   * Map a QualityScore to a ReviewVerdict using the criteria's threshold.
   */
  scoreToVerdict(
    score: QualityScore,
    criteria: SkillQualityCriteria,
  ): ReviewVerdict {
    const threshold: QualityThreshold = criteria.threshold;

    // Check per-dimension minimums first
    for (const dim of score.dimensions) {
      const criterionDim = criteria.dimensions.find(
        (d) => d.dimension === dim.dimension,
      );
      if (criterionDim && criterionDim.minScore > 0 && dim.score < criterionDim.minScore) {
        // A dimension below its minimum triggers at least REVISE
        if (dim.score < threshold.rejectBelow) {
          return "REJECT";
        }
        return "REVISE";
      }
    }

    // Check overall score against thresholds
    if (score.overallScore < threshold.rejectBelow) {
      return "REJECT";
    }
    if (score.overallScore < threshold.reviseBelow) {
      return "REVISE";
    }
    return "APPROVE";
  }

  /**
   * Convert dimensional scores into ReviewFindings for backward compatibility.
   */
  scoreToFindings(score: QualityScore): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    for (const dim of score.dimensions) {
      if (dim.score < 4.0) {
        findings.push({
          section: dim.dimension,
          severity: "major" as FindingSeverity,
          description: `${formatDimensionName(dim.dimension)} score is ${dim.score}/10: ${dim.rationale}`,
        });
      } else if (dim.score < 6.0) {
        findings.push({
          section: dim.dimension,
          severity: "minor" as FindingSeverity,
          description: `${formatDimensionName(dim.dimension)} could be improved (${dim.score}/10): ${dim.rationale}`,
        });
      }
    }

    return findings;
  }

  // ── Internal: Structural Scoring ──────────────────────────────────────

  private scoreStructuralDimension(
    dimension: QualityDimension,
    output: string,
    criteria: SkillQualityCriteria,
  ): number {
    switch (dimension) {
      case "completeness":
        return this.scoreCompleteness(output, criteria);
      case "clarity":
        return this.scoreClarity(output);
      case "actionability":
        return this.scoreActionability(output);
      case "brand_alignment":
        return this.scoreBrandAlignment(output);
      case "data_driven":
        return this.scoreDataDriven(output);
      case "technical_accuracy":
        return this.scoreTechnicalAccuracy(output);
      case "creativity":
        // Hard to score structurally; default to neutral
        return 5.0;
    }
  }

  private scoreCompleteness(output: string, criteria: SkillQualityCriteria): number {
    let score = 5.0;
    const words = output.split(/\s+/).filter((w) => w.length > 0);

    // Word count check
    if (words.length >= criteria.minWordCount) {
      score += 2.0;
    } else if (words.length >= criteria.minWordCount * 0.5) {
      score += 1.0;
    } else {
      score -= 2.0;
    }

    // Required sections check
    if (criteria.requiredSections.length > 0) {
      let found = 0;
      for (const section of criteria.requiredSections) {
        const pattern = new RegExp(`#.*${escapeRegex(section)}`, "i");
        if (pattern.test(output)) found++;
      }
      const sectionRatio = found / criteria.requiredSections.length;
      score += sectionRatio * 3.0 - 1.5; // range: -1.5 to +1.5
    }

    return clamp(score, 0, 10);
  }

  private scoreClarity(output: string): number {
    let score = 5.0;

    // Has headings
    if (/^#+\s+.+/m.test(output)) score += 1.5;

    // Has bullet points or numbered lists
    if (/^[-*\d]+[.)]\s+/m.test(output)) score += 1.0;

    // Reasonable paragraph lengths (no walls of text)
    const paragraphs = output.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const avgLen =
      paragraphs.length > 0
        ? paragraphs.reduce((s, p) => s + p.length, 0) / paragraphs.length
        : 0;
    if (avgLen > 0 && avgLen < 1000) score += 1.0;
    if (avgLen > 2000) score -= 1.5;

    // Multiple sections suggests good organization
    if (paragraphs.length >= 3) score += 0.5;

    return clamp(score, 0, 10);
  }

  private scoreActionability(output: string): number {
    let score = 5.0;

    // Has numbered lists (suggests steps/recommendations)
    if (/^\d+[.)]\s+/m.test(output)) score += 1.5;

    // Action verbs
    const actionVerbs = /\b(implement|create|add|remove|optimize|test|measure|track|update|launch|deploy)\b/gi;
    const actionCount = (output.match(actionVerbs) ?? []).length;
    if (actionCount >= 5) score += 2.0;
    else if (actionCount >= 2) score += 1.0;

    // Specific recommendations
    if (/recommend/i.test(output)) score += 0.5;

    return clamp(score, 0, 10);
  }

  private scoreBrandAlignment(output: string): number {
    let score = 6.0; // Start optimistic — most generated content is professional

    // Negative signals
    if (/!!!/g.test(output)) score -= 1.0;
    if (/\b(amazing|incredible|revolutionary|game-changing)\b/gi.test(output)) score -= 0.5;
    if (/[A-Z]{5,}/g.test(output)) score -= 1.0; // Excessive caps

    return clamp(score, 0, 10);
  }

  private scoreDataDriven(output: string): number {
    let score = 3.0; // Start low — data is opt-in

    // Numbers and percentages
    const numberMatches = (output.match(/\d+%|\$\d+|\d+x|\d+\.\d+/g) ?? []).length;
    if (numberMatches >= 5) score += 3.0;
    else if (numberMatches >= 2) score += 2.0;
    else if (numberMatches >= 1) score += 1.0;

    // Metrics/KPI mentions
    if (/\b(metric|KPI|conversion|rate|ROI|ROAS|CTR|CPA|LTV|MRR|ARR)\b/gi.test(output)) {
      score += 2.0;
    }

    // Data source references
    if (/\b(research|study|survey|data|analysis|benchmark)\b/gi.test(output)) {
      score += 1.0;
    }

    return clamp(score, 0, 10);
  }

  private scoreTechnicalAccuracy(output: string): number {
    // Structural heuristic — mostly checking for red flags
    let score = 6.0;

    // Contradiction patterns (rough heuristic)
    if (/\bbut also\b.*\bnot\b/gi.test(output)) score -= 0.5;

    // Empty claims without support
    if (/\b(always|never|guaranteed|100%)\b/gi.test(output)) score -= 1.0;

    return clamp(score, 0, 10);
  }

  private structuralRationale(dimension: QualityDimension, score: number): string {
    if (score >= 7) return "Passes structural heuristics.";
    if (score >= 5) return "Partially meets structural expectations.";
    return "Below structural expectations.";
  }

  // ── Internal: Semantic Scoring ────────────────────────────────────────

  private async performSemanticScoring(
    task: Task,
    outputContent: string,
    criteria: SkillQualityCriteria,
    modelTier: ModelTier,
  ): Promise<{ dimensions: DimensionScore[]; cost: number }> {
    const dimensionList = criteria.dimensions
      .map((d) => `${d.dimension} (weight: ${d.weight})`)
      .join(", ");

    const systemPrompt = `You are scoring marketing output quality on specific dimensions (0-10 scale).

Skill: ${task.to}
Required quality dimensions: ${dimensionList}

Score each dimension from 0 (terrible) to 10 (excellent).
Respond with ONLY a JSON object mapping dimension names to {score, rationale}.

Example:
{"completeness":{"score":8,"rationale":"Covers all requirements"},"clarity":{"score":7,"rationale":"Well structured with clear headings"}}`;

    const userMessage = `Task requirements: ${task.requirements}

Output to evaluate:
${outputContent}`;

    const result = await this.client!.createMessage({
      model: MODEL_MAP[modelTier],
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 2048,
      timeoutMs: 60_000,
    });

    const cost = estimateCost(modelTier, result.inputTokens, result.outputTokens);
    const parsed = this.parseSemanticScores(result.content, criteria);

    return { dimensions: parsed, cost };
  }

  private parseSemanticScores(
    content: string,
    criteria: SkillQualityCriteria,
  ): DimensionScore[] {
    try {
      let jsonStr = content.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1]!.trim();
      }

      const parsed = JSON.parse(jsonStr) as Record<
        string,
        { score?: number; rationale?: string }
      >;

      const dimensions: DimensionScore[] = [];
      for (const dim of criteria.dimensions) {
        const entry = parsed[dim.dimension];
        if (
          entry &&
          typeof entry.score === "number" &&
          entry.score >= 0 &&
          entry.score <= 10
        ) {
          dimensions.push({
            dimension: dim.dimension,
            score: entry.score,
            weight: dim.weight,
            rationale: typeof entry.rationale === "string" ? entry.rationale : "",
          });
        } else {
          // Fallback to neutral for missing dimensions
          dimensions.push({
            dimension: dim.dimension,
            score: 5.0,
            weight: dim.weight,
            rationale: "Not scored by semantic review.",
          });
        }
      }
      return dimensions;
    } catch {
      // Return neutral scores on parse failure
      return criteria.dimensions.map((d) => ({
        dimension: d.dimension,
        score: 5.0,
        weight: d.weight,
        rationale: "Semantic scoring parse failure — defaulted to neutral.",
      }));
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private computeWeightedAverage(dimensions: readonly DimensionScore[]): number {
    let totalWeight = 0;
    let weightedSum = 0;
    for (const d of dimensions) {
      weightedSum += d.score * d.weight;
      totalWeight += d.weight;
    }
    if (totalWeight === 0) return 0;
    return Math.round((weightedSum / totalWeight) * 100) / 100;
  }
}

// ── Module-level Helpers ─────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDimensionName(dim: QualityDimension): string {
  return dim
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
