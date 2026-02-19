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
