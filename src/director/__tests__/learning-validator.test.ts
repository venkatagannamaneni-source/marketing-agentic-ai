import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { LearningValidator } from "../learning-validator.ts";
import type { LearningValidationResult } from "../learning-validator.ts";
import type { Task } from "../../types/task.ts";
import type { ExecutionResult, ExecutorConfig } from "../../agents/executor.ts";
import { AgentExecutor } from "../../agents/executor.ts";
import { NULL_LOGGER } from "../../observability/logger.ts";
import {
  createTestTask,
  createTestWorkspace,
  createMockClaudeClient,
  type TestWorkspace,
} from "./helpers.ts";

// ── Test Content Fixtures ──────────────────────────────────────────────────

const WELL_STRUCTURED_CONTENT = `# Content Strategy Report

## Executive Summary

This comprehensive analysis covers Q2 marketing initiatives with a 15% projected ROI increase.
Our CTR improved 3.2x compared to Q1, with a CPA reduction of $12.50 per acquisition.

## Market Analysis

### Competitor Landscape

- Competitor A holds 35% market share with $2.5M ARR
- Competitor B recently launched a free tier, capturing 12% of new signups
- Our MRR grew 8% month-over-month in February

### Target Audience Segmentation

We identified three key segments:

1. Enterprise buyers (40% of revenue, $150+ LTV)
2. SMB self-serve (45% of volume, $35 LTV)
3. Developer evangelists (15% of volume, high referral rate at 2.3x)

## Recommendations

1. Implement account-based marketing for enterprise segment
2. Create a freemium onboarding flow targeting 25% conversion to paid
3. Launch a developer advocacy program with 10% referral bonus
4. Optimize paid ads with target CPA of $8.50

## Expected Impact

- Q2 revenue target: $450K MRR (up from $380K)
- Conversion rate target: 4.2% (up from 3.1%)
- CAC payback period: reduce from 14 months to 11 months
`;

const SHORT_GENERIC_CONTENT = `# Tips

Some general best practices for marketing:

- Use best practices
- Follow industry standards
- For example, do good things
- In general, be creative
- Such as writing content, generally speaking
`;

const EMPTY_CONTENT = "";

const SPECIFIC_CONTENT = `# Q2 Pricing Strategy

## Price Point Analysis

Current pricing at $29/mo yields 3.1% conversion with $87 CPA.
Proposed tier at $19/mo projects 4.8% conversion and $52 CPA.
Enterprise at $299/mo has 0.8% conversion but $2,400 LTV.

### Revenue Model

| Tier | Price | Conv% | MRR Impact |
|------|-------|-------|------------|
| Starter | $19 | 4.8% | +$45K |
| Pro | $29 | 3.1% | $0 (baseline) |
| Enterprise | $299 | 0.8% | +$120K |

ROI on pricing change: 2.4x within Q3.
ARR projection: $5.2M by EOY.
`;

// ── Mock Executor Factory ──────────────────────────────────────────────────

function createMockExecutor(
  responseFn: (task: Task) => ExecutionResult,
): AgentExecutor {
  // Create a proxy that intercepts execute calls
  return {
    execute: async (task: Task) => responseFn(task),
    executeOrThrow: async (task: Task) => responseFn(task),
  } as unknown as AgentExecutor;
}

function makeExecutionResult(
  task: Task,
  content: string,
  cost: number = 0.01,
): ExecutionResult {
  return {
    taskId: task.id,
    skill: task.to,
    status: "completed" as const,
    content,
    outputPath: `outputs/convert/${task.to}/${task.id}.md`,
    metadata: {
      model: "claude-3-5-sonnet-20241022",
      modelTier: "sonnet" as const,
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 2500,
      estimatedCost: cost,
      retryCount: 0,
    },
    truncated: false,
    missingInputs: [],
    warnings: [],
  };
}

