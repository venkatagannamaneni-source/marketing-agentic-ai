import { describe, expect, it } from "bun:test";
import type { HumanReviewItem, HumanFeedback } from "../../types/human-review.ts";
import {
  serializeHumanReview,
  deserializeHumanReview,
} from "../human-review-markdown.ts";
import { WorkspaceError } from "../errors.ts";

// ── Test Fixtures ────────────────────────────────────────────────────────────

function createTestReviewItem(
  overrides: Partial<HumanReviewItem> = {},
): HumanReviewItem {
  return {
    id: "hr-page-cro-20260219-abc123-1708300000000",
    taskId: "page-cro-20260219-abc123",
    goalId: "goal-20260219-abc123",
    pipelineId: "pipeline-123",
    skill: "page-cro",
    createdAt: "2026-02-19T10:00:00.000Z",
    urgency: "high",
    status: "pending",
    escalationReason: "budget_threshold",
    escalationMessage: "Budget exceeded threshold",
    escalationContext: { spent: 900, total: 1000 },
    feedback: null,
    resolvedAt: null,
    metadata: {},
    ...overrides,
  };
}

function createTestFeedback(
  overrides: Partial<HumanFeedback> = {},
): HumanFeedback {
  return {
    decision: "approve",
    reviewer: "test-reviewer",
    notes: "Looks good overall",
    revisionInstructions: null,
    providedAt: "2026-02-19T12:00:00.000Z",
    ...overrides,
  };
}

// ── Serialization Tests ──────────────────────────────────────────────────────

describe("serializeHumanReview", () => {
  it("produces valid frontmatter with all required fields", () => {
    const item = createTestReviewItem();
    const md = serializeHumanReview(item);

    expect(md).toContain("---");
    expect(md).toContain(`id: ${item.id}`);
    expect(md).toContain(`task_id: ${item.taskId}`);
    expect(md).toContain(`goal_id: ${item.goalId}`);
    expect(md).toContain(`pipeline_id: ${item.pipelineId}`);
    expect(md).toContain(`skill: ${item.skill}`);
    expect(md).toContain(`urgency: ${item.urgency}`);
    expect(md).toContain(`status: ${item.status}`);
    expect(md).toContain(`escalation_reason: ${item.escalationReason}`);
  });

  it("serializes null goalId and pipelineId as string 'null'", () => {
    const item = createTestReviewItem({ goalId: null, pipelineId: null });
    const md = serializeHumanReview(item);

    expect(md).toContain("goal_id: null");
    expect(md).toContain("pipeline_id: null");
  });

  it("includes escalation message in body", () => {
    const item = createTestReviewItem({
      escalationMessage: "Custom escalation message",
    });
    const md = serializeHumanReview(item);

    expect(md).toContain("**Message:** Custom escalation message");
  });

  it("includes escalation context as JSON code block", () => {
    const item = createTestReviewItem({
      escalationContext: { key: "value", nested: { a: 1 } },
    });
    const md = serializeHumanReview(item);

    expect(md).toContain("## Escalation Context");
    expect(md).toContain("```json");
    expect(md).toContain('"key": "value"');
  });

  it("omits escalation context section when context is empty", () => {
    const item = createTestReviewItem({ escalationContext: {} });
    const md = serializeHumanReview(item);

    expect(md).not.toContain("## Escalation Context");
  });

  it("includes feedback section when feedback is present", () => {
    const feedback = createTestFeedback();
    const item = createTestReviewItem({ feedback });
    const md = serializeHumanReview(item);

    expect(md).toContain("## Human Feedback");
    expect(md).toContain(`feedback_decision: ${feedback.decision}`);
    expect(md).toContain(`feedback_reviewer: ${feedback.reviewer}`);
    expect(md).toContain(`**Decision:** ${feedback.decision}`);
    expect(md).toContain(`**Reviewer:** ${feedback.reviewer}`);
    expect(md).toContain("### Notes");
    expect(md).toContain(feedback.notes);
  });

  it("omits feedback section when feedback is null", () => {
    const item = createTestReviewItem({ feedback: null });
    const md = serializeHumanReview(item);

    expect(md).not.toContain("## Human Feedback");
    expect(md).not.toContain("feedback_decision:");
    expect(md).not.toContain("feedback_reviewer:");
  });

  it("includes revision instructions when present in feedback", () => {
    const feedback = createTestFeedback({
      decision: "revise",
      revisionInstructions: "Please improve the data section",
    });
    const item = createTestReviewItem({ feedback });
    const md = serializeHumanReview(item);

    expect(md).toContain("### Revision Instructions");
    expect(md).toContain("Please improve the data section");
  });

  it("omits revision instructions section when null", () => {
    const feedback = createTestFeedback({ revisionInstructions: null });
    const item = createTestReviewItem({ feedback });
    const md = serializeHumanReview(item);

    expect(md).not.toContain("### Revision Instructions");
  });

  it("includes resolved_at when present", () => {
    const item = createTestReviewItem({
      resolvedAt: "2026-02-19T14:00:00.000Z",
    });
    const md = serializeHumanReview(item);

    expect(md).toContain("resolved_at: 2026-02-19T14:00:00.000Z");
  });

  it("omits resolved_at when null", () => {
    const item = createTestReviewItem({ resolvedAt: null });
    const md = serializeHumanReview(item);

    expect(md).not.toContain("resolved_at:");
  });

  it("includes metadata when non-empty", () => {
    const item = createTestReviewItem({
      metadata: { priority: "high", source: "auto" },
    });
    const md = serializeHumanReview(item);

    expect(md).toContain("metadata:");
    expect(md).toContain("priority");
  });

  it("omits metadata when empty", () => {
    const item = createTestReviewItem({ metadata: {} });
    const md = serializeHumanReview(item);

    expect(md).not.toContain("metadata:");
  });
});

