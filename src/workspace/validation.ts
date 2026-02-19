import type { Task } from "../types/task.ts";
import type { Review } from "../types/review.ts";
import {
  SKILL_NAMES,
  PRIORITIES,
  TASK_STATUSES,
  REVIEW_VERDICTS,
} from "../types/index.ts";
import { WorkspaceError } from "./errors.ts";

// ── Task Validation ──────────────────────────────────────────────────────────

const VALID_FROM = [...SKILL_NAMES, "director", "scheduler", "event-bus"];
const VALID_NEXT_TYPES = [
  "agent",
  "director_review",
  "pipeline_continue",
  "complete",
];

export function validateTask(task: unknown): asserts task is Task {
  if (!task || typeof task !== "object") {
    throw validationError("Task must be a non-null object");
  }

  const t = task as Record<string, unknown>;

  assertString(t, "id");
  assertString(t, "createdAt");
  assertString(t, "updatedAt");
  assertOneOf(t, "from", VALID_FROM);
  assertOneOf(t, "to", SKILL_NAMES as readonly string[]);
  assertOneOf(t, "priority", PRIORITIES as readonly string[]);
  assertOneOf(t, "status", TASK_STATUSES as readonly string[]);
  assertNumber(t, "revisionCount");
  if ((t["revisionCount"] as number) < 0) {
    throw validationError(`"revisionCount" must be non-negative`);
  }
  assertString(t, "goal");
  assertString(t, "requirements");

  // Nullable fields
  if (t["deadline"] !== null && t["deadline"] !== undefined) {
    assertStringField(t["deadline"], "deadline");
  }
  if (t["goalId"] !== null && t["goalId"] !== undefined) {
    assertStringField(t["goalId"], "goalId");
  }
  if (t["pipelineId"] !== null && t["pipelineId"] !== undefined) {
    assertStringField(t["pipelineId"], "pipelineId");
  }

  // Nested structures
  assertArray(t, "inputs");
  for (const input of t["inputs"] as unknown[]) {
    validateTaskInput(input);
  }

  assertObject(t, "output");
  validateTaskOutput(t["output"] as Record<string, unknown>);

  assertObject(t, "next");
  validateTaskNext(t["next"] as Record<string, unknown>);

  assertArray(t, "tags");
  assertObject(t, "metadata");
}

function validateTaskInput(input: unknown): void {
  if (!input || typeof input !== "object") {
    throw validationError("TaskInput must be a non-null object");
  }
  const i = input as Record<string, unknown>;
  assertString(i, "path");
  assertString(i, "description");
}

function validateTaskOutput(output: Record<string, unknown>): void {
  assertString(output, "path");
  assertString(output, "format");
}

function validateTaskNext(next: Record<string, unknown>): void {
  assertOneOf(next, "type", VALID_NEXT_TYPES);
  const nextType = next["type"] as string;

  switch (nextType) {
    case "agent":
      assertOneOf(next, "skill", SKILL_NAMES as readonly string[]);
      break;
    case "pipeline_continue":
      assertString(next, "pipelineId");
      break;
    case "director_review":
    case "complete":
      break;
    default:
      throw validationError(`Unknown next type: "${nextType}"`);
  }
}

// ── Review Validation ────────────────────────────────────────────────────────

const VALID_REVIEWERS = [...SKILL_NAMES, "director"];
const VALID_FINDING_SEVERITIES = ["critical", "major", "minor", "suggestion"];
const VALID_REVISION_PRIORITIES = ["required", "recommended", "optional"];

export function validateReview(review: unknown): asserts review is Review {
  if (!review || typeof review !== "object") {
    throw validationError("Review must be a non-null object");
  }

  const r = review as Record<string, unknown>;

  assertString(r, "id");
  assertString(r, "taskId");
  assertString(r, "createdAt");
  assertOneOf(r, "reviewer", VALID_REVIEWERS);
  assertOneOf(r, "author", SKILL_NAMES as readonly string[]);
  assertOneOf(r, "verdict", REVIEW_VERDICTS as readonly string[]);
  assertString(r, "summary");

  assertArray(r, "findings");
  for (const finding of r["findings"] as unknown[]) {
    validateFinding(finding);
  }

  assertArray(r, "revisionRequests");
  for (const req of r["revisionRequests"] as unknown[]) {
    validateRevisionRequest(req);
  }
}

function validateFinding(finding: unknown): void {
  if (!finding || typeof finding !== "object") {
    throw validationError("ReviewFinding must be a non-null object");
  }
  const f = finding as Record<string, unknown>;
  assertString(f, "section");
  assertOneOf(f, "severity", VALID_FINDING_SEVERITIES);
  assertString(f, "description");
}

function validateRevisionRequest(req: unknown): void {
  if (!req || typeof req !== "object") {
    throw validationError("RevisionRequest must be a non-null object");
  }
  const r = req as Record<string, unknown>;
  assertString(r, "description");
  assertOneOf(r, "priority", VALID_REVISION_PRIORITIES);
}

// ── Assertion Helpers ────────────────────────────────────────────────────────

function assertString(obj: Record<string, unknown>, field: string): void {
  if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
    throw validationError(`"${field}" must be a non-empty string`);
  }
}

function assertStringField(value: unknown, name: string): void {
  if (typeof value !== "string") {
    throw validationError(`"${name}" must be a string`);
  }
}

function assertNumber(obj: Record<string, unknown>, field: string): void {
  if (typeof obj[field] !== "number" || Number.isNaN(obj[field])) {
    throw validationError(`"${field}" must be a number`);
  }
}

function assertOneOf(
  obj: Record<string, unknown>,
  field: string,
  values: readonly string[],
): void {
  assertString(obj, field);
  if (!values.includes(obj[field] as string)) {
    throw validationError(
      `"${field}" must be one of: ${values.join(", ")}. Got: "${obj[field] as string}"`,
    );
  }
}

function assertArray(obj: Record<string, unknown>, field: string): void {
  if (!Array.isArray(obj[field])) {
    throw validationError(`"${field}" must be an array`);
  }
}

function assertObject(obj: Record<string, unknown>, field: string): void {
  if (!obj[field] || typeof obj[field] !== "object" || Array.isArray(obj[field])) {
    throw validationError(`"${field}" must be a non-null object`);
  }
}

function validationError(message: string): WorkspaceError {
  return new WorkspaceError(message, "VALIDATION_ERROR");
}
