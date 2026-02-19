// ── Types ────────────────────────────────────────────────────────────────────
export type {
  GoalCategory,
  Goal,
  GoalPhase,
  GoalPlan,
  SquadRoute,
  RoutingDecision,
  DirectorAction,
  DirectorDecision,
  EscalationReason,
  Escalation,
  BudgetLevel,
  BudgetState,
  DirectorConfig,
} from "./types.ts";

export {
  GOAL_CATEGORIES,
  DIRECTOR_ACTIONS,
  ESCALATION_REASONS,
  BUDGET_LEVELS,
  DEFAULT_DIRECTOR_CONFIG,
} from "./types.ts";

// ── System Prompt ────────────────────────────────────────────────────────────
export { DIRECTOR_SYSTEM_PROMPT } from "./system-prompt.ts";

// ── Squad Router ─────────────────────────────────────────────────────────────
export { routeGoal, selectSkills, ROUTING_RULES } from "./squad-router.ts";

// ── Goal Decomposer ─────────────────────────────────────────────────────────
export {
  GoalDecomposer,
  GOAL_CATEGORY_TEMPLATE_MAP,
} from "./goal-decomposer.ts";

// ── Pipeline Factory ─────────────────────────────────────────────────────────
export { PipelineFactory } from "./pipeline-factory.ts";

// ── Review Engine ────────────────────────────────────────────────────────────
export { ReviewEngine } from "./review-engine.ts";
export type { SemanticReviewResult } from "./review-engine.ts";

// ── Escalation Engine ────────────────────────────────────────────────────────
export { EscalationEngine } from "./escalation.ts";

// ── Marketing Director ───────────────────────────────────────────────────────
export { MarketingDirector, generateGoalId } from "./director.ts";
