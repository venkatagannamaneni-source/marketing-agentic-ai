import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ReviewEngine } from "../review-engine.ts";
import { QualityScorer } from "../quality-scorer.ts";
import { getSkillCriteria } from "../quality-criteria.ts";
import {
  createTestTask,
  createTestOutput,
  createTestConfig,
  createMockClaudeClient,
} from "./helpers.ts";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ReviewEngine.evaluateTaskWithQuality", () => {
  const config = createTestConfig();
  const pageCroCriteria = getSkillCriteria("page-cro");

  describe("without QualityScorer", () => {
    it("falls back to evaluateTaskSemantic and returns placeholder QualityScore", async () => {
      const engine = new ReviewEngine(config);
      const task = createTestTask({ status: "completed" });
      const output = createTestOutput();

      const result = await engine.evaluateTaskWithQuality(
        task,
        output,
        [],
        pageCroCriteria,
      );

      expect(result.decision).toBeDefined();
      expect(result.qualityScore).toBeDefined();
      expect(result.qualityScore.dimensions).toEqual([]);
      expect(result.qualityScore.overallScore).toBe(0);
      expect(result.qualityScore.scoredBy).toBe("structural");
      expect(result.reviewCost).toBe(0);
    });

    it("still produces valid DirectorDecision", async () => {
      const engine = new ReviewEngine(config);
      const task = createTestTask({ status: "completed" });
      const output = createTestOutput();

      const result = await engine.evaluateTaskWithQuality(
        task,
        output,
        [],
        pageCroCriteria,
      );

      expect(result.decision.taskId).toBe(task.id);
      expect(result.decision.action).toBeDefined();
      expect(result.decision.review).toBeDefined();
    });
  });

  describe("with structural QualityScorer (no client)", () => {
    it("returns structural quality score", async () => {
      const qualityScorer = new QualityScorer();
      const engine = new ReviewEngine(config, undefined, qualityScorer);
      const task = createTestTask({ status: "completed" });
      const output = createTestOutput();

      const result = await engine.evaluateTaskWithQuality(
        task,
        output,
        [],
        pageCroCriteria,
      );

      expect(result.qualityScore.scoredBy).toBe("structural");
      expect(result.qualityScore.dimensions.length).toBe(7);
      expect(result.qualityScore.overallScore).toBeGreaterThan(0);
      expect(result.reviewCost).toBe(0);
    });

    it("APPROVE action for good output", async () => {
      const qualityScorer = new QualityScorer();
      const engine = new ReviewEngine(config, undefined, qualityScorer);
      const task = createTestTask({ status: "completed" });
      const output = createTestOutput();

      const result = await engine.evaluateTaskWithQuality(
        task,
        output,
        [],
        pageCroCriteria,
      );

      // Test output has headings, numbered lists, metrics — should score well
      expect(["approve", "goal_complete", "pipeline_next"]).toContain(
        result.decision.action,
      );
    });

    it("includes quality-based findings in review", async () => {
      const qualityScorer = new QualityScorer();
      const engine = new ReviewEngine(config, undefined, qualityScorer);
      const task = createTestTask({ status: "completed" });

      // Poor output — no structure, no data, very short
      const poorOutput = "This is a poor output without any structure or useful content.".repeat(3);

      const result = await engine.evaluateTaskWithQuality(
        task,
        poorOutput,
        [],
        pageCroCriteria,
      );

      // Should produce some findings for low-scoring dimensions
      expect(result.decision.review).toBeDefined();
    });
  });

  describe("with semantic QualityScorer (mock client)", () => {
    it("returns semantic quality score when client is available", async () => {
      const semanticResponse = JSON.stringify({
        completeness: { score: 8, rationale: "Covers all requirements" },
        clarity: { score: 9, rationale: "Well organized with clear headings" },
        actionability: { score: 7, rationale: "Clear recommendations" },
        brand_alignment: { score: 8, rationale: "Professional tone" },
        data_driven: { score: 6, rationale: "Some metrics included" },
        technical_accuracy: { score: 7, rationale: "Accurate" },
        creativity: { score: 5, rationale: "Standard approach" },
      });

      const client = createMockClaudeClient({ content: semanticResponse });
      const qualityScorer = new QualityScorer(client);
      const engine = new ReviewEngine(config, client, qualityScorer);
      const task = createTestTask({ status: "completed" });
      const output = createTestOutput();

      const result = await engine.evaluateTaskWithQuality(
        task,
        output,
        [],
        pageCroCriteria,
      );

      expect(result.qualityScore.scoredBy).toBe("semantic");
      expect(result.qualityScore.dimensions.length).toBe(7);
      expect(result.reviewCost).toBeGreaterThan(0);
    });

    it("respects budget model override", async () => {
      const semanticResponse = JSON.stringify({
        completeness: { score: 7, rationale: "Good" },
        clarity: { score: 7, rationale: "Good" },
        actionability: { score: 7, rationale: "Good" },
        brand_alignment: { score: 7, rationale: "Good" },
        data_driven: { score: 7, rationale: "Good" },
        technical_accuracy: { score: 7, rationale: "Good" },
        creativity: { score: 7, rationale: "Good" },
      });

      const client = createMockClaudeClient({ content: semanticResponse });
      const qualityScorer = new QualityScorer(client);
      const engine = new ReviewEngine(config, client, qualityScorer);
      const task = createTestTask({ status: "completed" });

      await engine.evaluateTaskWithQuality(
        task,
        createTestOutput(),
        [],
        pageCroCriteria,
        {
          totalBudget: 1000,
          spent: 900,
          percentUsed: 90,
          level: "throttle",
          allowedPriorities: ["P0", "P1"],
          modelOverride: "haiku",
        },
      );

      // The quality scorer should have used the budget model override
      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.model).toContain("haiku");
    });
  });

  describe("backward compatibility", () => {
    it("existing evaluateTask still works without QualityScorer", () => {
      const engine = new ReviewEngine(config);
      const task = createTestTask({ status: "completed" });
      const output = createTestOutput();

      const decision = engine.evaluateTask(task, output, []);

      expect(decision.taskId).toBe(task.id);
      expect(decision.action).toBeDefined();
      expect(decision.review).toBeDefined();
    });

    it("existing evaluateTaskSemantic still works without QualityScorer", async () => {
      const engine = new ReviewEngine(config);
      const task = createTestTask({ status: "completed" });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      expect(result.decision.taskId).toBe(task.id);
      expect(result.reviewCost).toBe(0);
    });

    it("constructor with 2 args still works", () => {
      const engine = new ReviewEngine(config, createMockClaudeClient());
      const task = createTestTask({ status: "completed" });
      const output = createTestOutput();

      const decision = engine.evaluateTask(task, output, []);
      expect(decision.taskId).toBe(task.id);
    });
  });

  describe("escalation with quality scoring", () => {
    it("escalates when revision count exceeds max", async () => {
      const qualityScorer = new QualityScorer();
      const engine = new ReviewEngine(config, undefined, qualityScorer);
      const task = createTestTask({
        status: "completed",
        revisionCount: 3, // At maxRevisionsPerTask
      });

      // Poor output to trigger REVISE/REJECT verdict
      const poorOutput = "Short.";

      const result = await engine.evaluateTaskWithQuality(
        task,
        poorOutput,
        [],
        pageCroCriteria,
      );

      expect(result.decision.action).toBe("escalate_human");
      expect(result.decision.escalation).not.toBeNull();
      expect(result.decision.escalation!.reason).toBe("agent_loop_detected");
    });
  });
});
