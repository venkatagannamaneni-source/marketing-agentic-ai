import { describe, expect, it } from "bun:test";
import type { Task } from "../../types/task.ts";
import type { Review } from "../../types/review.ts";
import { validateTask, validateReview } from "../validation.ts";
import { WorkspaceError } from "../errors.ts";

// ── Test Fixtures ────────────────────────────────────────────────────────────

function validTask(): Task {
  return {
    id: "copywriting-20260219-a1b2c3",
    createdAt: "2026-02-19T10:00:00.000Z",
    updatedAt: "2026-02-19T10:00:00.000Z",
    from: "director",
    to: "copywriting",
    priority: "P1",
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: null,
    pipelineId: null,
    goal: "Rewrite signup page",
    inputs: [
      { path: "context/product-marketing-context.md", description: "Context" },
    ],
    requirements: "Write compelling copy",
    output: {
      path: "outputs/creative/copywriting/task.md",
      format: "Marketing copy",
    },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
  };
}

function validReview(): Review {
  return {
    id: "review-copywriting-20260219-a1b2c3-0",
    taskId: "copywriting-20260219-a1b2c3",
    createdAt: "2026-02-19T12:00:00.000Z",
    reviewer: "director",
    author: "copywriting",
    verdict: "APPROVE",
    summary: "Looks good.",
    findings: [],
    revisionRequests: [],
  };
}

// ── validateTask ─────────────────────────────────────────────────────────────

