import { describe, expect, it } from "bun:test";
import type { Task } from "../../types/task.ts";
import type { Review } from "../../types/review.ts";
import {
  parseFrontmatter,
  serializeTask,
  deserializeTask,
  serializeReview,
  deserializeReview,
  serializeLearningEntry,
} from "../markdown.ts";
import { WorkspaceError } from "../errors.ts";

// ── Test Fixtures ────────────────────────────────────────────────────────────

function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "copywriting-20260219-a1b2c3",
    createdAt: "2026-02-19T10:00:00.000Z",
    updatedAt: "2026-02-19T10:00:00.000Z",
    from: "director",
    to: "copywriting",
    priority: "P1",
    deadline: "2026-02-20T10:00:00.000Z",
    status: "pending",
    revisionCount: 0,
    goalId: "goal-signup-conversion",
    pipelineId: "pipeline-123",
    goal: "Rewrite signup page to increase conversions by 20%",
    inputs: [
      {
        path: "context/product-marketing-context.md",
        description: "Product positioning context",
      },
      {
        path: "outputs/convert/page-cro/audit-123.md",
        description: "CRO audit findings",
      },
    ],
    requirements:
      "Write compelling headline and subheadline for the signup page.\nFocus on benefits over features.\nInclude social proof section.",
    output: {
      path: "outputs/creative/copywriting/copywriting-20260219-a1b2c3.md",
      format: "Marketing copy with annotations",
    },
    next: { type: "director_review" },
    tags: ["signup", "conversion"],
    metadata: {},
    ...overrides,
  };
}

function createTestReview(): Review {
  return {
    id: "review-copywriting-20260219-a1b2c3-0",
    taskId: "copywriting-20260219-a1b2c3",
    createdAt: "2026-02-19T12:00:00.000Z",
    reviewer: "director",
    author: "copywriting",
    verdict: "REVISE",
    summary: "Good direction but headline needs more punch.",
    findings: [
      {
        section: "Headline",
        severity: "major",
        description: "Headline is too generic, needs specificity",
      },
      {
        section: "Social proof",
        severity: "minor",
        description: "Add specific numbers to testimonials",
      },
    ],
    revisionRequests: [
      {
        description: "Rewrite headline with specific benefit metric",
        priority: "required",
      },
      {
        description: "Consider adding a guarantee statement",
        priority: "recommended",
      },
    ],
  };
}

// ── parseFrontmatter ─────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("parses simple key-value frontmatter", () => {
    const md = `---\nid: test-123\nstatus: pending\n---\n\n# Body`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter["id"]).toBe("test-123");
    expect(result.frontmatter["status"]).toBe("pending");
    expect(result.body).toBe("# Body");
  });

  it("handles values containing colons", () => {
    const md = `---\ngoal: Increase signups: target 20% growth\n---\n\nBody`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter["goal"]).toBe(
      "Increase signups: target 20% growth",
    );
  });

  it("returns empty frontmatter when no --- markers", () => {
    const result = parseFrontmatter("# Just a heading\n\nSome content");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("# Just a heading\n\nSome content");
  });

  it("throws on malformed frontmatter (missing closing ---)", () => {
    expect(() => parseFrontmatter("---\nid: test\nNo closing")).toThrow(
      WorkspaceError,
    );
  });

  it("handles empty frontmatter", () => {
    const result = parseFrontmatter("---\n---\n\nBody content");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Body content");
  });

  it("trims whitespace from keys and values", () => {
    const md = `---\n  id  :  test-123  \n---\n\nBody`;
    const result = parseFrontmatter(md);
    expect(result.frontmatter["id"]).toBe("test-123");
  });
});

// ── Task Serialization ───────────────────────────────────────────────────────

