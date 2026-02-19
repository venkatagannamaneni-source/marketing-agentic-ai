import type { SkillName } from "./agent.ts";
import type { Priority } from "./task.ts";

// ── Pipeline Steps ───────────────────────────────────────────────────────────

export type PipelineStep =
  | { readonly type: "sequential"; readonly skill: SkillName }
  | { readonly type: "parallel"; readonly skills: readonly SkillName[] }
  | { readonly type: "review"; readonly reviewer: SkillName | "director" };

// ── Pipeline Status ──────────────────────────────────────────────────────────

export const PIPELINE_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

// ── Pipeline Trigger ─────────────────────────────────────────────────────────

export type PipelineTrigger =
  | { readonly type: "manual" }
  | { readonly type: "schedule"; readonly cron: string }
  | { readonly type: "event"; readonly eventType: string };

// ── Pipeline Definition ──────────────────────────────────────────────────────

export interface PipelineDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly PipelineStep[];
  readonly defaultPriority: Priority;
  readonly trigger: PipelineTrigger;
}

// ── Pipeline Run (runtime instance) ──────────────────────────────────────────

export interface PipelineRun {
  readonly id: string;
  readonly pipelineId: string;
  readonly goalId: string | null;
  readonly startedAt: string;
  completedAt: string | null;
  status: PipelineStatus;
  currentStepIndex: number;
  readonly taskIds: string[];
}
