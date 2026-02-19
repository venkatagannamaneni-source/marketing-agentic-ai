import { describe, expect, it } from "bun:test";
import { buildPrompt } from "../prompt-builder.ts";
import type { BuildPromptParams, UpstreamOutput } from "../prompt-builder.ts";
import type { Task } from "../../types/task.ts";
import type { SkillContent } from "../types.ts";

function makeSkillContent(overrides?: Partial<SkillContent>): SkillContent {
  return {
    name: "copywriting",
    description: "Write marketing copy",
    version: "1.0.0",
    squad: "creative",
    skillFilePath: "/path/to/SKILL.md",
    referenceFiles: [],
    body: "You are an expert conversion copywriter.\n\n## Principles\n\nClarity over cleverness.",
    referenceContents: [],
    ...overrides,
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "copywriting-20260219-abc123",
    createdAt: "2026-02-19T10:00:00Z",
    updatedAt: "2026-02-19T10:00:00Z",
    from: "director",
    to: "copywriting",
    priority: "P1",
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: "goal-1",
    pipelineId: null,
    goal: "Increase signup conversion by 20%",
    inputs: [],
    requirements: "Write compelling headline copy for the signup landing page.",
    output: {
      path: "outputs/creative/copywriting/copywriting-20260219-abc123.md",
      format: "markdown",
    },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("builds prompt with full context", () => {
    const upstreamOutputs: UpstreamOutput[] = [
      {
        path: "outputs/strategy/content-strategy/task-1.md",
        description: "Content strategy document",
        content: "# Content Strategy\n\nFocus on developer audience.",
      },
    ];

    const { systemPrompt, userMessage } = buildPrompt({
      skillContent: makeSkillContent(),
      task: makeTask(),
      productContext: "# Product Context\n\nWe build dev tools.",
      upstreamOutputs,
    });

    // System prompt contains skill body
    expect(systemPrompt).toContain("expert conversion copywriter");
    expect(systemPrompt).toContain("Clarity over cleverness");

    // User message contains product context
    expect(userMessage).toContain("We build dev tools");

    // User message contains task details
    expect(userMessage).toContain("copywriting-20260219-abc123");
    expect(userMessage).toContain("director");
    expect(userMessage).toContain("P1");
    expect(userMessage).toContain("Increase signup conversion by 20%");

    // User message contains upstream inputs
    expect(userMessage).toContain("Content strategy document");
    expect(userMessage).toContain("Focus on developer audience");

    // User message contains requirements
    expect(userMessage).toContain(
      "Write compelling headline copy for the signup landing page",
    );

    // User message contains output instructions
    expect(userMessage).toContain("Format: markdown");
  });

  it("includes reference content in system prompt", () => {
    const skill = makeSkillContent({
      referenceContents: [
        {
          path: "copy-frameworks.md",
          content: "# Headline Formulas\n\n1. Problem-Agitate-Solve",
        },
        {
          path: "transitions.md",
          content: "# Transitions\n\nBut here's the thing...",
        },
      ],
    });

    const { systemPrompt } = buildPrompt({
      skillContent: skill,
      task: makeTask(),
      productContext: null,
      upstreamOutputs: [],
    });

    expect(systemPrompt).toContain("## Reference: copy-frameworks.md");
    expect(systemPrompt).toContain("Problem-Agitate-Solve");
    expect(systemPrompt).toContain("## Reference: transitions.md");
    expect(systemPrompt).toContain("But here's the thing");
  });

  it("handles no product context", () => {
    const { userMessage } = buildPrompt({
      skillContent: makeSkillContent(),
      task: makeTask(),
      productContext: null,
      upstreamOutputs: [],
    });

    expect(userMessage).toContain(
      "No product marketing context available",
    );
  });

  it("handles no upstream inputs", () => {
    const { userMessage } = buildPrompt({
      skillContent: makeSkillContent(),
      task: makeTask(),
      productContext: "Some context",
      upstreamOutputs: [],
    });

    expect(userMessage).toContain("No upstream inputs for this task");
  });

  it("handles multiple upstream inputs in order", () => {
    const upstreamOutputs: UpstreamOutput[] = [
      { path: "path/a.md", description: "First input", content: "Content A" },
      { path: "path/b.md", description: "Second input", content: "Content B" },
      { path: "path/c.md", description: "Third input", content: "Content C" },
    ];

    const { userMessage } = buildPrompt({
      skillContent: makeSkillContent(),
      task: makeTask(),
      productContext: null,
      upstreamOutputs,
    });

    const posA = userMessage.indexOf("First input");
    const posB = userMessage.indexOf("Second input");
    const posC = userMessage.indexOf("Third input");

    expect(posA).toBeLessThan(posB);
    expect(posB).toBeLessThan(posC);

    expect(userMessage).toContain("Content A");
    expect(userMessage).toContain("Content B");
    expect(userMessage).toContain("Content C");
  });

  it("includes revision context when revisionCount > 0", () => {
    const task = makeTask({ revisionCount: 2 });

    const { userMessage } = buildPrompt({
      skillContent: makeSkillContent(),
      task,
      productContext: null,
      upstreamOutputs: [],
    });

    expect(userMessage).toContain("## Revision Context");
    expect(userMessage).toContain("revision #2");
    expect(userMessage).toContain("review feedback");
  });

  it("does not include revision context when revisionCount is 0", () => {
    const task = makeTask({ revisionCount: 0 });

    const { userMessage } = buildPrompt({
      skillContent: makeSkillContent(),
      task,
      productContext: null,
      upstreamOutputs: [],
    });

    expect(userMessage).not.toContain("Revision Context");
  });

  it("handles empty skill body", () => {
    const skill = makeSkillContent({ body: "" });

    const { systemPrompt } = buildPrompt({
      skillContent: skill,
      task: makeTask(),
      productContext: null,
      upstreamOutputs: [],
    });

    // Empty body means empty system prompt (no references either)
    expect(systemPrompt).toBe("");
  });

  it("handles empty skill body with references", () => {
    const skill = makeSkillContent({
      body: "",
      referenceContents: [
        { path: "ref.md", content: "Reference content" },
      ],
    });

    const { systemPrompt } = buildPrompt({
      skillContent: skill,
      task: makeTask(),
      productContext: null,
      upstreamOutputs: [],
    });

    expect(systemPrompt).toContain("## Reference: ref.md");
    expect(systemPrompt).toContain("Reference content");
  });

  it("includes output format in instructions", () => {
    const task = makeTask({
      output: { path: "some/path.md", format: "structured JSON" },
    });

    const { userMessage } = buildPrompt({
      skillContent: makeSkillContent(),
      task,
      productContext: null,
      upstreamOutputs: [],
    });

    expect(userMessage).toContain("Format: structured JSON");
  });

  it("preserves full requirements text including markdown", () => {
    const task = makeTask({
      requirements:
        "Write copy with:\n\n1. A headline\n2. A subheadline\n3. Three bullet points\n\n```\nExample format\n```",
    });

    const { userMessage } = buildPrompt({
      skillContent: makeSkillContent(),
      task,
      productContext: null,
      upstreamOutputs: [],
    });

    expect(userMessage).toContain("1. A headline");
    expect(userMessage).toContain("```\nExample format\n```");
  });
});
