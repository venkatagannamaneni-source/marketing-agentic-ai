// ── Event Types ──────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  "traffic_drop",
  "conversion_drop",
  "competitor_launch",
  "email_bounce_spike",
  "ab_test_significant",
  "new_feature_shipped",
  "new_blog_post",
  "budget_warning",
  "budget_critical",
  "agent_failure",
  "pipeline_blocked",
  "manual_goal",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// ── System Event ─────────────────────────────────────────────────────────────

export interface SystemEvent {
  readonly id: string;
  readonly type: EventType;
  readonly timestamp: string;
  readonly source: string;
  readonly data: Record<string, unknown>;
}

// ── Schedule Entry ───────────────────────────────────────────────────────────

export interface ScheduleEntry {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly pipelineId: string;
  readonly enabled: boolean;
  readonly description: string;
}
