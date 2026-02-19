import { describe, it, expect } from "bun:test";
import { QualityScorer } from "../quality-scorer.ts";
import { getSkillCriteria } from "../quality-criteria.ts";
import { createTestTask, createTestOutput, createMockClaudeClient } from "./helpers.ts";
import type { SkillQualityCriteria } from "../../types/quality.ts";
import { DEFAULT_QUALITY_THRESHOLD } from "../../types/quality.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const pageCroCriteria = getSkillCriteria("page-cro");

function createMinimalOutput(): string {
  return "Short output.";
}

function createRichOutput(): string {
  return `# Page CRO Audit

## Executive Summary

This audit evaluates the signup page for conversion optimization opportunities.
We identified several key areas for improvement based on CRO best practices.
The current conversion rate is 2.3%, and we aim to increase it to 3.5%.

## Findings

### Above the Fold
- Headline clarity: The current headline does not communicate the core value proposition
- CTA button: Low contrast, positioned below the fold on mobile
- Hero image: Does not show the product in use

### Form Analysis
- Too many required fields (7 fields; best practice is 3-5)
- No inline validation feedback
- Missing progress indicator

## Recommendations

1. Simplify the form to 3 essential fields (name, email, password)
2. Move CTA above the fold with high-contrast design
3. Add inline validation and progress indicators
4. Implement social proof near the CTA
5. Create urgency with limited-time offer messaging
6. Optimize page load time to under 2 seconds

## Expected Impact

Estimated conversion lift: 15-25% based on similar optimizations.
ROI projection: $50,000 additional revenue per quarter.
KPI targets: CTR increase of 30%, bounce rate reduction of 20%.
`;
}

// ── scoreStructural ─────────────────────────────────────────────────────────

