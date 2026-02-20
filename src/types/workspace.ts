import type { SquadName, SkillName } from "./agent.ts";

// ── Workspace Directories ────────────────────────────────────────────────────

export const WORKSPACE_DIRS = [
  "context",
  "tasks",
  "outputs",
  "reviews",
  "metrics",
  "memory",
  "goals",
  "schedules",
] as const;

export type WorkspaceDir = (typeof WORKSPACE_DIRS)[number];

// ── Workspace Configuration ──────────────────────────────────────────────────

export interface WorkspaceConfig {
  readonly rootDir: string;
}

// ── Workspace Paths ──────────────────────────────────────────────────────────

export interface WorkspacePaths {
  readonly root: string;
  readonly context: string;
  readonly contextFile: string;
  readonly tasks: string;
  taskFile(taskId: string): string;
  readonly outputs: string;
  outputDir(squad: SquadName, skill: SkillName): string;
  outputFile(squad: SquadName, skill: SkillName, taskId: string): string;
  readonly reviews: string;
  reviewFile(taskId: string, reviewIndex?: number): string;
  readonly metrics: string;
  metricsFile(date: string): string;
  readonly memory: string;
  readonly memoryFile: string;
  readonly goals: string;
  goalFile(goalId: string): string;
  goalPlanFile(goalId: string): string;
  readonly schedules: string;
  scheduleStateFile(scheduleId: string): string;
}

// ── Learning Entry (for memory/learnings.md) ─────────────────────────────────

export interface LearningEntry {
  readonly timestamp: string;
  readonly agent: SkillName | "director";
  readonly goalId: string | null;
  readonly outcome: "success" | "failure" | "partial";
  readonly learning: string;
  readonly actionTaken: string;
  readonly tags?: readonly string[];
  readonly confidence?: number;
}