function makeFailedResult(task: Task): ExecutionResult {
  return {
    taskId: task.id,
    skill: task.to,
    status: "failed" as const,
    content: "",
    outputPath: null,
    metadata: {
      model: "",
      modelTier: "sonnet" as const,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 100,
      estimatedCost: 0,
      retryCount: 0,
    },
    truncated: false,
    missingInputs: [],
    warnings: [],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("LearningValidator", () => {
  let testWs: TestWorkspace;

  beforeEach(async () => {
    testWs = await createTestWorkspace();
  });

  afterEach(async () => {
    await testWs.cleanup();
  });

  // ── structuralQualityScore ──────────────────────────────────────────────

  describe("structuralQualityScore", () => {
    it("scores long, well-structured content higher", () => {
      const executor = createMockExecutor(() => {
        throw new Error("should not be called");
      });
      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const score = validator.structuralQualityScore(WELL_STRUCTURED_CONTENT);
      // Well-structured: 500+ words (3), 4+ headings (2), deep headings (1),
      // has lists (1), specific indicators (3) = 10
      expect(score).toBeGreaterThanOrEqual(7);
    });

    it("scores short, generic content lower", () => {
      const executor = createMockExecutor(() => {
        throw new Error("should not be called");
      });
      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const score = validator.structuralQualityScore(SHORT_GENERIC_CONTENT);
      // Short: <50 words (0), 1 heading (0), no deep headings (0),
      // has bullets (1), many generic phrases (0) = 1
      expect(score).toBeLessThanOrEqual(3);
    });

    it("scores empty content as 0", () => {
      const executor = createMockExecutor(() => {
        throw new Error("should not be called");
      });
      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      expect(validator.structuralQualityScore(EMPTY_CONTENT)).toBe(0);
      expect(validator.structuralQualityScore("   ")).toBe(0);
      expect(validator.structuralQualityScore("\n\n")).toBe(0);
    });

    it("rewards specificity over generic advice", () => {
      const executor = createMockExecutor(() => {
        throw new Error("should not be called");
      });
      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const specificScore = validator.structuralQualityScore(SPECIFIC_CONTENT);
      const genericScore = validator.structuralQualityScore(SHORT_GENERIC_CONTENT);

      expect(specificScore).toBeGreaterThan(genericScore);
      // Specific content has numbers, percentages, metrics
      expect(specificScore).toBeGreaterThanOrEqual(5);
    });
  });

  // ── validateLearningImpact ──────────────────────────────────────────────

  describe("validateLearningImpact", () => {
    it("returns positive delta when learnings improve output", async () => {
      const task = createTestTask({
        status: "pending",
        inputs: [
          { path: "context/product-marketing-context.md", description: "Product context" },
          { path: "memory/learnings.md", description: "Past learnings" },
        ],
      });

      // Mock: with learnings (has memory/ input) returns better content
      const executor = createMockExecutor((t: Task) => {
        const hasLearnings = t.inputs.some(
          (i) => i.path.includes("learnings") || i.path.includes("memory/"),
        );
        if (hasLearnings) {
          return makeExecutionResult(t, WELL_STRUCTURED_CONTENT, 0.02);
        }
        return makeExecutionResult(t, SHORT_GENERIC_CONTENT, 0.01);
      });

      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const result = await validator.validateLearningImpact(
        task,
        "Focus on data-driven recommendations with specific metrics.",
      );

      expect(result.taskId).toBe(task.id);
      expect(result.skill).toBe(task.to);
      expect(result.scoreDelta).toBeGreaterThan(0);
      expect(result.withLearnings.score).toBeGreaterThan(result.withoutLearnings.score);
      expect(result.withLearnings.outputLength).toBeGreaterThan(0);
      expect(result.withoutLearnings.outputLength).toBeGreaterThan(0);
      expect(result.learningsUsed).toBe("Focus on data-driven recommendations with specific metrics.");
      expect(result.validatedAt).toBeTruthy();
    });

    it("returns negative delta when learnings hurt output", async () => {
      const task = createTestTask({
        status: "pending",
        inputs: [
          { path: "context/product-marketing-context.md", description: "Product context" },
          { path: "memory/learnings.md", description: "Past learnings" },
        ],
      });

      // Mock: with learnings returns worse content
      const executor = createMockExecutor((t: Task) => {
        const hasLearnings = t.inputs.some(
          (i) => i.path.includes("learnings") || i.path.includes("memory/"),
        );
        if (hasLearnings) {
          return makeExecutionResult(t, SHORT_GENERIC_CONTENT, 0.02);
        }
        return makeExecutionResult(t, WELL_STRUCTURED_CONTENT, 0.01);
      });

      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const result = await validator.validateLearningImpact(task, "Bad learnings");

      expect(result.scoreDelta).toBeLessThan(0);
      expect(result.withLearnings.score).toBeLessThan(result.withoutLearnings.score);
    });

    it("handles executor failure gracefully", async () => {
      const task = createTestTask({
        status: "pending",
        inputs: [
          { path: "context/product-marketing-context.md", description: "Product context" },
          { path: "memory/learnings.md", description: "Past learnings" },
        ],
      });

      // Mock: executor always fails
      const executor = createMockExecutor((t: Task) => {
        return makeFailedResult(t);
      });

      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const result = await validator.validateLearningImpact(task, "Some learnings");

      // Both scored as 0 since both failed
      expect(result.withLearnings.score).toBe(0);
      expect(result.withoutLearnings.score).toBe(0);
      expect(result.scoreDelta).toBe(0);
      expect(result.withLearnings.outputLength).toBe(0);
      expect(result.withoutLearnings.outputLength).toBe(0);
    });
  });

  // ── analyzeLearningEffectiveness ────────────────────────────────────────

  describe("analyzeLearningEffectiveness", () => {
    function makeResult(
      skill: string,
      delta: number,
      taskId?: string,
    ): LearningValidationResult {
      return {
        taskId: taskId ?? `${skill}-20260219-abc123`,
        skill,
        withLearnings: {
          score: 7 + delta,
          outputLength: 1000,
          executionCost: 0.02,
        },
        withoutLearnings: {
          score: 7,
          outputLength: 800,
          executionCost: 0.01,
        },
        scoreDelta: delta,
        learningsUsed: "test learnings",
        validatedAt: "2026-02-19T00:00:00.000Z",
      };
    }

    it("correctly aggregates multiple results", () => {
      const executor = createMockExecutor(() => {
        throw new Error("should not be called");
      });
      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const results: LearningValidationResult[] = [
        makeResult("page-cro", 2.0),
        makeResult("copywriting", 1.0),
        makeResult("seo-audit", -0.5),
        makeResult("email-sequence", 0.3), // neutral (< 0.5)
      ];

      const report = validator.analyzeLearningEffectiveness(results);

      expect(report.totalTests).toBe(4);
      expect(report.averageLift).toBe(0.7); // (2.0 + 1.0 + -0.5 + 0.3) / 4 = 0.7
      expect(report.positiveImpactCount).toBe(2); // page-cro, copywriting
      expect(report.negativeImpactCount).toBe(1); // seo-audit
      expect(report.neutralImpactCount).toBe(1); // email-sequence
      expect(report.topPerformingSkills).toContain("page-cro");
      expect(report.topPerformingSkills).toContain("copywriting");
    });

    it("identifies skills for pruning", () => {
      const executor = createMockExecutor(() => {
        throw new Error("should not be called");
      });
      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const results: LearningValidationResult[] = [
        makeResult("page-cro", 2.0),
        makeResult("seo-audit", -1.5),
        makeResult("cold-email", -0.8),
        makeResult("copywriting", 0.2), // neutral
      ];

      const report = validator.analyzeLearningEffectiveness(results);

      expect(report.recommendPruning).toContain("seo-audit");
      expect(report.recommendPruning).toContain("cold-email");
      expect(report.recommendPruning).not.toContain("page-cro");
      expect(report.recommendPruning).not.toContain("copywriting");

      // Pruning list sorted by worst first
      expect(report.recommendPruning[0]).toBe("seo-audit");
      expect(report.recommendPruning[1]).toBe("cold-email");
    });

    it("handles empty results array", () => {
      const executor = createMockExecutor(() => {
        throw new Error("should not be called");
      });
      const validator = new LearningValidator(
        executor,
        testWs.workspace,
        undefined,
        NULL_LOGGER,
      );

      const report = validator.analyzeLearningEffectiveness([]);

      expect(report.totalTests).toBe(0);
      expect(report.averageLift).toBe(0);
      expect(report.positiveImpactCount).toBe(0);
      expect(report.negativeImpactCount).toBe(0);
      expect(report.neutralImpactCount).toBe(0);
      expect(report.topPerformingSkills).toEqual([]);
      expect(report.recommendPruning).toEqual([]);
    });
  });
});
