// ── Squad Names ──────────────────────────────────────────────────────────────

export const SQUAD_NAMES = [
  "strategy",
  "creative",
  "convert",
  "activate",
  "measure",
] as const;

export type SquadName = (typeof SQUAD_NAMES)[number];

// ── Skill Names ──────────────────────────────────────────────────────────────

export const SKILL_NAMES = [
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
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

export const FOUNDATION_SKILL: SkillName = "product-marketing-context";

// ── Skill → Squad Mapping ────────────────────────────────────────────────────

export const SKILL_SQUAD_MAP: Record<SkillName, SquadName | null> = {
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
