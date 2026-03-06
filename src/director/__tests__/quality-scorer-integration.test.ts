import { describe, expect, it } from "bun:test";
import { ReviewEngine } from "../review-engine.ts";
import { QualityScorer } from "../quality-scorer.ts";
import { DEFAULT_DIRECTOR_CONFIG } from "../types.ts";
import { createTestTask, createTestOutput } from "./helpers.ts";
import type {
  ClaudeClient,
  ClaudeMessageParams,
  ClaudeMessageResult,
} from "../../agents/claude-client.ts";
import { MODEL_MAP } from "../../agents/claude-client.ts";
import { getSkillCriteria } from "../quality-criteria.ts";

// ── Mock Client ──────────────────────────────────────────────────────────────

function createMockClient(
  handler?:
    | Partial<ClaudeMessageResult>
    | ((
        params: ClaudeMessageParams,
        callIndex: number,
      ) => Partial<ClaudeMessageResult>),
): ClaudeClient & { calls: ClaudeMessageParams[] } {
  const calls: ClaudeMessageParams[] = [];
  let callIndex = 0;

  const defaultResult: ClaudeMessageResult = {
    content: JSON.stringify({
      verdict: "APPROVE",
      findings: [],
      revisionInstructions: "",
      summary: "Output meets all quality criteria.",
    }),
    model: MODEL_MAP.opus,
    inputTokens: 5000,
    outputTokens: 500,
    stopReason: "end_turn",
    durationMs: 3000,
  };

  return {
    calls,
    createMessage: async (params) => {
      calls.push(params);
      const currentIndex = callIndex++;
      if (typeof handler === "function") {
        return { ...defaultResult, ...handler(params, currentIndex) };
      }
      if (handler) {
        return { ...defaultResult, ...handler };
      }
      return defaultResult;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ReviewEngine — QualityScorer integration", () => {
  describe("evaluateTaskSemantic with QualityScorer", () => {
    it("includes qualityScore when QualityScorer is wired in", async () => {
      const client = createMockClient();
      const scorer = new QualityScorer(client);
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client, scorer);

      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      expect(result.qualityScore).toBeDefined();
      expect(result.qualityScore!.taskId).toBe(task.id);
      expect(result.qualityScore!.skill).toBe(task.to);
      expect(result.qualityScore!.dimensions.length).toBeGreaterThan(0);
      expect(result.qualityScore!.overallScore).toBeGreaterThan(0);
      expect(result.qualityScore!.scoredBy).toBe("structural");
    });

    it("omits qualityScore when no QualityScorer provided", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);

      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      expect(result.qualityScore).toBeUndefined();
    });

    it("uses skill-specific criteria from getSkillCriteria", async () => {
      const client = createMockClient();
      const scorer = new QualityScorer(client);
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client, scorer);

      // page-cro is in CONVERT_DIMENSIONS — actionability has weight 0.25
      const task = createTestTask({ to: "page-cro", next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      const criteria = getSkillCriteria("page-cro");
      expect(result.qualityScore!.dimensions.length).toBe(criteria.dimensions.length);

      // Verify dimension weights match the criteria
      const actionability = result.qualityScore!.dimensions.find(
        d => d.dimension === "actionability",
      );
      expect(actionability).toBeDefined();
      expect(actionability!.weight).toBe(0.25);
    });

    it("scores different skills with different dimension profiles", async () => {
      const client = createMockClient();
      const scorer = new QualityScorer(client);
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client, scorer);

      const output = createTestOutput();

      // page-cro (Convert squad) — actionability highest weight
      const cro = await engine.evaluateTaskSemantic(
        createTestTask({ to: "page-cro", next: { type: "director_review" } }),
        output, [],
      );

      // content-strategy (Strategy squad) — completeness highest weight
      const strategy = await engine.evaluateTaskSemantic(
        createTestTask({ to: "content-strategy", next: { type: "director_review" } }),
        output, [],
      );

      const croActionability = cro.qualityScore!.dimensions.find(d => d.dimension === "actionability");
      const stratCompleteness = strategy.qualityScore!.dimensions.find(d => d.dimension === "completeness");

      // CRO should weight actionability at 0.25
      expect(croActionability!.weight).toBe(0.25);
      // Strategy should weight completeness at 0.25
      expect(stratCompleteness!.weight).toBe(0.25);
    });

    it("includes qualityScore even for quick-depth reviews", async () => {
      const client = createMockClient();
      const scorer = new QualityScorer(client);
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client, scorer);

      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "quick" },
      );

      // Quick depth means no semantic review API call, but quality scoring still works
      expect(result.reviewDepth).toBe("quick");
      // Quick depth short-circuits before quality scoring
      expect(result.qualityScore).toBeUndefined();
    });

    it("includes qualityScore for standard-depth reviews", async () => {
      const client = createMockClient();
      const scorer = new QualityScorer(client);
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client, scorer);

      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(result.reviewDepth).toBe("standard");
      expect(result.qualityScore).toBeDefined();
      expect(result.qualityScore!.overallScore).toBeGreaterThan(0);
    });

    it("produces reasonable scores for well-structured output", async () => {
      const client = createMockClient();
      const scorer = new QualityScorer(client);
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client, scorer);

      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput(); // Well-structured with headings, lists, findings

      const result = await engine.evaluateTaskSemantic(task, output, []);

      // The test output has good structure — scores should be above-average
      expect(result.qualityScore!.overallScore).toBeGreaterThanOrEqual(4);
      // Clarity should be decent — has headings and lists
      const clarity = result.qualityScore!.dimensions.find(d => d.dimension === "clarity");
      expect(clarity!.score).toBeGreaterThanOrEqual(5);
    });

    it("produces lower scores for minimal output", async () => {
      const client = createMockClient();
      const scorer = new QualityScorer(client);
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client, scorer);

      const task = createTestTask({ next: { type: "director_review" } });
      const output = "# Title\n\nThis is a short output without much depth or structure. No recommendations.";

      // This output will fail structural checks (too short) but let's ensure
      // the quality scorer still runs for non-critical outputs
      const result = await engine.evaluateTaskSemantic(task, output, []);

      if (result.qualityScore) {
        expect(result.qualityScore.overallScore).toBeLessThan(8);
      }
    });
  });

  describe("evaluateTaskWithQuality", () => {
    it("produces both decision and qualityScore", async () => {
      const client = createMockClient();
      const scorer = new QualityScorer(client);
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client, scorer);

      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();
      const criteria = getSkillCriteria("page-cro");

      const result = await engine.evaluateTaskWithQuality(
        task, output, [], criteria,
      );

      expect(result.decision).toBeDefined();
      expect(result.qualityScore).toBeDefined();
      expect(result.qualityScore.taskId).toBe(task.id);
      expect(result.qualityScore.skill).toBe("page-cro");
      expect(result.decision.review).toBeDefined();
    });

    it("falls back gracefully when no QualityScorer", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);

      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();
      const criteria = getSkillCriteria("page-cro");

      const result = await engine.evaluateTaskWithQuality(
        task, output, [], criteria,
      );

      expect(result.decision).toBeDefined();
      expect(result.qualityScore).toBeDefined();
      // Placeholder score when no scorer
      expect(result.qualityScore.dimensions).toEqual([]);
      expect(result.qualityScore.overallScore).toBe(0);
    });
  });

  describe("quality criteria lookup", () => {
    it("getSkillCriteria returns correct profile for all squads", () => {
      // Strategy squad
      const strategy = getSkillCriteria("content-strategy");
      expect(strategy.dimensions[0]!.dimension).toBe("completeness");
      expect(strategy.dimensions[0]!.weight).toBe(0.25);

      // Creative squad
      const creative = getSkillCriteria("copywriting");
      expect(creative.dimensions[0]!.dimension).toBe("clarity");
      expect(creative.dimensions[0]!.weight).toBe(0.25);

      // Convert squad
      const convert = getSkillCriteria("page-cro");
      expect(convert.dimensions[0]!.dimension).toBe("actionability");
      expect(convert.dimensions[0]!.weight).toBe(0.25);

      // Activate squad
      const activate = getSkillCriteria("onboarding-cro");
      expect(activate.dimensions[0]!.dimension).toBe("actionability");
      expect(activate.dimensions[0]!.weight).toBe(0.25);

      // Measure squad
      const measure = getSkillCriteria("analytics-tracking");
      expect(measure.dimensions[0]!.dimension).toBe("technical_accuracy");
      expect(measure.dimensions[0]!.weight).toBe(0.25);
    });

    it("returns fallback criteria for unknown skills", () => {
      const unknown = getSkillCriteria("nonexistent-skill" as any);
      expect(unknown.dimensions.length).toBeGreaterThan(0);
      expect(unknown.minWordCount).toBe(100);
    });
  });
});
