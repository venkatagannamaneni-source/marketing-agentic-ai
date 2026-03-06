import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { buildAgentPrompt } from "../prompt-builder.ts";
import { loadSkillMeta } from "../skill-loader.ts";
import {
  createTestWorkspace,
  type TestWorkspace,
} from "../../director/__tests__/helpers.ts";
import type { Task } from "../../types/task.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

let tw: TestWorkspace;

beforeEach(async () => {
  tw = await createTestWorkspace();
});

afterEach(async () => {
  await tw.cleanup();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function createRevisionTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "page-cro-20260219-def456",
    createdAt: "2026-02-19T01:00:00.000Z",
    updatedAt: "2026-02-19T01:00:00.000Z",
    from: "director",
    to: "page-cro",
    priority: "P1",
    deadline: null,
    status: "pending",
    revisionCount: 1,
    goalId: "goal-20260219-abc123",
    pipelineId: null,
    goal: "Increase signup conversion rate by 20%",
    inputs: [
      {
        path: "context/product-marketing-context.md",
        description: "Product context",
      },
      {
        path: "outputs/convert/page-cro/page-cro-20260219-abc123.md",
        description: "Previous output to revise",
      },
    ],
    requirements: "REVISION REQUESTED:\n- [required] Add competitive analysis section\n\nOriginal requirements: Audit the signup page for conversion issues",
    output: {
      path: "outputs/convert/page-cro/page-cro-20260219-abc123.md",
      format: "Markdown per SKILL.md specification",
    },
    next: { type: "director_review" },
    tags: ["page-cro", "revision"],
    metadata: {
      originalTaskId: "page-cro-20260219-abc123",
      revisionOf: "page-cro-20260219-abc123",
      originalRequirements: "Audit the signup page for conversion issues",
      revisionFeedback: [
        {
          description: "Add a competitive analysis section comparing your approach to 2-3 alternatives. Include specific differentiators and pricing comparison.",
          priority: "required",
        },
        {
          description: "Missing competitive analysis",
          priority: "required",
        },
      ],
      reviewSummary: "Output lacks competitive context — needs revision.",
      reviewFindings: [
        {
          section: "recommendations",
          severity: "major",
          description: "Missing competitive analysis",
        },
        {
          section: "data",
          severity: "minor",
          description: "Recommendations lack specific metrics",
        },
      ],
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Revision feedback in prompt builder", () => {
  describe("structured revision feedback rendering", () => {
    it("renders <revision-feedback> section for revision tasks", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask();

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      expect(prompt.userMessage).toContain("<revision-feedback>");
      expect(prompt.userMessage).toContain("</revision-feedback>");
    });

    it("includes revision number", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask({ revisionCount: 2 });

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      expect(prompt.userMessage).toContain("revision #2");
    });

    it("includes review summary from director", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask();

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      expect(prompt.userMessage).toContain("Output lacks competitive context");
    });

    it("renders structured revision feedback items", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask();

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      expect(prompt.userMessage).toContain("Required changes:");
      expect(prompt.userMessage).toContain("competitive analysis section");
      expect(prompt.userMessage).toContain("[required]");
    });

    it("renders review findings with severity and section", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask();

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      expect(prompt.userMessage).toContain("Issues found in previous output:");
      expect(prompt.userMessage).toContain("[major] recommendations:");
      expect(prompt.userMessage).toContain("[minor] data:");
    });

    it("includes revision instruction about preserving good content", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask();

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      expect(prompt.userMessage).toContain("Keep everything that was good");
      expect(prompt.userMessage).toContain("only fix what was flagged");
    });
  });

  describe("original requirements preservation", () => {
    it("uses original requirements (not revision-prefixed) in <task-requirements>", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask();

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      // <task-requirements> should contain the original requirements, not "REVISION REQUESTED"
      const reqMatch = prompt.userMessage.match(
        /<task-requirements>\n([\s\S]*?)\n<\/task-requirements>/,
      );
      expect(reqMatch).not.toBeNull();
      expect(reqMatch![1]).toBe("Audit the signup page for conversion issues");
      expect(reqMatch![1]).not.toContain("REVISION REQUESTED");
    });

    it("preserves original requirements across multiple revisions", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      // Simulate a second revision — originalRequirements stays the same
      const task = createRevisionTask({
        revisionCount: 2,
        requirements: "REVISION REQUESTED:\n- [required] More detail\n\nOriginal requirements: Audit the signup page for conversion issues",
        metadata: {
          originalTaskId: "page-cro-20260219-abc123",
          revisionOf: "page-cro-20260219-def456",
          originalRequirements: "Audit the signup page for conversion issues",
          revisionFeedback: [
            { description: "Need more detail in recommendations", priority: "required" },
          ],
          reviewSummary: "Recommendations still too vague.",
          reviewFindings: [],
        },
      });

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      const reqMatch = prompt.userMessage.match(
        /<task-requirements>\n([\s\S]*?)\n<\/task-requirements>/,
      );
      expect(reqMatch![1]).toBe("Audit the signup page for conversion issues");
    });
  });

  describe("ordering: requirements → feedback → previous output", () => {
    it("places revision feedback between requirements and previous output", async () => {
      // Write previous output so it gets included
      await tw.workspace.writeFile(
        "outputs/convert/page-cro/page-cro-20260219-abc123.md",
        "# Previous Audit\n\nThis was the first attempt.",
      );

      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask();

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      const reqIdx = prompt.userMessage.indexOf("<task-requirements>");
      const feedbackIdx = prompt.userMessage.indexOf("<revision-feedback>");
      const prevOutputIdx = prompt.userMessage.indexOf("<previous-output>");

      expect(reqIdx).toBeGreaterThanOrEqual(0);
      expect(feedbackIdx).toBeGreaterThan(reqIdx);
      expect(prevOutputIdx).toBeGreaterThan(feedbackIdx);
    });
  });

  describe("backward compatibility", () => {
    it("falls back to extracting feedback from requirements when no metadata", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      // Task without structured metadata (legacy format)
      const task = createRevisionTask({
        metadata: {
          originalTaskId: "page-cro-20260219-abc123",
          revisionOf: "page-cro-20260219-abc123",
        },
      });

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      // Should still render revision feedback, extracted from requirements
      expect(prompt.userMessage).toContain("<revision-feedback>");
      expect(prompt.userMessage).toContain("Required changes:");
      expect(prompt.userMessage).toContain("Add competitive analysis section");
    });

    it("does NOT render revision feedback for non-revision tasks", async () => {
      const meta = await loadSkillMeta("page-cro", PROJECT_ROOT);
      const task = createRevisionTask({
        revisionCount: 0,
        metadata: {},
      });

      const prompt = await buildAgentPrompt(
        task,
        meta,
        tw.workspace,
        PROJECT_ROOT,
      );

      expect(prompt.userMessage).not.toContain("<revision-feedback>");
    });
  });
});

