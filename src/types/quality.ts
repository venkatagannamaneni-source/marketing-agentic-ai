// ── Quality Dimensions ───────────────────────────────────────────────────────

export const QUALITY_DIMENSIONS = [
  "completeness",
  "clarity",
  "actionability",
  "brand_alignment",
  "data_driven",
  "technical_accuracy",
  "creativity",
] as const;

export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

// ── Quality Score ────────────────────────────────────────────────────────────

export interface DimensionScore {
  readonly dimension: QualityDimension;
  readonly score: number;
  readonly weight: number;
  readonly rationale: string;
}

export interface QualityScore {
  readonly taskId: string;
  readonly skill: string;
  readonly dimensions: readonly DimensionScore[];
  readonly overallScore: number;
  readonly scoredAt: string;
  readonly scoredBy: "structural" | "semantic" | "human";
}

// ── Quality Thresholds ───────────────────────────────────────────────────────

export interface QualityThreshold {
  readonly approveAbove: number;
  readonly reviseBelow: number;
  readonly rejectBelow: number;
}

export const DEFAULT_QUALITY_THRESHOLD: QualityThreshold = {
  approveAbove: 7.0,
  reviseBelow: 7.0,
  rejectBelow: 4.0,
};

// ── Skill Quality Criteria ───────────────────────────────────────────────────

export interface SkillDimensionCriteria {
  readonly dimension: QualityDimension;
  readonly weight: number;
  readonly minScore: number;
}

export interface SkillQualityCriteria {
  readonly skill: string;
  readonly dimensions: readonly SkillDimensionCriteria[];
  readonly threshold: QualityThreshold;
  readonly requiredSections: readonly string[];
  readonly minWordCount: number;
}
