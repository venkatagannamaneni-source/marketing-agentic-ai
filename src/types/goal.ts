import type { SkillName } from "./agent.ts";
import type { Priority } from "./task.ts";

// ── Goal Categories ─────────────────────────────────────────────────────────
// Default marketing categories are kept for backward compatibility.
// At runtime, the DomainRegistry may provide different categories.
// GoalCategory is widened to `string` so domain-specific categories work.

export const GOAL_CATEGORIES = [
  "strategic",
  "content",
  "optimization",
  "retention",
  "competitive",
  "measurement",
] as const;

/**
 * Goal category type. Accepts the built-in marketing defaults and any
 * custom category string loaded from domain.yaml at runtime.
 */
export type GoalCategory = (typeof GOAL_CATEGORIES)[number] | (string & {});

// ── Goal ─────────────────────────────────────────────────────────────────────

export interface Goal {
  readonly id: string;
  readonly description: string;
  readonly category: GoalCategory;
  readonly priority: Priority;
  readonly createdAt: string;
  readonly deadline: string | null;
  readonly metadata: Record<string, unknown>;
}

// ── Goal Phase ───────────────────────────────────────────────────────────────

export interface GoalPhase {
  readonly name: string;
  readonly description: string;
  readonly skills: readonly SkillName[];
  readonly parallel: boolean;
  readonly dependsOnPhase: number | null;
}

// ── Goal Plan ────────────────────────────────────────────────────────────────

export interface GoalPlan {
  readonly goalId: string;
  readonly phases: readonly GoalPhase[];
  readonly estimatedTaskCount: number;
  readonly pipelineTemplateName: string | null;
}
