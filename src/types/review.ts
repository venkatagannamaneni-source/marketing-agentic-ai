import type { SkillName } from "./agent.ts";

// ── Review Verdict ───────────────────────────────────────────────────────────

export const REVIEW_VERDICTS = ["APPROVE", "REVISE", "REJECT"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

// ── Review Structure ─────────────────────────────────────────────────────────

export type FindingSeverity = "critical" | "major" | "minor" | "suggestion";

export interface ReviewFinding {
  readonly section: string;
  readonly severity: FindingSeverity;
  readonly description: string;
}

export type RevisionPriority = "required" | "recommended" | "optional";

export interface RevisionRequest {
  readonly description: string;
  readonly priority: RevisionPriority;
}

export interface Review {
  readonly id: string;
  readonly taskId: string;
  readonly createdAt: string;

  readonly reviewer: SkillName | "director";
  readonly author: SkillName;

  readonly verdict: ReviewVerdict;
  readonly findings: readonly ReviewFinding[];
  readonly revisionRequests: readonly RevisionRequest[];

  readonly summary: string;
}
