import type { SkillName } from "../types/agent.ts";
import type {
  SkillQualityCriteria,
  SkillDimensionCriteria,
  QualityThreshold,
} from "../types/quality.ts";
import { DEFAULT_QUALITY_THRESHOLD } from "../types/quality.ts";

// ── Default Dimension Profiles ───────────────────────────────────────────────

const STRATEGY_DIMENSIONS: readonly SkillDimensionCriteria[] = [
  { dimension: "completeness", weight: 0.25, minScore: 5 },
  { dimension: "actionability", weight: 0.20, minScore: 5 },
  { dimension: "data_driven", weight: 0.20, minScore: 4 },
  { dimension: "clarity", weight: 0.15, minScore: 5 },
  { dimension: "brand_alignment", weight: 0.10, minScore: 4 },
  { dimension: "creativity", weight: 0.05, minScore: 3 },
  { dimension: "technical_accuracy", weight: 0.05, minScore: 4 },
];

const CREATIVE_DIMENSIONS: readonly SkillDimensionCriteria[] = [
  { dimension: "clarity", weight: 0.25, minScore: 5 },
  { dimension: "creativity", weight: 0.20, minScore: 5 },
  { dimension: "brand_alignment", weight: 0.20, minScore: 5 },
  { dimension: "actionability", weight: 0.15, minScore: 4 },
  { dimension: "completeness", weight: 0.10, minScore: 4 },
  { dimension: "data_driven", weight: 0.05, minScore: 3 },
  { dimension: "technical_accuracy", weight: 0.05, minScore: 3 },
];

const CONVERT_DIMENSIONS: readonly SkillDimensionCriteria[] = [
  { dimension: "actionability", weight: 0.25, minScore: 5 },
  { dimension: "data_driven", weight: 0.20, minScore: 5 },
  { dimension: "completeness", weight: 0.20, minScore: 5 },
  { dimension: "clarity", weight: 0.15, minScore: 5 },
  { dimension: "technical_accuracy", weight: 0.10, minScore: 4 },
  { dimension: "brand_alignment", weight: 0.05, minScore: 3 },
  { dimension: "creativity", weight: 0.05, minScore: 3 },
];

const ACTIVATE_DIMENSIONS: readonly SkillDimensionCriteria[] = [
  { dimension: "actionability", weight: 0.25, minScore: 5 },
  { dimension: "completeness", weight: 0.20, minScore: 5 },
  { dimension: "clarity", weight: 0.20, minScore: 5 },
  { dimension: "brand_alignment", weight: 0.15, minScore: 4 },
  { dimension: "data_driven", weight: 0.10, minScore: 3 },
  { dimension: "creativity", weight: 0.05, minScore: 3 },
  { dimension: "technical_accuracy", weight: 0.05, minScore: 3 },
];

const MEASURE_DIMENSIONS: readonly SkillDimensionCriteria[] = [
  { dimension: "technical_accuracy", weight: 0.25, minScore: 6 },
  { dimension: "data_driven", weight: 0.25, minScore: 5 },
  { dimension: "completeness", weight: 0.20, minScore: 5 },
  { dimension: "actionability", weight: 0.15, minScore: 4 },
  { dimension: "clarity", weight: 0.15, minScore: 5 },
  { dimension: "brand_alignment", weight: 0.00, minScore: 0 },
  { dimension: "creativity", weight: 0.00, minScore: 0 },
];

// ── Default Skill Criteria Registry ──────────────────────────────────────────

