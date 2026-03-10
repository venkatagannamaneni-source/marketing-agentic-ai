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
export { DIRECTOR_SYSTEM_PROMPT, buildDirectorPrompt, type DirectorPromptOptions } from "./system-prompt.ts";

// ── Squad Router ─────────────────────────────────────────────────────────────
export { routeGoal, routeGoalFromRegistry, selectSkills, ROUTING_RULES } from "./squad-router.ts";

// ── Routing Registry ─────────────────────────────────────────────────────────
export {
  RoutingRegistry,
  RoutingRegistryError,
  type RoutingRegistryData,
  type RoutingRuleData,
} from "./routing-registry.ts";

// ── Goal Decomposer ─────────────────────────────────────────────────────────
export {
  GoalDecomposer,
  GOAL_CATEGORY_TEMPLATE_MAP,
} from "./goal-decomposer.ts";

// ── Pipeline Factory ─────────────────────────────────────────────────────────
export { PipelineFactory } from "./pipeline-factory.ts";

// ── Review Engine ────────────────────────────────────────────────────────────
export { ReviewEngine, DEFAULT_SEMANTIC_REVIEW_CONFIG } from "./review-engine.ts";
export type {
  SemanticReviewResult,
  QualityReviewResult,
  ReviewDepth,
  SemanticReviewConfig,
  DomainSkillCriteriaMap,
} from "./review-engine.ts";

// ── Escalation Engine ────────────────────────────────────────────────────────
export { EscalationEngine } from "./escalation.ts";

// ── Human Review Manager ─────────────────────────────────────────────────────
export { HumanReviewManager } from "./human-review-manager.ts";

// ── Quality Scoring ──────────────────────────────────────────────────────────
export { QualityScorer } from "./quality-scorer.ts";
export {
  DEFAULT_SKILL_CRITERIA,
  getSkillCriteria,
  resolveThreshold,
  buildSkillCriteriaFromDomain,
} from "./quality-criteria.ts";

// ── Learning Validator ──────────────────────────────────────────────────────
export { LearningValidator } from "./learning-validator.ts";
export type {
  LearningValidationResult,
  LearningEffectivenessReport,
} from "./learning-validator.ts";

// ── Consistency Checker ──────────────────────────────────────────────────────
export { ConsistencyChecker } from "./consistency-checker.ts";
export type { ConsistencyResult } from "./consistency-checker.ts";

// ── Marketing Director ───────────────────────────────────────────────────────
export { MarketingDirector, generateGoalId } from "./director.ts";