describe("Review engine revision task metadata", () => {
  // These tests verify that the ReviewEngine produces revision tasks
  // with the correct structured metadata for the prompt builder.

  it("revision task from semantic review includes structured metadata", async () => {
    const { ReviewEngine } = await import("../../director/review-engine.ts");
    const { MODEL_MAP } = await import("../claude-client.ts");
    const { DEFAULT_DIRECTOR_CONFIG } = await import("../../director/types.ts");
    const { createTestTask, createTestOutput } = await import(
      "../../director/__tests__/helpers.ts"
    );

    type ClaudeClient = import("../claude-client.ts").ClaudeClient;
    const mockClient: ClaudeClient = {
      createMessage: async () => ({
        content: JSON.stringify({
          verdict: "REVISE",
          findings: [
            { section: "content", severity: "major", description: "Missing competitive analysis" },
          ],
          revisionInstructions: "Add a competitive analysis section with 2-3 alternatives.",
          summary: "Needs competitive context.",
        }),
        model: MODEL_MAP.opus,
        inputTokens: 5000,
        outputTokens: 500,
        stopReason: "end_turn",
        durationMs: 3000,
      }),
    };

    const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, mockClient);
    const task = createTestTask({ next: { type: "director_review" } });
    const output = createTestOutput();

    const result = await engine.evaluateTaskSemantic(
      task,
      output,
      [],
      undefined,
      { depth: "standard" },
    );

    expect(result.decision.action).toBe("revise");
    expect(result.decision.nextTasks.length).toBe(1);

    const revisionTask = result.decision.nextTasks[0]!;
    // Structured metadata should be present
    expect(revisionTask.metadata.originalRequirements).toBe(task.requirements);
    expect(revisionTask.metadata.revisionOf).toBe(task.id);
    expect(revisionTask.metadata.reviewSummary).toBe("Needs competitive context.");

    // Revision feedback should be an array
    const feedback = revisionTask.metadata.revisionFeedback as Array<Record<string, string>>;
    expect(Array.isArray(feedback)).toBe(true);
    expect(feedback.length).toBeGreaterThan(0);
    expect(feedback.some(f => f.description.includes("competitive analysis section"))).toBe(true);

    // Review findings should be present
    const findings = revisionTask.metadata.reviewFindings as Array<Record<string, string>>;
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.some(f => f.description === "Missing competitive analysis")).toBe(true);
  });

  it("revision task preserves original requirements across multiple revisions", async () => {
    const { ReviewEngine } = await import("../../director/review-engine.ts");
    const { MODEL_MAP } = await import("../claude-client.ts");
    const { DEFAULT_DIRECTOR_CONFIG } = await import("../../director/types.ts");
    const { createTestTask, createTestOutput } = await import(
      "../../director/__tests__/helpers.ts"
    );

    type ClaudeClient = import("../claude-client.ts").ClaudeClient;
    const mockClient: ClaudeClient = {
      createMessage: async () => ({
        content: JSON.stringify({
          verdict: "REVISE",
          findings: [
            { section: "tone", severity: "major", description: "Tone is too casual" },
          ],
          revisionInstructions: "Use more professional tone.",
          summary: "Tone needs adjustment.",
        }),
        model: MODEL_MAP.opus,
        inputTokens: 5000,
        outputTokens: 500,
        stopReason: "end_turn",
        durationMs: 3000,
      }),
    };

    const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, mockClient);

    // Simulate a second-revision task (already has originalRequirements in metadata)
    const task = createTestTask({
      revisionCount: 1,
      requirements: "REVISION REQUESTED:\n- [required] Fix X\n\nOriginal requirements: Original task description",
      metadata: {
        originalRequirements: "Original task description",
        revisionOf: "prev-task-id",
      },
      next: { type: "director_review" },
    });
    const output = createTestOutput();

    const result = await engine.evaluateTaskSemantic(
      task,
      output,
      [],
      undefined,
      { depth: "standard" },
    );

    const revisionTask = result.decision.nextTasks[0]!;
    // Original requirements should be preserved, not the "REVISION REQUESTED" version
    expect(revisionTask.metadata.originalRequirements).toBe("Original task description");
    expect(revisionTask.revisionCount).toBe(2);
  });

  it("structural-only revision task includes findings in metadata", async () => {
    const { ReviewEngine } = await import("../../director/review-engine.ts");
    const { DEFAULT_DIRECTOR_CONFIG } = await import("../../director/types.ts");
    const { createTestTask } = await import(
      "../../director/__tests__/helpers.ts"
    );

    // No client → structural only
    const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG);
    const task = createTestTask({ next: { type: "director_review" } });
    // Short output triggers "major" structural finding
    const output = "ab";

    const result = engine.evaluateTask(task, output, []);

    expect(result.action).toBe("revise");
    expect(result.nextTasks.length).toBe(1);

    const revisionTask = result.nextTasks[0]!;
    // Structural review uses the old createRevisionTask path (no reviewSummary/reviewFindings)
    // But original requirements should still be preserved
    expect(revisionTask.metadata.originalRequirements).toBe(task.requirements);
  });
});
