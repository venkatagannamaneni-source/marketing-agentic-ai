/**
 * E2E: Real Claude API Integration Tests
 *
 * These tests make REAL Claude API calls using the key from .env.
 * They verify the full stack works end-to-end: client → executor → workspace.
 *
 * Cost control: All tests use claude-haiku to minimize spend (~$0.01 total).
 * Skipped automatically if ANTHROPIC_API_KEY is not set.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";

// ── Claude Client + Executor ─────────────────────────────────────────────────
import { AnthropicClaudeClient } from "../../agents/claude-client.ts";
import { MODEL_MAP } from "../../agents/claude-client.ts";
import { AgentExecutor } from "../../agents/executor.ts";
import type { ExecutorConfig } from "../../agents/executor.ts";

// ── Workspace ───────────────────────────────────────────────────────────────
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";

// ── Director + Pipeline ─────────────────────────────────────────────────────
import { MarketingDirector } from "../../director/director.ts";
import { PipelineFactory } from "../../director/pipeline-factory.ts";
import { SequentialPipelineEngine } from "../../pipeline/pipeline-engine.ts";
import { PIPELINE_TEMPLATES } from "../../agents/registry.ts";
import { SKILL_SQUAD_MAP } from "../../types/agent.ts";

// ── Types ───────────────────────────────────────────────────────────────────
import type { Task } from "../../types/task.ts";
import type { BudgetState } from "../../director/types.ts";

// ── Constants ───────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");
const API_KEY = process.env.ANTHROPIC_API_KEY;
const HAS_API_KEY = Boolean(API_KEY);

// Use haiku for all tests to minimize cost
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const PRODUCT_CONTEXT = `# Product Marketing Context

## Product
MarketFlow — An AI-powered marketing automation platform for B2B SaaS teams.

## Audience
Marketing teams at B2B SaaS companies (50-500 employees).

## Positioning
The only marketing platform that uses AI agents to run your entire marketing operation 24/7.

## Voice
Professional, data-driven, confident. Avoid jargon and buzzwords.

## Goals
- Increase signup conversion rate by 20%
- Grow organic traffic by 50%
- Reduce churn by 15%

## Competitors
- HubSpot Marketing Hub
- Marketo Engage
- Mailchimp
`;

// Budget state that forces haiku model for all skills
const HAIKU_BUDGET: BudgetState = {
  totalBudget: 1000,
  spent: 0,
  percentUsed: 0,
  level: "normal",
  allowedPriorities: ["P0", "P1", "P2", "P3"],
  modelOverride: "haiku",
};

// ── Test Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!HAS_API_KEY)("E2E: Real Claude API", () => {
  // ── Test 1: Raw Modern Client ───────────────────────────────────────────

  describe("Modern AnthropicClaudeClient (agents/)", () => {
    it("makes a real API call and returns structured result", async () => {
      const client = new AnthropicClaudeClient(
        new Anthropic({ apiKey: API_KEY }),
      );

      const result = await client.createMessage({
        model: HAIKU_MODEL,
        system: "You are a helpful assistant. Be very concise.",
        messages: [
          {
            role: "user",
            content: "What is 2+2? Reply with just the number.",
          },
        ],
        maxTokens: 50,
        timeoutMs: 30_000,
      });

      console.log("[Modern Client] Response:", result.content);
      console.log(
        `[Modern Client] Tokens: ${result.inputTokens} in / ${result.outputTokens} out`,
      );
      console.log(`[Modern Client] Duration: ${result.durationMs}ms`);
      console.log(`[Modern Client] Stop reason: ${result.stopReason}`);

      expect(result.content).toBeTruthy();
      expect(result.content).toContain("4");
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.stopReason).toBe("end_turn");
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.model).toContain("claude");
    }, 30_000);
  });

  // ── Test 2: AgentExecutor with Real Skill ──────────────────────────────

  describe("AgentExecutor with real Claude", () => {
    let workspace: FileSystemWorkspaceManager;
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "real-api-test-"));
      workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
      await workspace.init();
      await workspace.writeFile(
        "context/product-marketing-context.md",
        PRODUCT_CONTEXT,
      );
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("executes a real marketing-ideas task through the full executor", async () => {
      const client = new AnthropicClaudeClient(
        new Anthropic({ apiKey: API_KEY }),
      );

      const config: ExecutorConfig = {
        projectRoot: PROJECT_ROOT,
        defaultModel: "haiku",
        defaultTimeoutMs: 60_000,
        defaultMaxTokens: 2048,
        maxRetries: 0,
        maxContextTokens: 150_000,
      };

      const executor = new AgentExecutor(client, workspace, config);

      // Create a real task for the marketing-ideas skill
      const task: Task = {
        id: "real-api-test-001",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        from: "director",
        to: "marketing-ideas",
        priority: "P2",
        deadline: null,
        status: "pending",
        revisionCount: 0,
        goalId: "test-goal-001",
        pipelineId: null,
        goal: "Generate 3 marketing ideas for a B2B SaaS marketing automation tool",
        inputs: [],
        requirements:
          "Generate exactly 3 creative marketing ideas for MarketFlow, a B2B SaaS marketing automation platform. For each idea provide: a title, a one-sentence description, and estimated effort (low/medium/high). Keep the total response under 500 words.",
        output: {
          path: "outputs/strategy/marketing-ideas/real-api-test-001.md",
          format: "markdown",
        },
        next: { type: "complete" },
        tags: ["real-api-test"],
        metadata: {},
      };

      // Persist task so the executor can update its status
      await workspace.writeTask(task);

      // Execute with haiku budget override
      const result = await executor.execute(task, { budgetState: HAIKU_BUDGET });

      console.log("\n[Executor] Real marketing-ideas output:");
      console.log("─".repeat(60));
      console.log(result.content.slice(0, 800));
      if (result.content.length > 800) console.log("... (truncated for display)");
      console.log("─".repeat(60));
      console.log(`[Executor] Model: ${result.metadata.model} (${result.metadata.modelTier})`);
      console.log(
        `[Executor] Tokens: ${result.metadata.inputTokens} in / ${result.metadata.outputTokens} out`,
      );
      console.log(`[Executor] Duration: ${result.metadata.durationMs}ms`);
      console.log(`[Executor] Estimated cost: $${result.metadata.estimatedCost.toFixed(6)}`);
      console.log(`[Executor] Truncated: ${result.truncated}`);
      console.log(`[Executor] Missing inputs: ${result.missingInputs.length}`);
      console.log(`[Executor] Warnings: ${result.warnings.length}`);

      // Verify result
      expect(result.taskId).toBe("real-api-test-001");
      expect(result.content.length).toBeGreaterThan(100);
      expect(result.truncated).toBe(false);
      expect(result.metadata.inputTokens).toBeGreaterThan(0);
      expect(result.metadata.outputTokens).toBeGreaterThan(0);
      expect(result.metadata.durationMs).toBeGreaterThan(0);
      expect(result.metadata.estimatedCost).toBeGreaterThan(0);

      // Verify output was written to workspace
      const output = await workspace.readOutput(
        "strategy",
        "marketing-ideas",
        "real-api-test-001",
      );
      expect(output.length).toBeGreaterThan(100);
      expect(output).toBe(result.content);

      // Verify task status was updated to completed
      const updatedTask = await workspace.readTask("real-api-test-001");
      expect(updatedTask.status).toBe("completed");
    }, 60_000);
  });

  // ── Test 3: Full Pipeline with Real API ───────────────────────────────

  describe("Full pipeline: Goal → Director → Pipeline → Real Claude", () => {
    let workspace: FileSystemWorkspaceManager;
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "real-api-pipeline-"));
      workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
      await workspace.init();
      await workspace.writeFile(
        "context/product-marketing-context.md",
        PRODUCT_CONTEXT,
      );
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("runs a full content pipeline with real Claude API calls", async () => {
      // 1. Create real Claude client
      const modernClient = new AnthropicClaudeClient(
        new Anthropic({ apiKey: API_KEY }),
      );

      // 2. Set up Director with real client (for reviews)
      const directorExecutorConfig: ExecutorConfig = {
        projectRoot: PROJECT_ROOT,
        defaultModel: "haiku",
        defaultTimeoutMs: 60_000,
        defaultMaxTokens: 2048,
        maxRetries: 0,
        maxContextTokens: 150_000,
      };

      const director = new MarketingDirector(
        workspace,
        undefined,
        modernClient,
        directorExecutorConfig,
      );

      // 3. Set up Pipeline with unified AgentExecutor
      const pipelineConfig: ExecutorConfig = {
        projectRoot: PROJECT_ROOT,
        defaultModel: "haiku",
        defaultTimeoutMs: 60_000,
        defaultMaxTokens: 2048,
        maxRetries: 0,
        maxContextTokens: 150_000,
      };

      const pipelineExecutor = new AgentExecutor(
        modernClient,
        workspace,
        pipelineConfig,
      );

      const pipelineFactory = new PipelineFactory(PIPELINE_TEMPLATES);
      const pipelineEngine = new SequentialPipelineEngine(
        pipelineFactory,
        pipelineExecutor,
        workspace,
      );

      // 4. Director creates and decomposes a goal
      const goal = await director.createGoal(
        "Create a blog content strategy for MarketFlow",
        "content",
        "P2",
      );

      console.log(`\n[Pipeline] Goal created: ${goal.id}`);
      console.log(`[Pipeline] Description: ${goal.description}`);

      const plan = director.decomposeGoal(goal);
      console.log(`[Pipeline] Plan: ${plan.phases.length} phases, ~${plan.estimatedTaskCount} tasks`);
      console.log(`[Pipeline] Template: ${plan.pipelineTemplateName}`);

      await director.planGoalTasks(plan, goal);

      // 5. Build and execute the pipeline with REAL Claude calls
      const definition = pipelineFactory.goalPlanToDefinition(plan, goal);
      const run = pipelineFactory.createRun(definition, goal.id);

      console.log(`[Pipeline] Executing ${definition.steps.length} steps...`);

      const startTime = Date.now();
      const pipelineResult = await pipelineEngine.execute(
        definition,
        run,
        {
          goalDescription: goal.description,
          priority: goal.priority,
        },
      );
      const totalDurationMs = Date.now() - startTime;

      console.log(`\n[Pipeline] Completed in ${totalDurationMs}ms`);
      console.log(`[Pipeline] Status: ${pipelineResult.status}`);
      console.log(`[Pipeline] Steps completed: ${pipelineResult.stepResults.length}`);
      console.log(
        `[Pipeline] Total tokens: ${pipelineResult.totalTokensUsed.input} in / ${pipelineResult.totalTokensUsed.output} out`,
      );

      // Log each step result
      for (const stepResult of pipelineResult.stepResults) {
        const statusIcon = stepResult.status === "completed" ? "OK" : "FAIL";
        const skill = stepResult.step.type === "sequential"
          ? stepResult.step.skill
          : stepResult.step.type === "parallel"
            ? stepResult.step.skills.join(", ")
            : "review";
        const tokens = stepResult.executionResults.reduce(
          (sum, r) => sum + r.metadata.inputTokens + r.metadata.outputTokens,
          0,
        );
        console.log(
          `  [${statusIcon}] ${skill} — ${tokens} tokens, ${stepResult.durationMs}ms`,
        );
      }

      // 6. Verify pipeline completed
      expect(pipelineResult.status).toBe("completed");
      expect(pipelineResult.stepResults.length).toBe(definition.steps.length);

      for (const stepResult of pipelineResult.stepResults) {
        expect(stepResult.status).toBe("completed");
        const tokens = stepResult.executionResults.reduce(
          (sum, r) => sum + r.metadata.inputTokens + r.metadata.outputTokens,
          0,
        );
        expect(tokens).toBeGreaterThan(0);
      }

      // 7. Verify outputs written to workspace
      for (const taskId of run.taskIds) {
        const task = await workspace.readTask(taskId);
        const squad = SKILL_SQUAD_MAP[task.to];
        if (squad) {
          const output = await workspace.readOutput(squad, task.to, taskId);
          expect(output.length).toBeGreaterThan(100);
          console.log(
            `  [Output] ${task.to}: ${output.length} chars written`,
          );
        }
      }

      // 8. Verify all pipeline tasks in completed state
      for (const taskId of run.taskIds) {
        const task = await workspace.readTask(taskId);
        expect(task.status).toBe("completed");
      }

      console.log(
        `\n[Pipeline] SUCCESS — ${run.taskIds.length} tasks completed with real Claude API`,
      );
    }, 360_000); // 6 minute timeout for full pipeline (5 sequential real API calls)
  });
});
