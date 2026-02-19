import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { MarketingDirector } from "../director.ts";
import type { ExecutorConfig } from "../../agents/executor.ts";
import { MODEL_MAP } from "../../agents/claude-client.ts";
import {
  createTestWorkspace,
  createTestTask,
  createTestOutput,
  createMockClaudeClient,
  type TestWorkspace,
} from "./helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

function createTestExecutorConfig(
  overrides: Partial<ExecutorConfig> = {},
): ExecutorConfig {
  return {
    projectRoot: PROJECT_ROOT,
    defaultModel: "sonnet",
    defaultTimeoutMs: 120_000,
    defaultMaxTokens: 8192,
    maxRetries: 3,
    maxContextTokens: 150_000,
    ...overrides,
  };
}

let tw: TestWorkspace;

beforeEach(async () => {
  tw = await createTestWorkspace();
});

afterEach(async () => {
  await tw.cleanup();
});

describe("MarketingDirector — executeAndReviewTask", () => {
  it("throws when no ClaudeClient is provided", async () => {
    const director = new MarketingDirector(tw.workspace);
    const task = createTestTask({ status: "pending" });
    await tw.workspace.writeTask(task);

    try {
      await director.executeAndReviewTask(task.id);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("ClaudeClient required");
    }
  });

  it("throws when no ExecutorConfig is provided", async () => {
    const client = createMockClaudeClient();
    const director = new MarketingDirector(
      tw.workspace,
      undefined,
      client,
    );
    const task = createTestTask({ status: "pending" });
    await tw.workspace.writeTask(task);

    try {
      await director.executeAndReviewTask(task.id);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("ExecutorConfig required");
    }
  });

  it("executes task and reviews output end-to-end", async () => {
    // Mock: executor call returns good output, semantic review returns no findings
    const client = createMockClaudeClient((_params, callIndex) => {
      if (callIndex === 0) {
        // Executor call
        return {
          content: createTestOutput(),
          model: MODEL_MAP.sonnet,
          inputTokens: 2000,
          outputTokens: 1000,
        };
      }
      // Semantic review call (Opus)
      return {
        content: "[]",
        model: MODEL_MAP.opus,
        inputTokens: 5000,
        outputTokens: 200,
      };
    });

    const director = new MarketingDirector(
      tw.workspace,
      undefined,
      client,
      createTestExecutorConfig(),
    );

    const task = createTestTask({ status: "pending" });
    await tw.workspace.writeTask(task);

    const result = await director.executeAndReviewTask(task.id);

    // Execution
    expect(result.execution.taskId).toBe(task.id);
    expect(result.execution.content).toContain("Page CRO Audit");

    // Decision
    expect(result.decision.review!.verdict).toBe("APPROVE");

    // Total cost = execution cost + review cost
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.totalCost).toBeGreaterThan(
      result.execution.metadata.estimatedCost,
    );
  });

  it("tracks totalCost = execution cost + review cost (EC-4)", async () => {
    const client = createMockClaudeClient((_params, callIndex) => {
      if (callIndex === 0) {
        return {
          content: createTestOutput(),
          model: MODEL_MAP.sonnet,
          inputTokens: 10000,
          outputTokens: 5000,
        };
      }
      return {
        content: "[]",
        model: MODEL_MAP.opus,
        inputTokens: 8000,
        outputTokens: 300,
      };
    });

    const director = new MarketingDirector(
      tw.workspace,
      undefined,
      client,
      createTestExecutorConfig(),
    );

    const task = createTestTask({ status: "pending" });
    await tw.workspace.writeTask(task);

    const result = await director.executeAndReviewTask(task.id);

    // Execution cost: sonnet (10000*3 + 5000*15) / 1M = 0.105
    const executionCost = result.execution.metadata.estimatedCost;
    expect(executionCost).toBeCloseTo(0.105, 4);

    // Review cost: opus (8000*15 + 300*75) / 1M = 0.1425
    const reviewCost = result.totalCost - executionCost;
    expect(reviewCost).toBeCloseTo(0.1425, 4);

    // Total = 0.105 + 0.1425 = 0.2475
    expect(result.totalCost).toBeCloseTo(0.2475, 4);
  });

  it("applies decision side effects (status, review, learning)", async () => {
    const client = createMockClaudeClient((_params, callIndex) => {
      if (callIndex === 0) {
        return { content: createTestOutput() };
      }
      return { content: "[]" };
    });

    const director = new MarketingDirector(
      tw.workspace,
      undefined,
      client,
      createTestExecutorConfig(),
    );

    const task = createTestTask({
      status: "pending",
      next: { type: "director_review" },
    });
    await tw.workspace.writeTask(task);

    await director.executeAndReviewTask(task.id);

    // Review should be written
    const reviews = await tw.workspace.listReviews(task.id);
    expect(reviews.length).toBe(1);

    // Learning should be appended
    const learnings = await tw.workspace.readLearnings();
    expect(learnings.length).toBeGreaterThan(0);
  });

  it("blocks task execution when budget is insufficient", async () => {
    const client = createMockClaudeClient();
    const director = new MarketingDirector(
      tw.workspace,
      undefined,
      client,
      createTestExecutorConfig(),
    );

    const task = createTestTask({ status: "pending", priority: "P3" });
    await tw.workspace.writeTask(task);

    // Budget at throttle level only allows P0, P1
    const budgetState = {
      totalBudget: 1000,
      spent: 900,
      percentUsed: 90,
      level: "throttle" as const,
      allowedPriorities: ["P0" as const, "P1" as const],
      modelOverride: null,
    };

    try {
      await director.executeAndReviewTask(task.id, budgetState);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("blocked by budget");
    }
  });
});

describe("MarketingDirector — applyDecision refactor", () => {
  it("reviewCompletedTask still works correctly after refactor", async () => {
    const director = new MarketingDirector(tw.workspace);

    const task = createTestTask({
      to: "page-cro",
      status: "completed",
      next: { type: "director_review" },
    });
    await tw.workspace.writeTask(task);
    await tw.workspace.writeOutput(
      "convert",
      "page-cro",
      task.id,
      createTestOutput(),
    );

    const decision = await director.reviewCompletedTask(task.id);

    // Same behavior as before refactor
    expect(decision.action).toBe("goal_complete");
    expect(decision.review!.verdict).toBe("APPROVE");

    // Side effects applied
    const updatedTask = await tw.workspace.readTask(task.id);
    expect(updatedTask.status).toBe("approved");

    const reviews = await tw.workspace.listReviews(task.id);
    expect(reviews.length).toBe(1);
  });
});