export const DEFAULT_SKILL_CRITERIA: Readonly<Record<string, SkillQualityCriteria>> = {
  // Foundation
  "product-marketing-context": {
    skill: "product-marketing-context",
    dimensions: STRATEGY_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Product", "Audience", "Positioning"],
    minWordCount: 200,
  },

  // Strategy Squad
  "content-strategy": {
    skill: "content-strategy",
    dimensions: STRATEGY_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Summary", "Strategy", "Recommendations"],
    minWordCount: 300,
  },
  "pricing-strategy": {
    skill: "pricing-strategy",
    dimensions: STRATEGY_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Analysis", "Recommendations"],
    minWordCount: 300,
  },
  "launch-strategy": {
    skill: "launch-strategy",
    dimensions: STRATEGY_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Timeline", "Channels", "Strategy"],
    minWordCount: 300,
  },
  "marketing-ideas": {
    skill: "marketing-ideas",
    dimensions: STRATEGY_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Ideas"],
    minWordCount: 200,
  },
  "marketing-psychology": {
    skill: "marketing-psychology",
    dimensions: STRATEGY_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Principles", "Application"],
    minWordCount: 200,
  },
  "competitor-alternatives": {
    skill: "competitor-alternatives",
    dimensions: STRATEGY_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Competitors", "Comparison"],
    minWordCount: 300,
  },

  // Creative Squad
  "copywriting": {
    skill: "copywriting",
    dimensions: CREATIVE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: [],
    minWordCount: 100,
  },
  "copy-editing": {
    skill: "copy-editing",
    dimensions: CREATIVE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Feedback", "Suggestions"],
    minWordCount: 100,
  },
  "social-content": {
    skill: "social-content",
    dimensions: CREATIVE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: [],
    minWordCount: 50,
  },
  "cold-email": {
    skill: "cold-email",
    dimensions: CREATIVE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Subject", "Body"],
    minWordCount: 50,
  },
  "paid-ads": {
    skill: "paid-ads",
    dimensions: CREATIVE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Ad Copy"],
    minWordCount: 50,
  },
  "programmatic-seo": {
    skill: "programmatic-seo",
    dimensions: CREATIVE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Template", "Strategy"],
    minWordCount: 200,
  },
  "schema-markup": {
    skill: "schema-markup",
    dimensions: CREATIVE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Schema"],
    minWordCount: 50,
  },

  // Convert Squad
  "page-cro": {
    skill: "page-cro",
    dimensions: CONVERT_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Findings", "Recommendations"],
    minWordCount: 200,
  },
  "form-cro": {
    skill: "form-cro",
    dimensions: CONVERT_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Analysis", "Recommendations"],
    minWordCount: 200,
  },
  "signup-flow-cro": {
    skill: "signup-flow-cro",
    dimensions: CONVERT_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Analysis", "Recommendations"],
    minWordCount: 200,
  },
  "popup-cro": {
    skill: "popup-cro",
    dimensions: CONVERT_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Analysis", "Recommendations"],
    minWordCount: 100,
  },
  "free-tool-strategy": {
    skill: "free-tool-strategy",
    dimensions: CONVERT_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Strategy", "Implementation"],
    minWordCount: 200,
  },

  // Activate Squad
  "onboarding-cro": {
    skill: "onboarding-cro",
    dimensions: ACTIVATE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Flow", "Recommendations"],
    minWordCount: 200,
  },
  "email-sequence": {
    skill: "email-sequence",
    dimensions: ACTIVATE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Sequence"],
    minWordCount: 200,
  },
  "paywall-upgrade-cro": {
    skill: "paywall-upgrade-cro",
    dimensions: ACTIVATE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Analysis", "Recommendations"],
    minWordCount: 200,
  },
  "referral-program": {
    skill: "referral-program",
    dimensions: ACTIVATE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Program", "Incentives"],
    minWordCount: 200,
  },

  // Measure Squad
  "analytics-tracking": {
    skill: "analytics-tracking",
    dimensions: MEASURE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Tracking Plan"],
    minWordCount: 200,
  },
  "ab-test-setup": {
    skill: "ab-test-setup",
    dimensions: MEASURE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Hypothesis", "Setup"],
    minWordCount: 200,
  },
  "seo-audit": {
    skill: "seo-audit",
    dimensions: MEASURE_DIMENSIONS,
    threshold: DEFAULT_QUALITY_THRESHOLD,
    requiredSections: ["Findings", "Recommendations"],
    minWordCount: 300,
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get quality criteria for a skill, merging defaults with optional overrides.
 */
export function getSkillCriteria(
  skill: SkillName | string,
  overrides?: Partial<SkillQualityCriteria>,
): SkillQualityCriteria {
  const defaults = DEFAULT_SKILL_CRITERIA[skill];
  if (!defaults) {
    // Fallback for unknown skills
    return {
      skill,
      dimensions: STRATEGY_DIMENSIONS,
      threshold: DEFAULT_QUALITY_THRESHOLD,
      requiredSections: [],
      minWordCount: 100,
      ...overrides,
    };
  }
  if (!overrides) return defaults;

  return {
    ...defaults,
    ...overrides,
    // Preserve skill name from defaults
    skill: defaults.skill,
  };
}

/**
 * Resolve the quality threshold for a skill, checking custom overrides first.
 */
export function resolveThreshold(
  skill: SkillName | string,
  customThresholds?: Partial<Record<string, QualityThreshold>>,
): QualityThreshold {
  if (customThresholds?.[skill]) {
    return customThresholds[skill];
  }
  const criteria = DEFAULT_SKILL_CRITERIA[skill];
  return criteria?.threshold ?? DEFAULT_QUALITY_THRESHOLD;
}