describe("serializeTask", () => {
  it("produces markdown with YAML frontmatter", () => {
    const task = createTestTask();
    const md = serializeTask(task);

    expect(md).toContain("---");
    expect(md).toContain("id: copywriting-20260219-a1b2c3");
    expect(md).toContain("status: pending");
    expect(md).toContain("priority: P1");
    expect(md).toContain("# Task: copywriting-20260219-a1b2c3");
  });

  it("includes all assignment fields", () => {
    const md = serializeTask(createTestTask());
    expect(md).toContain("**From:** director");
    expect(md).toContain("**To:** copywriting");
    expect(md).toContain("**Priority:** P1");
  });

  it("includes input files", () => {
    const md = serializeTask(createTestTask());
    expect(md).toContain("context/product-marketing-context.md");
    expect(md).toContain("Product positioning context");
  });

  it("includes requirements", () => {
    const md = serializeTask(createTestTask());
    expect(md).toContain("Write compelling headline");
    expect(md).toContain("Focus on benefits over features");
  });

  it("formats next as director_review", () => {
    const md = serializeTask(createTestTask({ next: { type: "director_review" } }));
    expect(md).toContain("Return to Director for review");
  });

  it("formats next as agent", () => {
    const md = serializeTask(
      createTestTask({ next: { type: "agent", skill: "copy-editing" } }),
    );
    expect(md).toContain("Send to copy-editing");
  });

  it("formats next as complete", () => {
    const md = serializeTask(createTestTask({ next: { type: "complete" } }));
    expect(md).toContain("Task complete");
  });

  it("omits deadline in frontmatter when null", () => {
    const md = serializeTask(createTestTask({ deadline: null }));
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter["deadline"]).toBeUndefined();
  });

  it("serializes tags", () => {
    const md = serializeTask(createTestTask({ tags: ["signup", "conversion"] }));
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter["tags"]).toBe("signup, conversion");
  });

  it("omits tags line when empty", () => {
    const md = serializeTask(createTestTask({ tags: [] }));
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter["tags"]).toBeUndefined();
  });
});

describe("deserializeTask", () => {
  it("round-trips a task through serialize/deserialize", () => {
    const original = createTestTask();
    const md = serializeTask(original);
    const restored = deserializeTask(md);

    expect(restored.id).toBe(original.id);
    expect(restored.status).toBe(original.status);
    expect(restored.priority).toBe(original.priority);
    expect(restored.from).toBe(original.from);
    expect(restored.to).toBe(original.to);
    expect(restored.createdAt).toBe(original.createdAt);
    expect(restored.updatedAt).toBe(original.updatedAt);
    expect(restored.deadline).toBe(original.deadline);
    expect(restored.goalId).toBe(original.goalId);
    expect(restored.pipelineId).toBe(original.pipelineId);
    expect(restored.revisionCount).toBe(original.revisionCount);
    expect(restored.output.path).toBe(original.output.path);
    expect(restored.output.format).toBe(original.output.format);
    expect(restored.next).toEqual(original.next);
    expect(restored.tags).toEqual(["signup", "conversion"]);
  });

  it("preserves multi-line requirements", () => {
    const task = createTestTask({
      requirements:
        "Line 1\nLine 2\n\n```code\nblock\n```\n\nLine after code",
    });
    const md = serializeTask(task);
    const restored = deserializeTask(md);
    expect(restored.requirements).toContain("Line 1");
    expect(restored.requirements).toContain("Line 2");
    expect(restored.requirements).toContain("```code");
  });

  it("parses input files correctly", () => {
    const original = createTestTask();
    const md = serializeTask(original);
    const restored = deserializeTask(md);

    expect(restored.inputs).toHaveLength(2);
    expect(restored.inputs[0]!.path).toBe(
      "context/product-marketing-context.md",
    );
    expect(restored.inputs[0]!.description).toBe(
      "Product positioning context",
    );
  });

  it("handles null deadline", () => {
    const task = createTestTask({ deadline: null });
    const md = serializeTask(task);
    const restored = deserializeTask(md);
    expect(restored.deadline).toBeNull();
  });

  it("handles null goalId and pipelineId", () => {
    const task = createTestTask({ goalId: null, pipelineId: null });
    const md = serializeTask(task);
    const restored = deserializeTask(md);
    expect(restored.goalId).toBeNull();
    expect(restored.pipelineId).toBeNull();
  });

  it("throws on missing required frontmatter field", () => {
    const md = "---\nid: test\n---\n\n# Body";
    expect(() => deserializeTask(md)).toThrow(WorkspaceError);
  });

  it("throws on invalid priority", () => {
    const task = createTestTask();
    const md = serializeTask(task).replace("priority: P1", "priority: P9");
    expect(() => deserializeTask(md)).toThrow(WorkspaceError);
  });

  it("throws on invalid status", () => {
    const task = createTestTask();
    const md = serializeTask(task).replace(
      "status: pending",
      "status: unknown",
    );
    expect(() => deserializeTask(md)).toThrow(WorkspaceError);
  });

  it("deserializes next type: agent", () => {
    const task = createTestTask({
      next: { type: "agent", skill: "copy-editing" },
    });
    const md = serializeTask(task);
    const restored = deserializeTask(md);
    expect(restored.next).toEqual({ type: "agent", skill: "copy-editing" });
  });

  it("deserializes next type: pipeline_continue", () => {
    const task = createTestTask({
      next: { type: "pipeline_continue", pipelineId: "pipe-1" },
    });
    const md = serializeTask(task);
    const restored = deserializeTask(md);
    expect(restored.next).toEqual({
      type: "pipeline_continue",
      pipelineId: "pipe-1",
    });
  });

  it("deserializes next type: complete", () => {
    const task = createTestTask({ next: { type: "complete" } });
    const md = serializeTask(task);
    const restored = deserializeTask(md);
    expect(restored.next).toEqual({ type: "complete" });
  });
});

