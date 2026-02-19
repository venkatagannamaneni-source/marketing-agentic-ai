import type {
  HumanReviewItem,
  HumanFeedback,
  HumanReviewUrgency,
  HumanReviewStatus,
} from "../types/human-review.ts";
import {
  HUMAN_REVIEW_STATUSES,
  HUMAN_REVIEW_URGENCIES,
} from "../types/human-review.ts";
import { parseFrontmatter } from "./markdown.ts";
import { WorkspaceError } from "./errors.ts";

// ── Human Review Serialization ───────────────────────────────────────────────

export function serializeHumanReview(item: HumanReviewItem): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`id: ${item.id}`);
  lines.push(`task_id: ${item.taskId}`);
  lines.push(`goal_id: ${item.goalId ?? "null"}`);
  lines.push(`pipeline_id: ${item.pipelineId ?? "null"}`);
  lines.push(`skill: ${item.skill}`);
  lines.push(`created_at: ${item.createdAt}`);
  lines.push(`urgency: ${item.urgency}`);
  lines.push(`status: ${item.status}`);
  lines.push(`escalation_reason: ${item.escalationReason}`);
  if (item.feedback) {
    lines.push(`feedback_decision: ${item.feedback.decision}`);
    lines.push(`feedback_reviewer: ${item.feedback.reviewer}`);
  }
  if (item.resolvedAt) {
    lines.push(`resolved_at: ${item.resolvedAt}`);
  }
  if (Object.keys(item.metadata).length > 0) {
    lines.push(`metadata: ${JSON.stringify(item.metadata)}`);
  }
  lines.push("---");
  lines.push("");

  // Readable markdown body
  lines.push(`# Human Review: ${item.taskId}`);
  lines.push("");
  lines.push("## Escalation Details");
  lines.push("");
  lines.push(`- **Reason:** ${item.escalationReason}`);
  lines.push(`- **Urgency:** ${item.urgency}`);
  lines.push(`- **Skill:** ${item.skill}`);
  lines.push(`- **Message:** ${item.escalationMessage}`);
  lines.push("");

  if (Object.keys(item.escalationContext).length > 0) {
    lines.push("## Escalation Context");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(item.escalationContext, null, 2));
    lines.push("```");
    lines.push("");
  }

  if (item.feedback) {
    lines.push("## Human Feedback");
    lines.push("");
    lines.push(`- **Decision:** ${item.feedback.decision}`);
    lines.push(`- **Reviewer:** ${item.feedback.reviewer}`);
    lines.push(`- **Provided At:** ${item.feedback.providedAt}`);
    lines.push("");
    lines.push("### Notes");
    lines.push("");
    lines.push(item.feedback.notes);
    lines.push("");
    if (item.feedback.revisionInstructions) {
      lines.push("### Revision Instructions");
      lines.push("");
      lines.push(item.feedback.revisionInstructions);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function deserializeHumanReview(markdown: string): HumanReviewItem {
  const { frontmatter: fm, body } = parseFrontmatter(markdown);

  const id = requireField(fm, "id");
  const taskId = requireField(fm, "task_id");
  const goalId = fm["goal_id"] === "null" || !fm["goal_id"] ? null : fm["goal_id"];
  const pipelineId = fm["pipeline_id"] === "null" || !fm["pipeline_id"] ? null : fm["pipeline_id"];
  const skill = requireField(fm, "skill");
  const createdAt = requireField(fm, "created_at");
  const urgency = requireEnum(fm, "urgency", HUMAN_REVIEW_URGENCIES);
  const status = requireEnum(fm, "status", HUMAN_REVIEW_STATUSES);
  const escalationReason = requireField(fm, "escalation_reason");
  const resolvedAt = fm["resolved_at"] ?? null;

  const escalationMessage = extractEscalationMessage(body);
  const escalationContext = extractEscalationContext(body);
  const feedback = extractFeedback(fm, body);

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(fm["metadata"] ?? "{}");
  } catch {
    // ignore parse errors
  }

  return {
    id,
    taskId,
    goalId,
    pipelineId,
    skill,
    createdAt,
    urgency,
    status,
    escalationReason,
    escalationMessage,
    escalationContext,
    feedback,
    resolvedAt,
    metadata,
  };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function requireField(
  fm: Record<string, string>,
  field: string,
): string {
  const value = fm[field];
  if (value === undefined || value === "") {
    throw new WorkspaceError(
      `Missing required frontmatter field: ${field}`,
      "PARSE_ERROR",
    );
  }
  return value;
}

function requireEnum<T extends string>(
  fm: Record<string, string>,
  field: string,
  values: readonly T[],
): T {
  const value = requireField(fm, field);
  if (!values.includes(value as T)) {
    throw new WorkspaceError(
      `Invalid value for ${field}: "${value}". Expected one of: ${values.join(", ")}`,
      "PARSE_ERROR",
    );
  }
  return value as T;
}

function extractEscalationMessage(body: string): string {
  const pattern = /\*\*Message:\*\*\s*(.+)/;
  const match = body.match(pattern);
  return match ? match[1]!.trim() : "";
}

function extractEscalationContext(body: string): Record<string, unknown> {
  const pattern = /## Escalation Context\s*\n\s*```json\n([\s\S]*?)\n```/;
  const match = body.match(pattern);
  if (!match) return {};
  try {
    return JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractFeedback(
  fm: Record<string, string>,
  body: string,
): HumanFeedback | null {
  const decision = fm["feedback_decision"];
  const reviewer = fm["feedback_reviewer"];
  if (!decision || !reviewer) return null;

  const providedAtMatch = body.match(/\*\*Provided At:\*\*\s*(.+)/);
  const providedAt = providedAtMatch ? providedAtMatch[1]!.trim() : "";

  const notes = extractSection(body, "Notes");
  const revisionInstructions = extractSection(body, "Revision Instructions") || null;

  return {
    decision: decision as HumanFeedback["decision"],
    reviewer,
    notes,
    revisionInstructions,
    providedAt,
  };
}

function extractSection(body: string, heading: string): string {
  const pattern = new RegExp(
    `### ${heading}\\s*\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`,
  );
  const match = body.match(pattern);
  return match ? match[1]!.trim() : "";
}
