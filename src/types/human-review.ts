// ── Human Review Decision ────────────────────────────────────────────────────

export const HUMAN_REVIEW_DECISIONS = [
  "approve",
  "reject",
  "revise",
  "override_approve",
  "cancel",
] as const;

export type HumanReviewDecision = (typeof HUMAN_REVIEW_DECISIONS)[number];

// ── Human Review Status ──────────────────────────────────────────────────────

export const HUMAN_REVIEW_STATUSES = [
  "pending",
  "in_review",
  "resolved",
  "expired",
] as const;

export type HumanReviewStatus = (typeof HUMAN_REVIEW_STATUSES)[number];

// ── Human Review Urgency ─────────────────────────────────────────────────────

export const HUMAN_REVIEW_URGENCIES = [
  "critical",
  "high",
  "normal",
] as const;

export type HumanReviewUrgency = (typeof HUMAN_REVIEW_URGENCIES)[number];

// ── Human Feedback ───────────────────────────────────────────────────────────

export interface HumanFeedback {
  readonly decision: HumanReviewDecision;
  readonly reviewer: string;
  readonly notes: string;
  readonly revisionInstructions: string | null;
  readonly providedAt: string;
}

// ── Human Review Item ────────────────────────────────────────────────────────

export interface HumanReviewItem {
  readonly id: string;
  readonly taskId: string;
  readonly goalId: string | null;
  readonly pipelineId: string | null;
  readonly skill: string;
  readonly createdAt: string;
  readonly urgency: HumanReviewUrgency;
  readonly status: HumanReviewStatus;
  readonly escalationReason: string;
  readonly escalationMessage: string;
  readonly escalationContext: Record<string, unknown>;
  readonly feedback: HumanFeedback | null;
  readonly resolvedAt: string | null;
  readonly metadata: Record<string, unknown>;
}

// ── Human Review Filter ──────────────────────────────────────────────────────

export interface HumanReviewFilter {
  readonly status?: HumanReviewStatus | readonly HumanReviewStatus[];
  readonly urgency?: HumanReviewUrgency | readonly HumanReviewUrgency[];
  readonly skill?: string;
  readonly goalId?: string;
}

// ── Human Review Stats ───────────────────────────────────────────────────────

export interface HumanReviewStats {
  readonly total: number;
  readonly pending: number;
  readonly inReview: number;
  readonly resolved: number;
  readonly expired: number;
  readonly byUrgency: Record<HumanReviewUrgency, number>;
  readonly averageResolutionTimeMs: number | null;
}
