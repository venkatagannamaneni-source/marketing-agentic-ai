import type { SkillName, SquadName, ModelTier } from "../types/agent.ts";
import type { Priority, Task } from "../types/task.ts";
import type { Review } from "../types/review.ts";
import type { LearningEntry } from "../types/workspace.ts";

// ── Goal Types (canonical source: src/types/goal.ts) ────────────────────────

export {
  GOAL_CATEGORIES,
  type GoalCategory,
  type Goal,
  type GoalPhase,
  type GoalPlan,
} from "../types/goal.ts";
import type { GoalCategory } from "../types/goal.ts";

// ── Squad Route ──────────────────────────────────────────────────────────────

export interface SquadRoute {
  readonly squad: SquadName;
  readonly skills: readonly SkillName[];
  readonly reason: string;
}

export interface RoutingDecision {
  readonly goalCategory: GoalCategory;
  readonly routes: readonly SquadRoute[];
  readonly measureSquadFinal: boolean;
}

// ── Director Actions ─────────────────────────────────────────────────────────

export const DIRECTOR_ACTIONS = [
  "approve",
  "revise",
  "reject_reassign",
  "escalate_human",
  "pipeline_next",
  "goal_complete",
  "goal_iterate",
] as const;

export type DirectorAction = (typeof DIRECTOR_ACTIONS)[number];

// ── Director Decision ────────────────────────────────────────────────────────

export interface DirectorDecision {
  readonly taskId: string;
  readonly action: DirectorAction;
  readonly review: Review | null;
  readonly nextTasks: readonly Task[];
  readonly learning: LearningEntry | null;
  readonly escalation: Escalation | null;
  readonly reasoning: string;
}

// ── Escalation ───────────────────────────────────────────────────────────────

export const ESCALATION_REASONS = [
  "budget_threshold",
  "brand_change",
  "legal_risk",
  "pricing_change",
  "agent_loop_detected",
  "cascading_failure",
  "goal_unmet_after_max_iterations",
  "manual_approval_required",
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export interface Escalation {
  readonly reason: EscalationReason;
  readonly severity: "warning" | "critical";
  readonly message: string;
  readonly context: Record<string, unknown>;
}

// ── Budget State ─────────────────────────────────────────────────────────────

export const BUDGET_LEVELS = [
  "normal",
  "warning",
  "throttle",
  "critical",
  "exhausted",
] as const;

export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

export interface BudgetState {
  readonly totalBudget: number;
  readonly spent: number;
  readonly percentUsed: number;
  readonly level: BudgetLevel;
  readonly allowedPriorities: readonly Priority[];
  readonly modelOverride: ModelTier | null;
}

// ── Director Configuration ───────────────────────────────────────────────────

export interface DirectorConfig {
  readonly maxRevisionsPerTask: number;
  readonly maxIterationsPerGoal: number;
  readonly defaultPriority: Priority;
  readonly budget: {
    readonly totalMonthly: number;
    readonly warningPercent: number;
    readonly throttlePercent: number;
    readonly criticalPercent: number;
  };
  readonly qualityThresholds?: Partial<Record<string, import("../types/quality.ts").QualityThreshold>>;
  readonly qualityCriteria?: Partial<Record<string, Partial<import("../types/quality.ts").SkillQualityCriteria>>>;
}

export const DEFAULT_DIRECTOR_CONFIG: DirectorConfig = {
  maxRevisionsPerTask: 3,
  maxIterationsPerGoal: 3,
  defaultPriority: "P2",
  budget: {
    totalMonthly: 1000,
    warningPercent: 80,
    throttlePercent: 90,
    criticalPercent: 95,
  },
};
