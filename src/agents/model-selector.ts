import type { SkillName, ModelTier } from "../types/agent.ts";
import { SKILL_SQUAD_MAP } from "../types/agent.ts";
import type { BudgetState } from "../director/types.ts";

// ── Model Selection ──────────────────────────────────────────────────────────

/**
 * Select the appropriate model tier for a given skill.
 *
 * Priority order:
 * 1. configOverride (explicit per-task override)
 * 2. budgetState.modelOverride (budget forced downgrade)
 * 3. Strategy Squad + foundation → "opus"
 * 4. All other squads → "sonnet"
 */
export function selectModelTier(
  skill: SkillName,
  budgetState?: BudgetState,
  configOverride?: ModelTier,
): ModelTier {
  // 1. Explicit override takes highest priority
  if (configOverride) return configOverride;

  // 2. Budget-forced model downgrade
  if (budgetState?.modelOverride) return budgetState.modelOverride;

  // 3. Squad-based default
  const squad = SKILL_SQUAD_MAP[skill];

  // Foundation skill (product-marketing-context) → opus
  if (squad === null) return "opus";

  // Strategy Squad → opus (high-level reasoning)
  if (squad === "strategy") return "opus";

  // All other squads (creative, convert, activate, measure) → sonnet
  return "sonnet";
}
