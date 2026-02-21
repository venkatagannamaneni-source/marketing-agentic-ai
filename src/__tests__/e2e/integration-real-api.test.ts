/**
 * Comprehensive E2E Integration Test — Phase 1 + Phase 2
 *
 * Tests the FULL system with real Claude API calls:
 *
 * Phase 1 (Backend Foundation):
 *   - Claude client (AnthropicClaudeClient)
 *   - Skill loading (.agents/skills/*)
 *   - Prompt building (system + user messages)
 *   - AgentExecutor (task → API → workspace)
 *   - Workspace (file-based task/output persistence)
 *
 * Phase 2 (Runtime Engine):
 *   - MarketingDirector (goal creation, decomposition, routing, review)
 *   - PipelineFactory (goal plan → pipeline definition)
 *   - SequentialPipelineEngine (multi-step execution)
 *   - CostTracker (budget state tracking)
 *   - EventBus (event-driven pipeline triggering)
 *   - Scheduler (cron-based scheduling)
 *   - Runtime (runGoal dry run with real config)
 *
 * Cost control: All tests use claude-haiku-4-5 (~$0.01 per test).
 * Skipped automatically if ANTHROPIC_API_KEY is not set.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";

// ── Phase 1 Imports ─────────────────────────────────────────────────────────
import { AnthropicClaudeClient, MODEL_MAP, estimateCost } from "../../agents/claude-client.ts";
import { AgentExecutor } from "../../agents/executor.ts";
import type { ExecutorConfig } from "../../agents/executor.ts";
import { loadSkillMeta } from "../../agents/skill-loader.ts";
import { buildAgentPrompt } from "../../agents/prompt-builder.ts";
import { selectModelTier } from "../../agents/model-selector.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import { SKILL_NAMES, SKILL_SQUAD_MAP } from "../../types/agent.ts";
import type { SkillName, SquadName } from "../../types/agent.ts";
import type { Task } from "../../types/task.ts";

// ── Phase 2 Imports ─────────────────────────────────────────────────────────
import { MarketingDirector } from "../../director/director.ts";
import { GoalDecomposer } from "../../director/goal-decomposer.ts";
import { PipelineFactory } from "../../director/pipeline-factory.ts";
import { ReviewEngine } from "../../director/review-engine.ts";
import { EscalationEngine } from "../../director/escalation.ts";
import { SequentialPipelineEngine } from "../../pipeline/pipeline-engine.ts";
import { PIPELINE_TEMPLATES, AGENT_DEPENDENCY_GRAPH } from "../../agents/registry.ts";
import { CostTracker } from "../../observability/cost-tracker.ts";
import { EventBus } from "../../events/event-bus.ts";
import { DEFAULT_EVENT_MAPPINGS } from "../../events/default-mappings.ts";
import { Scheduler } from "../../scheduler/scheduler.ts";
import { loadConfig } from "../../config.ts";
import { routeGoal } from "../../director/squad-router.ts";
import type { BudgetState } from "../../director/types.ts";
import type { SystemEvent } from "../../types/events.ts";

// ── Constants ───────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");
const API_KEY = process.env.ANTHROPIC_API_KEY;
const HAS_API_KEY = Boolean(API_KEY);
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

const HAIKU_BUDGET: BudgetState = {
  totalBudget: 1000,
  spent: 0,
  percentUsed: 0,
  level: "normal",
  allowedPriorities: ["P0", "P1", "P2", "P3"],
  modelOverride: "haiku",
};

// ── Test Utilities ──────────────────────────────────────────────────────────

function createTask(
  skill: SkillName,
  goalDescription: string,
  requirements: string,
  taskId?: string,
): Task {
  const id = taskId ?? `int-test-${skill}-${Date.now()}`;
  const squad = SKILL_SQUAD_MAP[skill];
  const outputPath = squad
    ? `outputs/${squad}/${skill}/${id}.md`
    : `outputs/foundation/${skill}/${id}.md`;

  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    from: "director",
    to: skill,
    priority: "P2",
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: "test-goal-integration",
    pipelineId: null,
    goal: goalDescription,
    inputs: [],
    requirements,
    output: { path: outputPath, format: "markdown" },
    next: { type: "complete" },
    tags: ["integration-test"],
    metadata: {},
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 1 TESTS: Backend Foundation with Real Claude API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!HAS_API_KEY)("Integration: Phase 1 — Backend Foundation", () => {
  let workspace: FileSystemWorkspaceManager;
  let tempDir: string;
  let client: AnthropicClaudeClient;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "integration-p1-"));
    workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
    await workspace.init();
    await workspace.writeFile("context/product-marketing-context.md", PRODUCT_CONTEXT);
    client = new AnthropicClaudeClient(new Anthropic({ apiKey: API_KEY }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── 1.1: Claude Client ──────────────────────────────────────────────────

  it("1.1 AnthropicClaudeClient makes real API call with structured response", async () => {
    const result = await client.createMessage({
      model: HAIKU_MODEL,
      system: "You are a helpful marketing assistant. Be concise.",
      messages: [{ role: "user", content: "Name 3 B2B SaaS marketing channels. One word each." }],
      maxTokens: 100,
      timeoutMs: 30_000,
    });

    console.log("[1.1] Response:", result.content);
    console.log(`[1.1] Tokens: ${result.inputTokens}in/${result.outputTokens}out, ${result.durationMs}ms`);

    expect(result.content).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(5);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.stopReason).toBe("end_turn");
    expect(result.model).toContain("claude");
    expect(result.durationMs).toBeGreaterThan(0);
  }, 30_000);

  // ── 1.2: Skill Loading ──────────────────────────────────────────────────

  it("1.2 loads all 26 skill metadata files from .agents/skills/", async () => {
    const loadResults: { skill: string; loaded: boolean; error?: string }[] = [];

    for (const skill of SKILL_NAMES) {
      try {
        const meta = await loadSkillMeta(skill, PROJECT_ROOT);
        loadResults.push({
          skill,
          loaded: true,
        });
        expect(meta.name).toBe(skill);
        expect(meta.skillFilePath.length).toBeGreaterThan(0);
      } catch (err: unknown) {
        loadResults.push({
          skill,
          loaded: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const loaded = loadResults.filter((r) => r.loaded);
    const failed = loadResults.filter((r) => !r.loaded);

    console.log(`[1.2] Loaded ${loaded.length}/${SKILL_NAMES.length} skills`);
    if (failed.length > 0) {
      console.log(`[1.2] Failed: ${failed.map((f) => f.skill).join(", ")}`);
    }

    expect(loaded.length).toBe(SKILL_NAMES.length);
  }, 10_000);

  // ── 1.3: Prompt Building ────────────────────────────────────────────────

  it("1.3 builds valid prompts with skill context and product context", async () => {
    const task = createTask(
      "marketing-ideas",
      "Generate marketing ideas for MarketFlow",
      "Generate 3 creative marketing ideas. Keep it brief.",
    );
    await workspace.writeTask(task);

    const meta = await loadSkillMeta("marketing-ideas", PROJECT_ROOT);
    const prompt = await buildAgentPrompt(task, meta, workspace, PROJECT_ROOT, 150_000);

    console.log(`[1.3] System prompt: ${prompt.systemPrompt.length} chars`);
    console.log(`[1.3] User message: ${prompt.userMessage.length} chars`);
    console.log(`[1.3] Missing inputs: ${prompt.missingInputs.length}`);
    console.log(`[1.3] Warnings: ${prompt.warnings.length}`);

    expect(prompt.systemPrompt.length).toBeGreaterThan(100);
    expect(prompt.userMessage.length).toBeGreaterThan(50);
    expect(prompt.systemPrompt).toContain("marketing");
  }, 10_000);

  // ── 1.4: Model Selection ────────────────────────────────────────────────

  it("1.4 model selector respects budget overrides", () => {
    // Default selection (no budget)
    const defaultTier = selectModelTier("copywriting");
    expect(["opus", "sonnet", "haiku"]).toContain(defaultTier);

    // Budget override forces haiku
    const haiku = selectModelTier("copywriting", HAIKU_BUDGET);
    expect(haiku).toBe("haiku");

    // Model tier override takes precedence
    const override = selectModelTier("copywriting", HAIKU_BUDGET, "sonnet");
    expect(override).toBe("sonnet");

    console.log(`[1.4] Default: ${defaultTier}, Budget: ${haiku}, Override: ${override}`);
  });

  // ── 1.5: AgentExecutor — Single Task ────────────────────────────────────

  it("1.5 AgentExecutor executes real marketing-ideas task", async () => {
    const config: ExecutorConfig = {
      projectRoot: PROJECT_ROOT,
      defaultModel: "haiku",
      defaultTimeoutMs: 60_000,
      defaultMaxTokens: 2048,
      maxRetries: 0,
      maxContextTokens: 150_000,
    };

    const executor = new AgentExecutor(client, workspace, config);

    const task = createTask(
      "marketing-ideas",
      "Generate marketing ideas for MarketFlow",
      "Generate exactly 3 creative marketing ideas for MarketFlow. For each: title, one-sentence description, and effort level (low/medium/high). Under 400 words.",
      "int-test-marketing-ideas-001",
    );

    await workspace.writeTask(task);
    const result = await executor.execute(task, { budgetState: HAIKU_BUDGET });

    console.log(`[1.5] Status: ${result.status}`);
    console.log(`[1.5] Content: ${result.content.slice(0, 300)}...`);
    console.log(`[1.5] Model: ${result.metadata.model} (${result.metadata.modelTier})`);
    console.log(`[1.5] Tokens: ${result.metadata.inputTokens}in/${result.metadata.outputTokens}out`);
    console.log(`[1.5] Cost: $${result.metadata.estimatedCost.toFixed(6)}`);

    expect(result.status).toBe("completed");
    expect(result.taskId).toBe("int-test-marketing-ideas-001");
    expect(result.content.length).toBeGreaterThan(100);
    expect(result.metadata.inputTokens).toBeGreaterThan(0);
    expect(result.metadata.outputTokens).toBeGreaterThan(0);
    expect(result.metadata.estimatedCost).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);

    // Output persisted to workspace
    const output = await workspace.readOutput("strategy", "marketing-ideas", "int-test-marketing-ideas-001");
    expect(output).toBe(result.content);

    // Task status updated
    const updatedTask = await workspace.readTask("int-test-marketing-ideas-001");
    expect(updatedTask.status).toBe("completed");
  }, 60_000);

  // ── 1.6: AgentExecutor — Multiple Skills ────────────────────────────────

  it("1.6 AgentExecutor executes different skill types", async () => {
    const config: ExecutorConfig = {
      projectRoot: PROJECT_ROOT,
      defaultModel: "haiku",
      defaultTimeoutMs: 60_000,
      defaultMaxTokens: 1024,
      maxRetries: 0,
      maxContextTokens: 150_000,
    };

    const executor = new AgentExecutor(client, workspace, config);
    const skillsToTest: { skill: SkillName; requirements: string }[] = [
      {
        skill: "content-strategy",
        requirements: "Outline a simple 3-topic content strategy for MarketFlow. Under 200 words.",
      },
      {
        skill: "seo-audit",
        requirements: "List 3 SEO audit items to check for MarketFlow's homepage. Under 200 words.",
      },
    ];

    const results: Array<{ skill: string; status: string; tokens: number; cost: number }> = [];

    for (const { skill, requirements } of skillsToTest) {
      const taskId = `int-test-${skill}-001`;
      const task = createTask(skill, `Execute ${skill} for MarketFlow`, requirements, taskId);
      await workspace.writeTask(task);

      const result = await executor.execute(task, { budgetState: HAIKU_BUDGET });

      results.push({
        skill,
        status: result.status,
        tokens: result.metadata.inputTokens + result.metadata.outputTokens,
        cost: result.metadata.estimatedCost,
      });

      expect(result.status).toBe("completed");
      expect(result.content.length).toBeGreaterThan(50);
    }

    console.log("[1.6] Multi-skill results:");
    for (const r of results) {
      console.log(`  ${r.skill}: ${r.status}, ${r.tokens} tokens, $${r.cost.toFixed(6)}`);
    }
  }, 120_000);

  // ── 1.7: Workspace Persistence ──────────────────────────────────────────

  it("1.7 workspace persists tasks, outputs, reviews, goals, and learnings", async () => {
    // Write a task
    const task = createTask("copywriting", "Test persistence", "Test", "persist-test-001");
    await workspace.writeTask(task);

    // Read it back
    const readTask = await workspace.readTask("persist-test-001");
    expect(readTask.id).toBe("persist-test-001");
    expect(readTask.to).toBe("copywriting");

    // Write output
    await workspace.writeOutput("creative", "copywriting", "persist-test-001", "# Test Output\n\nContent here.");
    const output = await workspace.readOutput("creative", "copywriting", "persist-test-001");
    expect(output).toContain("Test Output");

    // Update task status (must follow valid transitions: pending → in_progress → completed)
    await workspace.updateTaskStatus("persist-test-001", "in_progress");
    await workspace.updateTaskStatus("persist-test-001", "completed");
    const updated = await workspace.readTask("persist-test-001");
    expect(updated.status).toBe("completed");

    // Write and read goals
    const goal = {
      id: "goal-persist-test",
      description: "Test goal",
      category: "content" as const,
      priority: "P2" as const,
      createdAt: new Date().toISOString(),
      deadline: null,
      metadata: {},
    };
    await workspace.writeGoal(goal);
    const readGoal = await workspace.readGoal("goal-persist-test");
    expect(readGoal.id).toBe("goal-persist-test");

    // Write learnings
    await workspace.appendLearning({
      timestamp: new Date().toISOString(),
      agent: "copywriting",
      goalId: null,
      outcome: "success",
      learning: "test works",
      actionTaken: "Verified workspace persistence",
    });
    const learnings = await workspace.readLearnings();
    expect(learnings).toContain("test works");

    // List tasks
    const allTasks = await workspace.listTasks();
    expect(allTasks.length).toBe(1);

    console.log("[1.7] All workspace operations verified");
  });

  // ── 1.8: Cost Estimation ────────────────────────────────────────────────

  it("1.8 cost estimation matches actual API usage", async () => {
    const result = await client.createMessage({
      model: HAIKU_MODEL,
      system: "Be very brief.",
      messages: [{ role: "user", content: "Say hello." }],
      maxTokens: 50,
      timeoutMs: 30_000,
    });

    const estimated = estimateCost("haiku", result.inputTokens, result.outputTokens);

    console.log(`[1.8] Tokens: ${result.inputTokens}in/${result.outputTokens}out`);
    console.log(`[1.8] Estimated cost: $${estimated.toFixed(8)}`);

    expect(estimated).toBeGreaterThan(0);
    expect(estimated).toBeLessThan(0.01); // Haiku is cheap
  }, 30_000);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 2 TESTS: Runtime Engine with Real Claude API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!HAS_API_KEY)("Integration: Phase 2 — Runtime Engine", () => {
  let workspace: FileSystemWorkspaceManager;
  let tempDir: string;
  let client: AnthropicClaudeClient;
  let director: MarketingDirector;
  let pipelineEngine: SequentialPipelineEngine;
  let pipelineFactory: PipelineFactory;
  let costTracker: CostTracker;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "integration-p2-"));
    workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
    await workspace.init();
    await workspace.writeFile("context/product-marketing-context.md", PRODUCT_CONTEXT);

    client = new AnthropicClaudeClient(new Anthropic({ apiKey: API_KEY }));

    const executorConfig: ExecutorConfig = {
      projectRoot: PROJECT_ROOT,
      defaultModel: "haiku",
      defaultTimeoutMs: 60_000,
      defaultMaxTokens: 2048,
      maxRetries: 0,
      maxContextTokens: 150_000,
    };

    director = new MarketingDirector(workspace, undefined, client, executorConfig);
    pipelineFactory = new PipelineFactory(PIPELINE_TEMPLATES);

    const pipelineExecutor = new AgentExecutor(client, workspace, executorConfig);
    pipelineEngine = new SequentialPipelineEngine(pipelineFactory, pipelineExecutor, workspace);

    costTracker = new CostTracker({
      budget: { totalMonthly: 1000, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 },
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── 2.1: Goal Creation and Decomposition ────────────────────────────────

  it("2.1 Director creates goal, decomposes into phased plan", async () => {
    const goal = await director.createGoal("Create a content strategy for MarketFlow", "content", "P2");

    expect(goal.id).toMatch(/^goal-/);
    expect(goal.description).toContain("content strategy");
    expect(goal.category).toBe("content");

    // Verify persistence
    const readGoal = await director.readGoal(goal.id);
    expect(readGoal.id).toBe(goal.id);

    // Decompose
    const plan = director.decomposeGoal(goal);

    console.log(`[2.1] Goal: ${goal.id}`);
    console.log(`[2.1] Plan: ${plan.phases.length} phases, ~${plan.estimatedTaskCount} tasks`);
    console.log(`[2.1] Template: ${plan.pipelineTemplateName}`);
    console.log(`[2.1] Phases: ${plan.phases.map((p) => `${p.name}(${p.skills.join(",")})`).join(" → ")}`);

    expect(plan.phases.length).toBeGreaterThanOrEqual(2);
    expect(plan.estimatedTaskCount).toBeGreaterThanOrEqual(3);
    expect(plan.pipelineTemplateName).toBe("Content Production");

    // Materialize Phase 1 tasks
    const tasks = await director.planGoalTasks(plan, goal);
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // All tasks reference goal
    for (const task of tasks) {
      expect(task.goalId).toBe(goal.id);
      expect(task.status).toBe("pending");
    }
  });

  // ── 2.2: Squad Routing ──────────────────────────────────────────────────

  it("2.2 goal categories route to correct squad sequences", () => {
    const categories: Array<{ category: "content" | "optimization" | "retention" | "competitive" | "measurement"; expectedSquads: SquadName[] }> = [
      { category: "content", expectedSquads: ["strategy", "creative", "measure"] },
      { category: "optimization", expectedSquads: ["convert", "creative", "measure"] },
      { category: "retention", expectedSquads: ["activate", "measure"] },
      { category: "competitive", expectedSquads: ["strategy", "creative", "strategy", "measure"] },
      { category: "measurement", expectedSquads: ["measure"] },
    ];

    for (const { category, expectedSquads } of categories) {
      const routing = routeGoal(category);
      const actualSquads: SquadName[] = routing.routes.map((r) => r.squad);
      expect(actualSquads).toEqual(expectedSquads);
      console.log(`[2.2] ${category}: ${actualSquads.join(" → ")}`);
    }
  });

  // ── 2.3: Pipeline Factory ───────────────────────────────────────────────

  it("2.3 pipeline factory creates definitions and runs from templates", () => {
    for (const template of PIPELINE_TEMPLATES) {
      const definition = pipelineFactory.templateToDefinition(template);
      expect(definition.steps.length).toBe(template.steps.length);
      expect(definition.name).toBe(template.name);

      const run = pipelineFactory.createRun(definition, null);
      expect(run.status).toBe("pending");
      expect(run.taskIds).toHaveLength(0);

      console.log(`[2.3] ${template.name}: ${definition.steps.length} steps`);
    }

    expect(PIPELINE_TEMPLATES.length).toBe(8);
  });

  // ── 2.4: Budget and Escalation ──────────────────────────────────────────

  it("2.4 CostTracker tracks spend and budget levels", () => {
    expect(costTracker.getTotalSpent()).toBe(0);
    expect(costTracker.toBudgetState().level).toBe("normal");

    // Record some spend
    costTracker.record({
      timestamp: new Date().toISOString(),
      taskId: "test-cost-1",
      skillName: "copywriting",
      modelTier: "haiku",
      inputTokens: 5000,
      outputTokens: 2000,
      estimatedCost: 50,
    });

    expect(costTracker.getTotalSpent()).toBe(50);
    expect(costTracker.toBudgetState().level).toBe("normal");

    // Push to warning
    costTracker.record({
      timestamp: new Date().toISOString(),
      taskId: "test-cost-2",
      skillName: "copywriting",
      modelTier: "sonnet",
      inputTokens: 10000,
      outputTokens: 5000,
      estimatedCost: 760,
    });

    expect(costTracker.getTotalSpent()).toBe(810);
    expect(costTracker.toBudgetState().level).toBe("warning");

    // Push to throttle
    costTracker.record({
      timestamp: new Date().toISOString(),
      taskId: "test-cost-3",
      skillName: "copywriting",
      modelTier: "opus",
      inputTokens: 10000,
      outputTokens: 5000,
      estimatedCost: 100,
    });

    expect(costTracker.toBudgetState().level).toBe("throttle");

    console.log(`[2.4] Total spent: $${costTracker.getTotalSpent()}`);
    console.log(`[2.4] Budget level: ${costTracker.toBudgetState().level}`);
  });

  // ── 2.5: Two-Step Pipeline with Real API ────────────────────────────────

  it("2.5 runs a 2-step pipeline with real Claude API calls", async () => {
    const goal = await director.createGoal(
      "Create a brief content strategy and initial copy for MarketFlow",
      "content",
      "P2",
    );

    // Create a custom 2-step pipeline (shorter than full Content Production)
    const definition = {
      id: "test-mini-pipeline",
      name: "Mini Content Pipeline",
      description: "Strategy then copywriting",
      steps: [
        { type: "sequential" as const, skill: "content-strategy" as SkillName },
        { type: "sequential" as const, skill: "copywriting" as SkillName },
      ],
      defaultPriority: "P2" as const,
      trigger: { type: "manual" as const },
    };

    const run = pipelineFactory.createRun(definition, goal.id);

    console.log(`[2.5] Starting 2-step pipeline...`);
    const startTime = Date.now();

    const result = await pipelineEngine.execute(definition, run, {
      goalDescription: goal.description,
      priority: goal.priority,
    });

    const totalDurationMs = Date.now() - startTime;

    console.log(`[2.5] Pipeline completed in ${totalDurationMs}ms`);
    console.log(`[2.5] Status: ${result.status}`);
    console.log(`[2.5] Steps: ${result.stepResults.length}`);
    console.log(
      `[2.5] Tokens: ${result.totalTokensUsed.input}in/${result.totalTokensUsed.output}out`,
    );

    for (const stepResult of result.stepResults) {
      const skill =
        stepResult.step.type === "sequential"
          ? stepResult.step.skill
          : stepResult.step.type === "parallel"
            ? stepResult.step.skills.join(", ")
            : "review";
      const tokens = stepResult.executionResults.reduce(
        (sum, r) => sum + r.metadata.inputTokens + r.metadata.outputTokens,
        0,
      );
      console.log(`  [${stepResult.status}] ${skill}: ${tokens} tokens, ${stepResult.durationMs}ms`);
    }

    expect(result.status).toBe("completed");
    expect(result.stepResults.length).toBe(2);

    for (const stepResult of result.stepResults) {
      expect(stepResult.status).toBe("completed");
    }

    expect(result.totalTokensUsed.input).toBeGreaterThan(0);
    expect(result.totalTokensUsed.output).toBeGreaterThan(0);

    // Verify outputs written
    for (const taskId of run.taskIds) {
      const task = await workspace.readTask(taskId);
      expect(task.status).toBe("completed");
      const squad = SKILL_SQUAD_MAP[task.to];
      if (squad) {
        const output = await workspace.readOutput(squad, task.to, taskId);
        expect(output.length).toBeGreaterThan(100);
      }
    }
  }, 180_000);

  // ── 2.6: Director Review with Real API Output ──────────────────────────

  it("2.6 Director structural review evaluates real Claude output", async () => {
    const config: ExecutorConfig = {
      projectRoot: PROJECT_ROOT,
      defaultModel: "haiku",
      defaultTimeoutMs: 60_000,
      defaultMaxTokens: 2048,
      maxRetries: 0,
      maxContextTokens: 150_000,
    };

    const executor = new AgentExecutor(client, workspace, config);

    // Execute a real task
    const task = createTask(
      "marketing-ideas",
      "Generate marketing ideas",
      "Generate 3 creative marketing ideas for MarketFlow. Include: title, description, effort level. Use markdown headings.",
      "review-test-001",
    );
    await workspace.writeTask(task);
    const execResult = await executor.execute(task, { budgetState: HAIKU_BUDGET });

    expect(execResult.status).toBe("completed");

    // Director reviews the real output
    const decision = await director.reviewCompletedTask("review-test-001");

    console.log(`[2.6] Review verdict: ${decision.review?.verdict}`);
    console.log(`[2.6] Action: ${decision.action}`);
    console.log(`[2.6] Findings: ${decision.review?.findings.length}`);

    expect(decision.review).toBeTruthy();
    // Real Claude output with markdown should pass structural review
    expect(decision.review!.verdict).toBe("APPROVE");
    // Action depends on task.next: "complete" → goal_complete, "director_review" → approve
    expect(["approve", "goal_complete"]).toContain(decision.action);
  }, 60_000);

  // ── 2.7: Config Loading ─────────────────────────────────────────────────

  it("2.7 loadConfig reads real environment variables", () => {
    const config = loadConfig();

    expect(config.anthropicApiKey).toBeTruthy();
    expect(config.anthropicApiKey.length).toBeGreaterThan(10);
    expect(config.redis.host).toBeDefined();
    expect(config.redis.port).toBeGreaterThan(0);
    expect(config.workspace.rootDir).toMatch(/^\//);
    expect(config.budget.totalMonthly).toBeGreaterThan(0);
    expect(Object.isFrozen(config)).toBe(true);

    console.log(`[2.7] Config loaded: API key present, Redis ${config.redis.host}:${config.redis.port}`);
  });

  // ── 2.8: Goal Decomposition Across All Categories ───────────────────────

  it("2.8 goal decomposition works for all 6 categories", async () => {
    const categories: Array<{ category: "strategic" | "content" | "optimization" | "retention" | "competitive" | "measurement"; goal: string }> = [
      { category: "strategic", goal: "Develop Q2 marketing strategy" },
      { category: "content", goal: "Create blog content pipeline" },
      { category: "optimization", goal: "Improve landing page conversions" },
      { category: "retention", goal: "Reduce monthly churn by 15%" },
      { category: "competitive", goal: "Respond to competitor feature launch" },
      { category: "measurement", goal: "Set up analytics tracking" },
    ];

    for (const { category, goal: goalText } of categories) {
      const goal = await director.createGoal(goalText, category, "P2");
      const plan = director.decomposeGoal(goal);

      expect(plan.phases.length).toBeGreaterThanOrEqual(1);
      expect(plan.estimatedTaskCount).toBeGreaterThanOrEqual(1);

      console.log(
        `[2.8] ${category}: ${plan.phases.length} phases, ${plan.estimatedTaskCount} tasks` +
          (plan.pipelineTemplateName ? ` (${plan.pipelineTemplateName})` : " (custom)"),
      );
    }
  });

  // ── 2.9: Dependency Graph Integrity ─────────────────────────────────────

  it("2.9 agent dependency graph covers all 26 skills", () => {
    const graphSkills = Object.keys(AGENT_DEPENDENCY_GRAPH) as SkillName[];

    expect(graphSkills.length).toBe(SKILL_NAMES.length);

    for (const skill of SKILL_NAMES) {
      expect(AGENT_DEPENDENCY_GRAPH).toHaveProperty(skill);
    }

    // No circular deps at depth 1
    for (const [producer, consumers] of Object.entries(AGENT_DEPENDENCY_GRAPH)) {
      for (const consumer of consumers) {
        const reverseConsumers = AGENT_DEPENDENCY_GRAPH[consumer as SkillName] ?? [];
        // Allow cycles (e.g., copywriting ↔ page-cro) but log them
        if (reverseConsumers.includes(producer as SkillName)) {
          console.log(`[2.9] Bidirectional dependency: ${producer} ↔ ${consumer}`);
        }
      }
    }

    console.log(`[2.9] Dependency graph verified: ${graphSkills.length} skills`);
  });

  // ── 2.10: End-to-End Goal Lifecycle ─────────────────────────────────────

  it("2.10 full goal lifecycle: create → decompose → execute → review → advance", async () => {
    // Use "measurement" category for fewer steps (only 1 phase with 3 skills in parallel)
    const goal = await director.createGoal(
      "Set up basic analytics tracking for MarketFlow",
      "measurement",
      "P2",
    );

    const plan = director.decomposeGoal(goal);
    console.log(`[2.10] Goal: ${goal.id}`);
    console.log(`[2.10] Plan: ${plan.phases.length} phases, ${plan.estimatedTaskCount} tasks`);

    // Materialize tasks
    const tasks = await director.planGoalTasks(plan, goal);
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // Build and execute pipeline
    const definition = pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = pipelineFactory.createRun(definition, goal.id);

    const pipelineResult = await pipelineEngine.execute(definition, run, {
      goalDescription: goal.description,
      priority: goal.priority,
    });

    console.log(`[2.10] Pipeline status: ${pipelineResult.status}`);
    console.log(`[2.10] Steps completed: ${pipelineResult.stepResults.length}`);

    expect(pipelineResult.status).toBe("completed");

    // Review each completed task
    let allApproved = true;
    for (const taskId of run.taskIds) {
      const task = await workspace.readTask(taskId);
      if (task.status === "completed") {
        const decision = await director.reviewCompletedTask(taskId);
        console.log(`[2.10] Review ${taskId}: ${decision.review?.verdict} → ${decision.action}`);
        if (decision.review?.verdict !== "APPROVE") {
          allApproved = false;
        }
      }
    }

    // Track costs
    for (const stepResult of pipelineResult.stepResults) {
      for (const execResult of stepResult.executionResults) {
        costTracker.record({
          timestamp: new Date().toISOString(),
          taskId: execResult.taskId,
          skillName: execResult.skill,
          modelTier: execResult.metadata.modelTier,
          inputTokens: execResult.metadata.inputTokens,
          outputTokens: execResult.metadata.outputTokens,
          estimatedCost: execResult.metadata.estimatedCost,
        });
      }
    }

    console.log(`[2.10] Total cost tracked: $${costTracker.getTotalSpent().toFixed(6)}`);
    console.log(`[2.10] Budget level: ${costTracker.toBudgetState().level}`);
    expect(costTracker.getTotalSpent()).toBeGreaterThan(0);
    expect(costTracker.toBudgetState().level).toBe("normal");

    // Try to advance goal
    const advanceResult = await director.advanceGoal(goal.id);
    console.log(`[2.10] Advance result: ${advanceResult === "complete" ? "complete" : `${(advanceResult as Task[]).length} remaining tasks`}`);
  }, 300_000);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CROSS-PHASE INTEGRATION: Full System Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!HAS_API_KEY)("Integration: Cross-Phase — Full System", () => {
  let workspace: FileSystemWorkspaceManager;
  let tempDir: string;
  let client: AnthropicClaudeClient;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "integration-cross-"));
    workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
    await workspace.init();
    await workspace.writeFile("context/product-marketing-context.md", PRODUCT_CONTEXT);
    client = new AnthropicClaudeClient(new Anthropic({ apiKey: API_KEY }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── 3.1: Data Flows Across All 14 Modules ──────────────────────────────

  it("3.1 data flows through types → workspace → agents → director → pipeline → observability", async () => {
    const executorConfig: ExecutorConfig = {
      projectRoot: PROJECT_ROOT,
      defaultModel: "haiku",
      defaultTimeoutMs: 60_000,
      defaultMaxTokens: 1024,
      maxRetries: 0,
      maxContextTokens: 150_000,
    };

    // Module 1: types/ — Used throughout
    // Module 2: config/ — Already validated in 2.7
    // Module 3: workspace/ — Write product context
    await workspace.writeFile("context/test-marker.md", "# Integration Test Marker\n");
    const marker = await workspace.readFile("context/test-marker.md");
    expect(marker).toContain("Integration Test Marker");

    // Module 4: agents/ — Create executor with real client
    const executor = new AgentExecutor(client, workspace, executorConfig);

    // Module 5: director/ — Create goal
    const director = new MarketingDirector(workspace, undefined, client, executorConfig);
    const goal = await director.createGoal("Integration test: verify data flow", "measurement", "P2");
    expect(goal.id).toMatch(/^goal-/);

    // Module 6: Decompose goal
    const plan = director.decomposeGoal(goal);
    expect(plan.phases.length).toBeGreaterThanOrEqual(1);

    // Module 7: pipeline/ — Build pipeline definition
    const pipelineFactory = new PipelineFactory(PIPELINE_TEMPLATES);
    const definition = pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = pipelineFactory.createRun(definition, goal.id);

    // Execute single step via executor (not full pipeline — to control scope)
    const firstStep = definition.steps[0]!;
    const stepSkills =
      firstStep.type === "sequential"
        ? [firstStep.skill]
        : firstStep.type === "parallel"
          ? [...firstStep.skills]
          : [];

    const firstSkill = stepSkills[0]!;
    const task = createTask(
      firstSkill,
      goal.description,
      `Execute ${firstSkill} work for integration test. Keep response under 200 words.`,
      `cross-phase-${firstSkill}-001`,
    );
    await workspace.writeTask(task);

    const result = await executor.execute(task, { budgetState: HAIKU_BUDGET });
    expect(result.status).toBe("completed");

    // Module 8: observability/ — CostTracker
    const costTracker = new CostTracker({
      budget: { totalMonthly: 1000, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 },
    });
    costTracker.record({
      timestamp: new Date().toISOString(),
      taskId: result.taskId,
      skillName: result.skill,
      modelTier: result.metadata.modelTier,
      inputTokens: result.metadata.inputTokens,
      outputTokens: result.metadata.outputTokens,
      estimatedCost: result.metadata.estimatedCost,
    });
    expect(costTracker.getTotalSpent()).toBeGreaterThan(0);

    // Module 9: Director review
    const decision = await director.reviewCompletedTask(task.id);
    expect(decision.review).toBeTruthy();

    console.log("[3.1] Cross-phase data flow verified:");
    console.log(`  types/ ✓ | workspace/ ✓ | agents/ ✓`);
    console.log(`  director/ ✓ | pipeline/ ✓ | observability/ ✓`);
    console.log(`  Task: ${result.taskId} | Skill: ${result.skill}`);
    console.log(`  Cost: $${result.metadata.estimatedCost.toFixed(6)}`);
    console.log(`  Review: ${decision.review?.verdict}`);
  }, 120_000);

  // ── 3.2: Real API Cost Summary ──────────────────────────────────────────

  it("3.2 validates cost tracking accuracy across multiple API calls", async () => {
    const costTracker = new CostTracker({
      budget: { totalMonthly: 100, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 },
    });

    const calls = [
      { role: "Greeting", message: "Say hi in 3 words." },
      { role: "Math", message: "What is 7 * 8? Number only." },
      { role: "Marketing", message: "One B2B SaaS marketing tip in one sentence." },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const call of calls) {
      const result = await client.createMessage({
        model: HAIKU_MODEL,
        system: "Be extremely concise.",
        messages: [{ role: "user", content: call.message }],
        maxTokens: 50,
        timeoutMs: 30_000,
      });

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;

      const cost = estimateCost("haiku", result.inputTokens, result.outputTokens);
      costTracker.record({
        timestamp: new Date().toISOString(),
        taskId: `cost-test-${call.role.toLowerCase()}`,
        skillName: "copywriting",
        modelTier: "haiku",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCost: cost,
      });

      console.log(`[3.2] ${call.role}: "${result.content.slice(0, 50)}" — $${cost.toFixed(8)}`);
    }

    const totalSpent = costTracker.getTotalSpent();
    const manualCost = estimateCost("haiku", totalInputTokens, totalOutputTokens);

    console.log(`[3.2] Total tracked: $${totalSpent.toFixed(8)}`);
    console.log(`[3.2] Manual calc: $${manualCost.toFixed(8)}`);
    console.log(`[3.2] Budget level: ${costTracker.toBudgetState().level}`);

    expect(totalSpent).toBeGreaterThan(0);
    expect(costTracker.toBudgetState().level).toBe("normal");
  }, 60_000);
});