describe("validateTask", () => {
  it("accepts a valid task", () => {
    expect(() => validateTask(validTask())).not.toThrow();
  });

  it("rejects null", () => {
    expect(() => validateTask(null)).toThrow(WorkspaceError);
  });

  it("rejects undefined", () => {
    expect(() => validateTask(undefined)).toThrow(WorkspaceError);
  });

  it("rejects a string", () => {
    expect(() => validateTask("not a task")).toThrow(WorkspaceError);
  });

  it("rejects a number", () => {
    expect(() => validateTask(42)).toThrow(WorkspaceError);
  });

  // ── Required string fields ──

  for (const field of ["id", "createdAt", "updatedAt", "goal", "requirements"]) {
    it(`rejects missing ${field}`, () => {
      const task = { ...validTask(), [field]: undefined };
      expect(() => validateTask(task)).toThrow(WorkspaceError);
    });

    it(`rejects empty string ${field}`, () => {
      const task = { ...validTask(), [field]: "" };
      expect(() => validateTask(task)).toThrow(WorkspaceError);
    });

    it(`rejects non-string ${field}`, () => {
      const task = { ...validTask(), [field]: 123 };
      expect(() => validateTask(task)).toThrow(WorkspaceError);
    });
  }

  // ── Enum fields ──

  it("rejects invalid from value", () => {
    const task = { ...validTask(), from: "unknown-agent" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts all valid from values", () => {
    for (const from of ["director", "scheduler", "event-bus", "copywriting", "page-cro"]) {
      expect(() => validateTask({ ...validTask(), from })).not.toThrow();
    }
  });

  it("rejects invalid to value", () => {
    const task = { ...validTask(), to: "not-a-skill" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects invalid priority", () => {
    const task = { ...validTask(), priority: "P9" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts all valid priorities", () => {
    for (const priority of ["P0", "P1", "P2", "P3"]) {
      expect(() => validateTask({ ...validTask(), priority })).not.toThrow();
    }
  });

  it("rejects invalid status", () => {
    const task = { ...validTask(), status: "invalid" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts all valid statuses", () => {
    for (const status of [
      "pending", "assigned", "in_progress", "completed",
      "in_review", "revision", "approved", "failed",
      "blocked", "cancelled", "deferred",
    ]) {
      expect(() => validateTask({ ...validTask(), status })).not.toThrow();
    }
  });

  // ── revisionCount ──

  it("rejects non-number revisionCount", () => {
    const task = { ...validTask(), revisionCount: "zero" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects NaN revisionCount", () => {
    const task = { ...validTask(), revisionCount: NaN };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects negative revisionCount", () => {
    const task = { ...validTask(), revisionCount: -1 };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts zero revisionCount", () => {
    expect(() => validateTask({ ...validTask(), revisionCount: 0 })).not.toThrow();
  });

  it("accepts positive revisionCount", () => {
    expect(() => validateTask({ ...validTask(), revisionCount: 3 })).not.toThrow();
  });

  // ── Nullable fields ──

  it("accepts null deadline", () => {
    expect(() => validateTask({ ...validTask(), deadline: null })).not.toThrow();
  });

  it("accepts string deadline", () => {
    expect(() =>
      validateTask({ ...validTask(), deadline: "2026-03-01T00:00:00Z" }),
    ).not.toThrow();
  });

  it("rejects non-string non-null deadline", () => {
    const task = { ...validTask(), deadline: 12345 };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts null goalId", () => {
    expect(() => validateTask({ ...validTask(), goalId: null })).not.toThrow();
  });

  it("rejects non-string non-null goalId", () => {
    const task = { ...validTask(), goalId: 42 };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts null pipelineId", () => {
    expect(() => validateTask({ ...validTask(), pipelineId: null })).not.toThrow();
  });

  it("rejects non-string non-null pipelineId", () => {
    const task = { ...validTask(), pipelineId: true };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  // ── Inputs array ──

  it("rejects non-array inputs", () => {
    const task = { ...validTask(), inputs: "not-array" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts empty inputs array", () => {
    expect(() => validateTask({ ...validTask(), inputs: [] })).not.toThrow();
  });

  it("rejects input with missing path", () => {
    const task = {
      ...validTask(),
      inputs: [{ description: "desc" }],
    };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects input with missing description", () => {
    const task = {
      ...validTask(),
      inputs: [{ path: "/some/path" }],
    };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects null input entry", () => {
    const task = { ...validTask(), inputs: [null] };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  // ── Output object ──

  it("rejects non-object output", () => {
    const task = { ...validTask(), output: "string" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects output with missing path", () => {
    const task = { ...validTask(), output: { format: "md" } };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects output with missing format", () => {
    const task = { ...validTask(), output: { path: "/out.md" } };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects null output", () => {
    const task = { ...validTask(), output: null };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  // ── Next object ──

  it("rejects non-object next", () => {
    const task = { ...validTask(), next: "complete" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects null next", () => {
    const task = { ...validTask(), next: null };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects invalid next type", () => {
    const task = { ...validTask(), next: { type: "invalid" } };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts all valid next types", () => {
    expect(() =>
      validateTask({ ...validTask(), next: { type: "director_review" } }),
    ).not.toThrow();
    expect(() =>
      validateTask({ ...validTask(), next: { type: "complete" } }),
    ).not.toThrow();
    expect(() =>
      validateTask({
        ...validTask(),
        next: { type: "agent", skill: "copywriting" },
      }),
    ).not.toThrow();
    expect(() =>
      validateTask({
        ...validTask(),
        next: { type: "pipeline_continue", pipelineId: "pipe-1" },
      }),
    ).not.toThrow();
  });

  it("rejects agent next without skill", () => {
    const task = { ...validTask(), next: { type: "agent" } };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects agent next with invalid skill", () => {
    const task = {
      ...validTask(),
      next: { type: "agent", skill: "nonexistent-skill" },
    };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects pipeline_continue next without pipelineId", () => {
    const task = { ...validTask(), next: { type: "pipeline_continue" } };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  // ── Tags & metadata ──

  it("rejects non-array tags", () => {
    const task = { ...validTask(), tags: "tag" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects non-object metadata", () => {
    const task = { ...validTask(), metadata: "meta" };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("rejects array metadata", () => {
    const task = { ...validTask(), metadata: [1, 2] };
    expect(() => validateTask(task)).toThrow(WorkspaceError);
  });

  it("accepts task with populated metadata", () => {
    expect(() =>
      validateTask({ ...validTask(), metadata: { key: "value" } }),
    ).not.toThrow();
  });
});

// ── validateReview ───────────────────────────────────────────────────────────

describe("validateReview", () => {
  it("accepts a valid review", () => {
    expect(() => validateReview(validReview())).not.toThrow();
  });

  it("rejects null", () => {
    expect(() => validateReview(null)).toThrow(WorkspaceError);
  });

  it("rejects undefined", () => {
    expect(() => validateReview(undefined)).toThrow(WorkspaceError);
  });

  it("rejects a non-object", () => {
    expect(() => validateReview(42)).toThrow(WorkspaceError);
  });

  // ── Required string fields ──

  for (const field of ["id", "taskId", "createdAt", "summary"]) {
    it(`rejects missing ${field}`, () => {
      const review = { ...validReview(), [field]: undefined };
      expect(() => validateReview(review)).toThrow(WorkspaceError);
    });

    it(`rejects empty string ${field}`, () => {
      const review = { ...validReview(), [field]: "" };
      expect(() => validateReview(review)).toThrow(WorkspaceError);
    });
  }

  // ── Enum fields ──

  it("rejects invalid reviewer", () => {
    const review = { ...validReview(), reviewer: "not-a-reviewer" };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("accepts director as reviewer", () => {
    expect(() =>
      validateReview({ ...validReview(), reviewer: "director" }),
    ).not.toThrow();
  });

  it("accepts a skill name as reviewer", () => {
    expect(() =>
      validateReview({ ...validReview(), reviewer: "copy-editing" }),
    ).not.toThrow();
  });

  it("rejects invalid author", () => {
    const review = { ...validReview(), author: "director" };
    // director is not in SKILL_NAMES, so it's invalid as author
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("accepts a valid skill as author", () => {
    expect(() =>
      validateReview({ ...validReview(), author: "page-cro" }),
    ).not.toThrow();
  });

  it("rejects invalid verdict", () => {
    const review = { ...validReview(), verdict: "MAYBE" };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("accepts all valid verdicts", () => {
    for (const verdict of ["APPROVE", "REVISE", "REJECT"]) {
      expect(() =>
        validateReview({ ...validReview(), verdict }),
      ).not.toThrow();
    }
  });

  // ── Findings array ──

  it("rejects non-array findings", () => {
    const review = { ...validReview(), findings: "not-array" };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("accepts empty findings array", () => {
    expect(() =>
      validateReview({ ...validReview(), findings: [] }),
    ).not.toThrow();
  });

  it("accepts review with valid findings", () => {
    const review = {
      ...validReview(),
      findings: [
        { section: "Headline", severity: "critical", description: "Missing" },
        { section: "CTA", severity: "suggestion", description: "Could be better" },
      ],
    };
    expect(() => validateReview(review)).not.toThrow();
  });

  it("rejects finding with missing section", () => {
    const review = {
      ...validReview(),
      findings: [{ severity: "major", description: "desc" }],
    };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("rejects finding with invalid severity", () => {
    const review = {
      ...validReview(),
      findings: [
        { section: "Headline", severity: "extreme", description: "bad" },
      ],
    };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("rejects finding with missing description", () => {
    const review = {
      ...validReview(),
      findings: [{ section: "Headline", severity: "major" }],
    };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("rejects null finding entry", () => {
    const review = { ...validReview(), findings: [null] };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("accepts all valid finding severities", () => {
    for (const severity of ["critical", "major", "minor", "suggestion"]) {
      const review = {
        ...validReview(),
        findings: [{ section: "Test", severity, description: "desc" }],
      };
      expect(() => validateReview(review)).not.toThrow();
    }
  });

  // ── Revision requests array ──

  it("rejects non-array revisionRequests", () => {
    const review = { ...validReview(), revisionRequests: "not-array" };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("accepts empty revisionRequests array", () => {
    expect(() =>
      validateReview({ ...validReview(), revisionRequests: [] }),
    ).not.toThrow();
  });

  it("accepts review with valid revision requests", () => {
    const review = {
      ...validReview(),
      revisionRequests: [
        { description: "Fix headline", priority: "required" },
        { description: "Improve CTA", priority: "optional" },
      ],
    };
    expect(() => validateReview(review)).not.toThrow();
  });

  it("rejects revision request with missing description", () => {
    const review = {
      ...validReview(),
      revisionRequests: [{ priority: "required" }],
    };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("rejects revision request with invalid priority", () => {
    const review = {
      ...validReview(),
      revisionRequests: [{ description: "Fix", priority: "urgent" }],
    };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("rejects null revision request entry", () => {
    const review = { ...validReview(), revisionRequests: [null] };
    expect(() => validateReview(review)).toThrow(WorkspaceError);
  });

  it("accepts all valid revision request priorities", () => {
    for (const priority of ["required", "recommended", "optional"]) {
      const review = {
        ...validReview(),
        revisionRequests: [{ description: "Fix", priority }],
      };
      expect(() => validateReview(review)).not.toThrow();
    }
  });
});