// ── Deserialization Tests ────────────────────────────────────────────────────

describe("deserializeHumanReview", () => {
  it("round-trips a pending item without feedback", () => {
    const item = createTestReviewItem();
    const md = serializeHumanReview(item);
    const restored = deserializeHumanReview(md);

    expect(restored.id).toBe(item.id);
    expect(restored.taskId).toBe(item.taskId);
    expect(restored.goalId).toBe(item.goalId);
    expect(restored.pipelineId).toBe(item.pipelineId);
    expect(restored.skill).toBe(item.skill);
    expect(restored.urgency).toBe(item.urgency);
    expect(restored.status).toBe(item.status);
    expect(restored.escalationReason).toBe(item.escalationReason);
    expect(restored.escalationMessage).toBe(item.escalationMessage);
    expect(restored.feedback).toBeNull();
    expect(restored.resolvedAt).toBeNull();
  });

  it("round-trips null goalId and pipelineId", () => {
    const item = createTestReviewItem({ goalId: null, pipelineId: null });
    const md = serializeHumanReview(item);
    const restored = deserializeHumanReview(md);

    expect(restored.goalId).toBeNull();
    expect(restored.pipelineId).toBeNull();
  });

  it("round-trips escalation context", () => {
    const ctx = { spent: 950, total: 1000, level: "critical" };
    const item = createTestReviewItem({ escalationContext: ctx });
    const md = serializeHumanReview(item);
    const restored = deserializeHumanReview(md);

    expect(restored.escalationContext).toEqual(ctx);
  });

  it("round-trips a resolved item with feedback", () => {
    const feedback = createTestFeedback();
    const item = createTestReviewItem({
      status: "resolved",
      feedback,
      resolvedAt: "2026-02-19T14:00:00.000Z",
    });
    const md = serializeHumanReview(item);
    const restored = deserializeHumanReview(md);

    expect(restored.status).toBe("resolved");
    expect(restored.resolvedAt).toBe("2026-02-19T14:00:00.000Z");
    expect(restored.feedback).not.toBeNull();
    expect(restored.feedback!.decision).toBe("approve");
    expect(restored.feedback!.reviewer).toBe("test-reviewer");
    expect(restored.feedback!.notes).toBe("Looks good overall");
  });

  it("round-trips feedback with revision instructions", () => {
    const feedback = createTestFeedback({
      decision: "revise",
      revisionInstructions: "Add more examples and data",
    });
    const item = createTestReviewItem({
      status: "resolved",
      feedback,
      resolvedAt: "2026-02-19T14:00:00.000Z",
    });
    const md = serializeHumanReview(item);
    const restored = deserializeHumanReview(md);

    expect(restored.feedback!.revisionInstructions).toBe(
      "Add more examples and data",
    );
  });

  it("round-trips metadata", () => {
    const item = createTestReviewItem({
      metadata: { custom: "value", count: 42 },
    });
    const md = serializeHumanReview(item);
    const restored = deserializeHumanReview(md);

    expect(restored.metadata).toEqual({ custom: "value", count: 42 });
  });

  it("throws on missing id field", () => {
    const md = `---
task_id: test-task
skill: page-cro
created_at: 2026-02-19T10:00:00.000Z
urgency: high
status: pending
escalation_reason: budget_threshold
---

# Human Review: test-task`;

    expect(() => deserializeHumanReview(md)).toThrow(WorkspaceError);
  });

  it("throws on invalid urgency value", () => {
    const md = `---
id: hr-test-123
task_id: test-task
skill: page-cro
created_at: 2026-02-19T10:00:00.000Z
urgency: invalid_urgency
status: pending
escalation_reason: budget_threshold
---

# Human Review: test-task`;

    expect(() => deserializeHumanReview(md)).toThrow(WorkspaceError);
  });

  it("throws on invalid status value", () => {
    const md = `---
id: hr-test-123
task_id: test-task
skill: page-cro
created_at: 2026-02-19T10:00:00.000Z
urgency: high
status: invalid_status
escalation_reason: budget_threshold
---

# Human Review: test-task`;

    expect(() => deserializeHumanReview(md)).toThrow(WorkspaceError);
  });

  it("returns empty context when no JSON block present", () => {
    const md = `---
id: hr-test-123
task_id: test-task
skill: page-cro
created_at: 2026-02-19T10:00:00.000Z
urgency: high
status: pending
escalation_reason: budget_threshold
---

# Human Review: test-task

## Escalation Details

- **Reason:** budget_threshold
- **Urgency:** high
- **Skill:** page-cro
- **Message:** Budget exceeded`;

    const restored = deserializeHumanReview(md);
    expect(restored.escalationContext).toEqual({});
  });

  it("handles malformed metadata JSON gracefully", () => {
    const md = `---
id: hr-test-123
task_id: test-task
skill: page-cro
created_at: 2026-02-19T10:00:00.000Z
urgency: high
status: pending
escalation_reason: budget_threshold
metadata: {invalid json
---

# Human Review: test-task

## Escalation Details

- **Reason:** budget_threshold
- **Urgency:** high
- **Skill:** page-cro
- **Message:** Budget exceeded`;

    const restored = deserializeHumanReview(md);
    expect(restored.metadata).toEqual({});
  });
});