describe("QualityScorer", () => {
  describe("scoreStructural", () => {
    it("returns a QualityScore with correct taskId and skill", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();
      const score = scorer.scoreStructural(task, createRichOutput(), pageCroCriteria);

      expect(score.taskId).toBe(task.id);
      expect(score.skill).toBe(task.to);
      expect(score.scoredBy).toBe("structural");
    });

    it("scores all dimensions defined in criteria", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();
      const score = scorer.scoreStructural(task, createRichOutput(), pageCroCriteria);

      expect(score.dimensions.length).toBe(pageCroCriteria.dimensions.length);
      for (const dim of score.dimensions) {
        expect(dim.score).toBeGreaterThanOrEqual(0);
        expect(dim.score).toBeLessThanOrEqual(10);
        expect(dim.weight).toBeGreaterThanOrEqual(0);
        expect(dim.rationale).toBeTruthy();
      }
    });

    it("computes a weighted average overall score", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();
      const score = scorer.scoreStructural(task, createRichOutput(), pageCroCriteria);

      expect(score.overallScore).toBeGreaterThan(0);
      expect(score.overallScore).toBeLessThanOrEqual(10);
    });

    it("gives low completeness for short output below minWordCount", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();
      const score = scorer.scoreStructural(task, createMinimalOutput(), pageCroCriteria);

      const completeness = score.dimensions.find((d) => d.dimension === "completeness");
      expect(completeness).toBeDefined();
      expect(completeness!.score).toBeLessThan(5);
    });

    it("gives higher completeness for output with required sections", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();

      const fullOutput = createRichOutput();
      const scoreWithSections = scorer.scoreStructural(task, fullOutput, pageCroCriteria);
      const scoreWithout = scorer.scoreStructural(task, "No sections here. ".repeat(50), pageCroCriteria);

      const completenessWithSections = scoreWithSections.dimensions.find(
        (d) => d.dimension === "completeness",
      )!;
      const completenessWithout = scoreWithout.dimensions.find(
        (d) => d.dimension === "completeness",
      )!;

      expect(completenessWithSections.score).toBeGreaterThan(completenessWithout.score);
    });

    it("gives higher clarity for well-structured output with headings", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();

      const scoreStructured = scorer.scoreStructural(task, createRichOutput(), pageCroCriteria);
      const scoreFlat = scorer.scoreStructural(task, "Plain text without any structure. ".repeat(30), pageCroCriteria);

      const clarityStructured = scoreStructured.dimensions.find((d) => d.dimension === "clarity")!;
      const clarityFlat = scoreFlat.dimensions.find((d) => d.dimension === "clarity")!;

      expect(clarityStructured.score).toBeGreaterThan(clarityFlat.score);
    });

    it("gives higher actionability for output with action verbs and numbered lists", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();

      const score = scorer.scoreStructural(task, createRichOutput(), pageCroCriteria);
      const actionability = score.dimensions.find((d) => d.dimension === "actionability")!;

      // Rich output has numbered lists and action verbs
      expect(actionability.score).toBeGreaterThanOrEqual(5);
    });

    it("gives higher data_driven for output with numbers and metrics", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();

      const score = scorer.scoreStructural(task, createRichOutput(), pageCroCriteria);
      const dataDriven = score.dimensions.find((d) => d.dimension === "data_driven")!;

      // Rich output contains percentages, KPI mentions, etc.
      expect(dataDriven.score).toBeGreaterThanOrEqual(5);
    });

    it("detects brand alignment issues (excessive caps, hyperbole)", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();

      const badContent = `# AMAZING PAGE AUDIT!!!

THIS IS INCREDIBLE!!! The results are REVOLUTIONARY and game-changing!!!
ABSOLUTELY GUARANTEED to increase conversions!!!
`.repeat(5);

      const score = scorer.scoreStructural(task, badContent, pageCroCriteria);
      const brandAlignment = score.dimensions.find((d) => d.dimension === "brand_alignment")!;

      expect(brandAlignment.score).toBeLessThan(6);
    });

    it("creativity defaults to 5.0 (neutral)", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();

      const score = scorer.scoreStructural(task, createRichOutput(), pageCroCriteria);
      const creativity = score.dimensions.find((d) => d.dimension === "creativity")!;

      expect(creativity.score).toBe(5.0);
    });

    it("clamps all scores to [0, 10]", () => {
      const scorer = new QualityScorer();
      const task = createTestTask();

      // Very short output should not produce negative scores
      const score = scorer.scoreStructural(task, "", pageCroCriteria);
      for (const dim of score.dimensions) {
        expect(dim.score).toBeGreaterThanOrEqual(0);
        expect(dim.score).toBeLessThanOrEqual(10);
      }
    });
  });

  // ── scoreSemantic ───────────────────────────────────────────────────────────

  describe("scoreSemantic", () => {
    it("falls back to structural when no client provided", async () => {
      const scorer = new QualityScorer();
      const task = createTestTask();

      const { score, cost } = await scorer.scoreSemantic(
        task,
        createRichOutput(),
        pageCroCriteria,
      );

      expect(score.scoredBy).toBe("structural");
      expect(cost).toBe(0);
    });

    it("calls client and returns semantic score on success", async () => {
      const semanticResponse = JSON.stringify({
        completeness: { score: 8, rationale: "Comprehensive coverage" },
        clarity: { score: 9, rationale: "Well organized" },
        actionability: { score: 7, rationale: "Clear next steps" },
        brand_alignment: { score: 8, rationale: "Professional tone" },
        data_driven: { score: 6, rationale: "Some metrics included" },
        technical_accuracy: { score: 7, rationale: "Accurate recommendations" },
        creativity: { score: 5, rationale: "Standard approach" },
      });

      const client = createMockClaudeClient({ content: semanticResponse });
      const scorer = new QualityScorer(client);
      const task = createTestTask();

      const { score, cost } = await scorer.scoreSemantic(
        task,
        createRichOutput(),
        pageCroCriteria,
      );

      expect(score.scoredBy).toBe("semantic");
      expect(cost).toBeGreaterThan(0);
      expect(client.calls.length).toBe(1);

      // Check parsed scores
      const completeness = score.dimensions.find((d) => d.dimension === "completeness");
      expect(completeness).toBeDefined();
      expect(completeness!.score).toBe(8);
    });

    it("falls back to structural on API failure", async () => {
      const client = createMockClaudeClient(() => {
        throw new Error("API error");
      });
      const scorer = new QualityScorer(client);
      const task = createTestTask();

      const { score, cost } = await scorer.scoreSemantic(
        task,
        createRichOutput(),
        pageCroCriteria,
      );

      expect(score.scoredBy).toBe("structural");
      expect(cost).toBe(0);
    });

    it("handles JSON wrapped in code blocks", async () => {
      const semanticResponse = "```json\n" + JSON.stringify({
        completeness: { score: 7, rationale: "Good" },
        clarity: { score: 8, rationale: "Clear" },
        actionability: { score: 6, rationale: "Decent" },
        brand_alignment: { score: 7, rationale: "Ok" },
        data_driven: { score: 5, rationale: "Average" },
        technical_accuracy: { score: 7, rationale: "Correct" },
        creativity: { score: 5, rationale: "Standard" },
      }) + "\n```";

      const client = createMockClaudeClient({ content: semanticResponse });
      const scorer = new QualityScorer(client);
      const task = createTestTask();

      const { score } = await scorer.scoreSemantic(task, createRichOutput(), pageCroCriteria);

      expect(score.scoredBy).toBe("semantic");
      const completeness = score.dimensions.find((d) => d.dimension === "completeness");
      expect(completeness!.score).toBe(7);
    });

    it("defaults missing dimensions to 5.0", async () => {
      // Only provide some dimensions
      const semanticResponse = JSON.stringify({
        completeness: { score: 8, rationale: "Good" },
        // Missing other dimensions
      });

      const client = createMockClaudeClient({ content: semanticResponse });
      const scorer = new QualityScorer(client);
      const task = createTestTask();

      const { score } = await scorer.scoreSemantic(task, createRichOutput(), pageCroCriteria);

      const clarity = score.dimensions.find((d) => d.dimension === "clarity");
      expect(clarity!.score).toBe(5.0);
    });

    it("respects budget model override", async () => {
      const client = createMockClaudeClient({
        content: JSON.stringify({
          completeness: { score: 7, rationale: "Good" },
          clarity: { score: 7, rationale: "Good" },
          actionability: { score: 7, rationale: "Good" },
          brand_alignment: { score: 7, rationale: "Good" },
          data_driven: { score: 7, rationale: "Good" },
          technical_accuracy: { score: 7, rationale: "Good" },
          creativity: { score: 7, rationale: "Good" },
        }),
      });
      const scorer = new QualityScorer(client);
      const task = createTestTask();

      await scorer.scoreSemantic(task, createRichOutput(), pageCroCriteria, {
        totalBudget: 1000,
        spent: 800,
        percentUsed: 80,
        level: "warning",
        allowedPriorities: ["P0", "P1"],
        modelOverride: "sonnet",
      });

      // Verify the model used in the call
      expect(client.calls[0]!.model).toContain("sonnet");
    });
  });

  // ── scoreToVerdict ────────────────────────────────────────────────────────

  describe("scoreToVerdict", () => {
    const scorer = new QualityScorer();

    it("returns APPROVE for high overall score", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: pageCroCriteria.dimensions.map((d) => ({
          dimension: d.dimension,
          score: 8.0,
          weight: d.weight,
          rationale: "Good",
        })),
        overallScore: 8.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      expect(scorer.scoreToVerdict(score, pageCroCriteria)).toBe("APPROVE");
    });

    it("returns REVISE for below-threshold overall score", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: pageCroCriteria.dimensions.map((d) => ({
          dimension: d.dimension,
          score: 6.0,
          weight: d.weight,
          rationale: "Needs work",
        })),
        overallScore: 6.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      expect(scorer.scoreToVerdict(score, pageCroCriteria)).toBe("REVISE");
    });

    it("returns REJECT for very low overall score", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: pageCroCriteria.dimensions.map((d) => ({
          dimension: d.dimension,
          score: 2.0,
          weight: d.weight,
          rationale: "Poor",
        })),
        overallScore: 2.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      expect(scorer.scoreToVerdict(score, pageCroCriteria)).toBe("REJECT");
    });

    it("returns REVISE when a dimension is below its minScore", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: pageCroCriteria.dimensions.map((d) => ({
          dimension: d.dimension,
          // All high except actionability which is below its minScore of 5
          score: d.dimension === "actionability" ? 4.0 : 8.0,
          weight: d.weight,
          rationale: "Test",
        })),
        overallScore: 7.5,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      expect(scorer.scoreToVerdict(score, pageCroCriteria)).toBe("REVISE");
    });

    it("returns REJECT when a dimension is below both minScore and rejectBelow", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: pageCroCriteria.dimensions.map((d) => ({
          dimension: d.dimension,
          // actionability is way below minScore AND below rejectBelow (4.0)
          score: d.dimension === "actionability" ? 3.0 : 8.0,
          weight: d.weight,
          rationale: "Test",
        })),
        overallScore: 7.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      expect(scorer.scoreToVerdict(score, pageCroCriteria)).toBe("REJECT");
    });

    it("works with custom thresholds in criteria", () => {
      const customCriteria: SkillQualityCriteria = {
        ...pageCroCriteria,
        threshold: { approveAbove: 9.0, reviseBelow: 9.0, rejectBelow: 5.0 },
      };

      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: pageCroCriteria.dimensions.map((d) => ({
          dimension: d.dimension,
          score: 8.0,
          weight: d.weight,
          rationale: "Good",
        })),
        overallScore: 8.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      // 8.0 < 9.0 threshold → REVISE
      expect(scorer.scoreToVerdict(score, customCriteria)).toBe("REVISE");
    });
  });

  // ── scoreToFindings ───────────────────────────────────────────────────────

  describe("scoreToFindings", () => {
    const scorer = new QualityScorer();

    it("returns empty findings for all high scores", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: pageCroCriteria.dimensions.map((d) => ({
          dimension: d.dimension,
          score: 8.0,
          weight: d.weight,
          rationale: "Good",
        })),
        overallScore: 8.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      const findings = scorer.scoreToFindings(score);
      expect(findings).toEqual([]);
    });

    it("creates major finding for score < 4", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: [
          { dimension: "completeness" as const, score: 3.0, weight: 0.2, rationale: "Incomplete" },
        ],
        overallScore: 3.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      const findings = scorer.scoreToFindings(score);
      expect(findings.length).toBe(1);
      expect(findings[0]!.severity).toBe("major");
      expect(findings[0]!.section).toBe("completeness");
    });

    it("creates minor finding for score between 4 and 6", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: [
          { dimension: "clarity" as const, score: 5.0, weight: 0.15, rationale: "Average" },
        ],
        overallScore: 5.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      const findings = scorer.scoreToFindings(score);
      expect(findings.length).toBe(1);
      expect(findings[0]!.severity).toBe("minor");
    });

    it("creates findings for multiple low dimensions", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: [
          { dimension: "completeness" as const, score: 2.0, weight: 0.2, rationale: "Very incomplete" },
          { dimension: "clarity" as const, score: 5.5, weight: 0.15, rationale: "Below average" },
          { dimension: "actionability" as const, score: 8.0, weight: 0.25, rationale: "Good" },
        ],
        overallScore: 5.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      const findings = scorer.scoreToFindings(score);
      expect(findings.length).toBe(2);
      expect(findings[0]!.severity).toBe("major"); // completeness < 4
      expect(findings[1]!.severity).toBe("minor"); // clarity < 6
    });

    it("no findings for scores at exactly 6.0", () => {
      const score = {
        taskId: "test",
        skill: "page-cro",
        dimensions: [
          { dimension: "completeness" as const, score: 6.0, weight: 0.2, rationale: "Acceptable" },
        ],
        overallScore: 6.0,
        scoredAt: new Date().toISOString(),
        scoredBy: "structural" as const,
      };

      const findings = scorer.scoreToFindings(score);
      expect(findings).toEqual([]);
    });
  });
});
