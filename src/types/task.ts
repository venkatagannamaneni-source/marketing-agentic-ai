import type { SkillName } from "./agent.ts";

// ── Priority ─────────────────────────────────────────────────────────────────

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P0: "critical",
  P1: "high",
  P2: "medium",
  P3: "low",
};

// ── Task Status ──────────────────────────────────────────────────────────────

export const TASK_STATUSES = [
  "pending",
  "assigned",
  "in_progress",
  "completed",
  "in_review",
  "revision",
  "approved",
  "failed",
  "blocked",
  "cancelled",
  "deferred",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

// ── Task State Machine ──────────────────────────────────────────────────────

export const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["in_progress", "assigned", "blocked", "deferred", "cancelled", "failed"],
  assigned: ["in_progress", "cancelled", "failed"],
  in_progress: ["completed", "failed", "cancelled"],
  completed: ["approved", "revision", "failed", "blocked", "in_review"],
  in_review: ["approved", "revision", "failed", "blocked"],
  revision: ["in_progress", "cancelled", "failed"],
  approved: [],
  failed: [],
  blocked: ["pending", "failed"],
  deferred: ["pending", "failed"],
  cancelled: [],
} as const;

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
  constructor(
    public readonly taskId: string,
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(
      `Invalid status transition for task ${taskId}: "${from}" -> "${to}"`,
    );
  }
}

export function validateTransition(
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(taskId, from, to);
  }
}

// ── Task Structure ───────────────────────────────────────────────────────────

export interface TaskInput {
  readonly path: string;
  readonly description: string;
}

export interface TaskOutput {
  readonly path: string;
  readonly format: string;
}

export type TaskNext =
  | { readonly type: "agent"; readonly skill: SkillName }
  | { readonly type: "director_review" }
  | { readonly type: "pipeline_continue"; readonly pipelineId: string }
  | { readonly type: "complete" };

export type TaskFrom = SkillName | "director" | "scheduler" | "event-bus";

export interface Task {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;

  readonly from: TaskFrom;
  readonly to: SkillName;
  readonly priority: Priority;
  readonly deadline: string | null;

  status: TaskStatus;
  readonly revisionCount: number;

  readonly goalId: string | null;
  readonly pipelineId: string | null;
  readonly goal: string;
  readonly inputs: readonly TaskInput[];

  readonly requirements: string;

  readonly output: TaskOutput;
  readonly next: TaskNext;

  readonly tags: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface TaskFilter {
  readonly status?: TaskStatus | readonly TaskStatus[];
  readonly priority?: Priority | readonly Priority[];
  readonly skill?: SkillName;
  readonly pipelineId?: string;
}
