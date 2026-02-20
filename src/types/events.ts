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

import type { Priority } from "./task.ts";
import type { GoalCategory } from "./goal.ts";

export interface ScheduleEntry {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly pipelineId: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly priority?: Priority;
  readonly goalCategory?: GoalCategory;
}

// ── Schedule State (persisted operational data) ─────────────────────────────

export interface ScheduleState {
  readonly scheduleId: string;
  readonly lastFiredAt: string | null;
  readonly lastSkipReason: string | null;
  readonly fireCount: number;
}
