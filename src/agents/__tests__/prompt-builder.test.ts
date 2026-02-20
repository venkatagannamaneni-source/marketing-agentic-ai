import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { buildAgentPrompt } from "../prompt-builder.ts";
import { loadSkillMeta } from "../skill-loader.ts";
import {
  createTestWorkspace,
  type TestWorkspace,
} from "../../director/__tests__/helpers.ts";
import type { Task } from "../../types/task.ts";
import type { AgentMeta } from "../../types/agent.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

let tw: TestWorkspace;

beforeEach(async () => {
  tw = await createTestWorkspace();
});

afterEach(async () => {
  await tw.cleanup();
});

// ── Fixture ──────────────────────────────────────────────────────────────────

function createPromptTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "page-cro-20260219-abc123",
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:00.000Z",
    from: "director",
    to: "page-cro",
    priority: "P1",
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: "goal-20260219-abc123",
    pipelineId: null,
    goal: "Increase signup conversion rate by 20%",
    inputs: [
      {
        path: "context/product-marketing-context.md",
        description: "Product context",
      },
    ],
    requirements: "Audit the signup page for conversion issues",
    output: {
      path: "outputs/convert/page-cro/page-cro-20260219-abc123.md",
      format: "Markdown per SKILL.md specification",
    },
    next: { type: "director_review" },
    tags: ["page-cro"],
    metadata: {},
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildAgentPrompt", () => {
  it("uses full SKILL.md content as system prompt", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    // System prompt should contain the SKILL.md content
    const skillContent = await readFile(meta.skillFilePath, "utf-8");
    expect(prompt.systemPrompt).toBe(skillContent);
  });

  it("includes product context when it exists", async () => {
    await tw.workspace.writeFile(
      "context/product-marketing-context.md",
      "# Product Context\n\nWe sell widgets.",
    );

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.userMessage).toContain("<product-context>");
    expect(prompt.userMessage).toContain("We sell widgets.");
    expect(prompt.userMessage).toContain("</product-context>");
  });

  it("handles missing product context gracefully", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    // Should not crash, should not contain context tags
    expect(prompt.userMessage).not.toContain("<product-context>");
  });

  it("includes task requirements in tags", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask({
      requirements: "Audit the homepage for conversion issues",
    });

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.userMessage).toContain("<task-requirements>");
    expect(prompt.userMessage).toContain(
      "Audit the homepage for conversion issues",
    );
    expect(prompt.userMessage).toContain("</task-requirements>");
  });

  it("includes input files in tags", async () => {
    await tw.workspace.writeFile(
      "context/product-marketing-context.md",
      "# Product\nWidget company",
    );

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.userMessage).toContain(
      '<input-file path="context/product-marketing-context.md">',
    );
    expect(prompt.userMessage).toContain("Widget company");
    expect(prompt.userMessage).toContain("</input-file>");
  });

  it("tracks missing input files in missingInputs (EC-5)", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask({
      inputs: [
        {
          path: "outputs/strategy/content-strategy/task-123.md",
          description: "Strategy output",
        },
      ],
    });

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.missingInputs).toContain(
      "outputs/strategy/content-strategy/task-123.md",
    );
  });

  it("detects revision tasks via revisionCount > 0 (EC-6)", async () => {
    // Write a previous output
    await tw.workspace.writeFile(
      "outputs/convert/page-cro/page-cro-20260219-abc123.md",
      "# Previous Audit\n\nThis was the first attempt.",
    );

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask({
      revisionCount: 1,
    });

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.userMessage).toContain("<previous-output>");
    expect(prompt.userMessage).toContain("This was the first attempt.");
    expect(prompt.userMessage).toContain("</previous-output>");
  });

  it("does NOT include previous output for non-revision tasks", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask({ revisionCount: 0 });

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.userMessage).not.toContain("<previous-output>");
  });

  it("includes reference materials in tags", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    // page-cro has reference files
    if (meta.referenceFiles.length > 0) {
      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      expect(prompt.userMessage).toContain("<reference path=");
      expect(prompt.userMessage).toContain("</reference>");
    }
  });

  it("returns reasonable estimated token count", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    // Should be at least a few hundred tokens (SKILL.md + requirements)
    expect(prompt.estimatedTokens).toBeGreaterThan(100);
    // Should be less than 200K
    expect(prompt.estimatedTokens).toBeLessThan(200_000);
  });

  it("drops references when over context limit (EC-3)", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    // Set a very low token limit to force dropping references
    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
      100, // Very low limit — will force dropping references
    );

    // Should have warnings about dropped references
    if (meta.referenceFiles.length > 0) {
      expect(prompt.warnings.length).toBeGreaterThan(0);
      expect(prompt.warnings.some((w) => w.includes("Dropped"))).toBe(true);
    }
  });

  it("assembles parts in correct order", async () => {
    await tw.workspace.writeFile(
      "context/product-marketing-context.md",
      "CONTEXT_MARKER",
    );

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask({
      requirements: "REQUIREMENTS_MARKER",
    });

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    const contextIdx = prompt.userMessage.indexOf("CONTEXT_MARKER");
    const reqIdx = prompt.userMessage.indexOf("REQUIREMENTS_MARKER");

    // Context should come before requirements
    expect(contextIdx).toBeLessThan(reqIdx);
    expect(contextIdx).toBeGreaterThanOrEqual(0);
  });

  // ── Learnings injection tests ───────────────────────────────────────────

  it("includes relevant learnings for matching skill", async () => {
    // Write learnings for page-cro
    await tw.workspace.appendLearning({
      timestamp: "2026-02-19T10:00:00.000Z",
      agent: "page-cro",
      goalId: null,
      outcome: "success",
      learning: "CTA above fold increases conversions",
      actionTaken: "Always place CTA above fold",
    });

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.userMessage).toContain("<past-learnings>");
    expect(prompt.userMessage).toContain("CTA above fold increases conversions");
    expect(prompt.userMessage).toContain("</past-learnings>");
    expect(prompt.learningsIncluded).toBe(1);
  });

  it("excludes learnings for non-matching skills", async () => {
    // Write learnings for a different skill
    await tw.workspace.appendLearning({
      timestamp: "2026-02-19T10:00:00.000Z",
      agent: "copywriting",
      goalId: null,
      outcome: "success",
      learning: "Short headlines work better",
      actionTaken: "Use short headlines",
    });

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask(); // task.to = page-cro

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.userMessage).not.toContain("<past-learnings>");
    expect(prompt.learningsIncluded).toBe(0);
  });

  it("includes only matching learnings when mixed skills exist", async () => {
    await tw.workspace.appendLearning({
      timestamp: "2026-02-19T10:00:00.000Z",
      agent: "page-cro",
      goalId: null,
      outcome: "success",
      learning: "PAGE_CRO_LEARNING",
      actionTaken: "PAGE_CRO_ACTION",
    });
    await tw.workspace.appendLearning({
      timestamp: "2026-02-19T11:00:00.000Z",
      agent: "copywriting",
      goalId: null,
      outcome: "failure",
      learning: "COPYWRITING_LEARNING",
      actionTaken: "COPYWRITING_ACTION",
    });

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.userMessage).toContain("PAGE_CRO_LEARNING");
    expect(prompt.userMessage).not.toContain("COPYWRITING_LEARNING");
    expect(prompt.learningsIncluded).toBe(1);
  });

  it("does not crash when no learnings file exists", async () => {
    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    // Should not crash, no learnings tags
    expect(prompt.userMessage).not.toContain("<past-learnings>");
    expect(prompt.learningsIncluded).toBe(0);
  });

  it("places learnings between context and requirements", async () => {
    await tw.workspace.writeFile(
      "context/product-marketing-context.md",
      "CONTEXT_MARKER",
    );
    await tw.workspace.appendLearning({
      timestamp: "2026-02-19T10:00:00.000Z",
      agent: "page-cro",
      goalId: null,
      outcome: "success",
      learning: "LEARNING_MARKER",
      actionTaken: "ACTION_MARKER",
    });

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask({
      requirements: "REQUIREMENTS_MARKER",
    });

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    const contextIdx = prompt.userMessage.indexOf("CONTEXT_MARKER");
    const learningIdx = prompt.userMessage.indexOf("LEARNING_MARKER");
    const reqIdx = prompt.userMessage.indexOf("REQUIREMENTS_MARKER");

    expect(contextIdx).toBeGreaterThanOrEqual(0);
    expect(learningIdx).toBeGreaterThan(contextIdx);
    expect(reqIdx).toBeGreaterThan(learningIdx);
  });

  it("limits learnings to 10 most recent", async () => {
    // Write 12 learnings for page-cro
    for (let i = 0; i < 12; i++) {
      const hour = i.toString().padStart(2, "0");
      await tw.workspace.appendLearning({
        timestamp: `2026-02-19T${hour}:00:00.000Z`,
        agent: "page-cro",
        goalId: null,
        outcome: "success",
        learning: `Learning number ${i}`,
        actionTaken: `Action number ${i}`,
      });
    }

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
    );

    expect(prompt.learningsIncluded).toBeLessThanOrEqual(10);
  });

  it("drops all learnings when token budget is extremely small", async () => {
    await tw.workspace.appendLearning({
      timestamp: "2026-02-19T10:00:00.000Z",
      agent: "page-cro",
      goalId: null,
      outcome: "success",
      learning: "A".repeat(500),
      actionTaken: "B".repeat(500),
    });

    const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
    const task = createPromptTestTask();

    // With maxContextTokens=100, learnings budget = 5 tokens (~20 chars)
    // The learning is ~1000 chars, so it should be dropped entirely
    const prompt = await buildAgentPrompt(
      task,
      meta,
      tw.workspace,
      PROJECT_ROOT,
      100,
    );

    expect(prompt.learningsIncluded).toBe(0);
    expect(prompt.userMessage).not.toContain("<past-learnings>");
  });
});
