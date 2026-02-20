import type { ScheduleEntry } from "../types/events.ts";

// ── Default Schedules ───────────────────────────────────────────────────────
//
// 6 predefined schedule entries:
// - 3 template-based (pipelineId matches a PIPELINE_TEMPLATES name)
// - 3 goal-based (pipelineId starts with "goal:" for Director goal creation)

export const DEFAULT_SCHEDULES: readonly ScheduleEntry[] = [
  // ── Daily ─────────────────────────────────────────────────────────────
  {
    id: "daily-social",
    name: "Daily Social Content",
    cron: "0 6 * * *",
    pipelineId: "goal:social-content",
    enabled: true,
    description: "Generate daily social media content at 6 AM",
    priority: "P2",
    goalCategory: "content",
  },
  {
    id: "daily-review",
    name: "Daily Director Review",
    cron: "0 9 * * *",
    pipelineId: "goal:director-review",
    enabled: true,
    description: "Director reviews previous day results at 9 AM",
    priority: "P1",
    goalCategory: "measurement",
  },

  // ── Weekly ────────────────────────────────────────────────────────────
  {
    id: "weekly-content",
    name: "Weekly Content Production",
    cron: "0 0 * * 1",
    pipelineId: "Content Production",
    enabled: true,
    description: "Weekly content pipeline from strategy to publication on Mondays",
    priority: "P2",
    goalCategory: "content",
  },
  {
    id: "weekly-seo",
    name: "Weekly SEO Cycle",
    cron: "0 0 * * 3",
    pipelineId: "SEO Cycle",
    enabled: true,
    description: "Weekly SEO audit and response cycle on Wednesdays",
    priority: "P2",
    goalCategory: "measurement",
  },

  // ── Monthly ───────────────────────────────────────────────────────────
  {
    id: "monthly-cro",
    name: "Monthly Conversion Sprint",
    cron: "0 0 1 * *",
    pipelineId: "Conversion Sprint",
    enabled: true,
    description: "Monthly CRO audit and optimization on the 1st",
    priority: "P1",
    goalCategory: "optimization",
  },
  {
    id: "monthly-review",
    name: "Monthly Performance Review",
    cron: "0 0 15 * *",
    pipelineId: "goal:performance-review",
    enabled: true,
    description: "Mid-month performance review and strategy adjustment on the 15th",
    priority: "P1",
    goalCategory: "measurement",
  },
];