// ── Review Serialization ─────────────────────────────────────────────────────

describe("serializeReview", () => {
  it("produces markdown with frontmatter", () => {
    const review = createTestReview();
    const md = serializeReview(review);

    expect(md).toContain("---");
    expect(md).toContain("verdict: REVISE");
    expect(md).toContain("# Review: copywriting-20260219-a1b2c3");
    expect(md).toContain("**Verdict:** REVISE");
  });

  it("includes findings with severity", () => {
    const md = serializeReview(createTestReview());
    expect(md).toContain("[major]");
    expect(md).toContain("[minor]");
    expect(md).toContain("Headline is too generic");
  });

  it("includes revision requests with priority", () => {
    const md = serializeReview(createTestReview());
    expect(md).toContain("[required]");
    expect(md).toContain("[recommended]");
    expect(md).toContain("Rewrite headline");
  });
});

describe("deserializeReview", () => {
  it("round-trips a review through serialize/deserialize", () => {
    const original = createTestReview();
    const md = serializeReview(original);
    const restored = deserializeReview(md);

    expect(restored.id).toBe(original.id);
    expect(restored.taskId).toBe(original.taskId);
    expect(restored.reviewer).toBe(original.reviewer);
    expect(restored.author).toBe(original.author);
    expect(restored.verdict).toBe(original.verdict);
    expect(restored.summary).toBe(original.summary);
  });

  it("preserves findings", () => {
    const original = createTestReview();
    const md = serializeReview(original);
    const restored = deserializeReview(md);

    expect(restored.findings).toHaveLength(2);
    expect(restored.findings[0]!.severity).toBe("major");
    expect(restored.findings[0]!.section).toBe("Headline");
  });

  it("preserves revision requests", () => {
    const original = createTestReview();
    const md = serializeReview(original);
    const restored = deserializeReview(md);

    expect(restored.revisionRequests).toHaveLength(2);
    expect(restored.revisionRequests[0]!.priority).toBe("required");
  });

  it("handles review with no findings", () => {
    const review = { ...createTestReview(), findings: [], verdict: "APPROVE" as const };
    const md = serializeReview(review);
    const restored = deserializeReview(md);
    expect(restored.findings).toHaveLength(0);
  });

  it("handles review with no revision requests", () => {
    const review = {
      ...createTestReview(),
      revisionRequests: [],
      verdict: "APPROVE" as const,
    };
    const md = serializeReview(review);
    const restored = deserializeReview(md);
    expect(restored.revisionRequests).toHaveLength(0);
  });
});

// ── Learning Entry ───────────────────────────────────────────────────────────

describe("serializeLearningEntry", () => {
  it("produces formatted markdown entry", () => {
    const entry = {
      timestamp: "2026-02-19T12:00:00.000Z",
      agent: "copywriting" as const,
      goalId: "goal-123",
      outcome: "success" as const,
      learning: "Short headlines convert better than long ones",
      actionTaken: "Default to 6-word headlines going forward",
    };

    const md = serializeLearningEntry(entry);
    expect(md).toContain("### 2026-02-19T12:00:00.000Z");
    expect(md).toContain("**Agent:** copywriting");
    expect(md).toContain("**Goal:** goal-123");
    expect(md).toContain("**Outcome:** success");
    expect(md).toContain("**Learning:** Short headlines");
    expect(md).toContain("**Action:** Default to 6-word");
  });

  it("omits goalId when null", () => {
    const entry = {
      timestamp: "2026-02-19T12:00:00.000Z",
      agent: "director" as const,
      goalId: null,
      outcome: "partial" as const,
      learning: "Some learning",
      actionTaken: "Some action",
    };

    const md = serializeLearningEntry(entry);
    expect(md).not.toContain("**Goal:**");
  });
});
