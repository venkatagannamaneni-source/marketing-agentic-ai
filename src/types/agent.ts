// ── Squad Names ──────────────────────────────────────────────────────────────
// Default squads — matches .agents/skills.yaml.
// For runtime extensibility, use SkillRegistry.fromYaml() instead.

export const SQUAD_NAMES: readonly string[] = [
  "strategy",
  "creative",
  "convert",
  "activate",
  "measure",
];

export type SquadName = string;

// ── Skill Names ──────────────────────────────────────────────────────────────
// Default skills — matches .agents/skills.yaml.
// For runtime extensibility, use SkillRegistry.fromYaml() instead.

export const SKILL_NAMES: readonly string[] = [
  // Foundation
  "product-marketing-context",
  // Strategy Squad
  "content-strategy",
  "pricing-strategy",
  "launch-strategy",
  "marketing-ideas",
  "marketing-psychology",
  "competitor-alternatives",
  // Creative Squad
  "copywriting",
  "copy-editing",
  "social-content",
  "cold-email",
  "paid-ads",
  "programmatic-seo",
  "schema-markup",
  // Convert Squad
  "page-cro",
  "form-cro",
  "signup-flow-cro",
  "popup-cro",
  "free-tool-strategy",
  // Activate Squad
  "onboarding-cro",
  "email-sequence",
  "paywall-upgrade-cro",
  "referral-program",
  // Measure Squad
  "analytics-tracking",
  "ab-test-setup",
  "seo-audit",
];

export type SkillName = string;

export const FOUNDATION_SKILL: string = "product-marketing-context";

// ── Skill → Squad Mapping ────────────────────────────────────────────────────
// Default mapping — matches .agents/skills.yaml.

export const SKILL_SQUAD_MAP: Record<string, string | null> = {
  "product-marketing-context": null,
  // Strategy
  "content-strategy": "strategy",
  "pricing-strategy": "strategy",
  "launch-strategy": "strategy",
  "marketing-ideas": "strategy",
  "marketing-psychology": "strategy",
  "competitor-alternatives": "strategy",
  // Creative
  "copywriting": "creative",
  "copy-editing": "creative",
  "social-content": "creative",
  "cold-email": "creative",
  "paid-ads": "creative",
  "programmatic-seo": "creative",
  "schema-markup": "creative",
  // Convert
  "page-cro": "convert",
  "form-cro": "convert",
  "signup-flow-cro": "convert",
  "popup-cro": "convert",
  "free-tool-strategy": "convert",
  // Activate
  "onboarding-cro": "activate",
  "email-sequence": "activate",
  "paywall-upgrade-cro": "activate",
  "referral-program": "activate",
  // Measure
  "analytics-tracking": "measure",
  "ab-test-setup": "measure",
  "seo-audit": "measure",
};

export function getSquadSkills(squad: SquadName): SkillName[] {
  return SKILL_NAMES.filter((s) => SKILL_SQUAD_MAP[s] === squad);
}

// ── Agent Metadata ───────────────────────────────────────────────────────────

export interface AgentMeta {
  readonly name: SkillName;
  readonly description: string;
  readonly version: string;
  readonly squad: SquadName | null;
  readonly skillFilePath: string;
  readonly referenceFiles: readonly string[];
}

export type ModelTier = "opus" | "sonnet" | "haiku";

export interface AgentConfig {
  readonly skill: SkillName;
  readonly modelTier: ModelTier;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}
