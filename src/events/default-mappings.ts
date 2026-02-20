import type { EventMapping } from "./event-bus.ts";

// ── Default Event Mappings ──────────────────────────────────────────────────
// Pre-configured mappings from external events to pipeline templates.
// Internal events (budget_warning, budget_critical, agent_failure, pipeline_blocked)
// are intentionally excluded — they are emitted for logging/observability only.
// Users can add custom mappings for internal events if desired.

export const DEFAULT_EVENT_MAPPINGS: readonly EventMapping[] = [
  {
    eventType: "traffic_drop",
    pipelineTemplate: "SEO Cycle",
    priority: "P1",
    condition: (event) => {
      const drop = event.data.percentageDrop;
      return typeof drop === "number" && drop > 20;
    },
    cooldownMs: 3_600_000, // 1 hour
  },
  {
    eventType: "conversion_drop",
    pipelineTemplate: "Conversion Sprint",
    priority: "P0",
    condition: (event) => {
      const drop = event.data.percentageDrop;
      return typeof drop === "number" && drop > 10;
    },
    cooldownMs: 3_600_000,
  },
  {
    eventType: "competitor_launch",
    pipelineTemplate: "Competitive Response",
    priority: "P1",
    cooldownMs: 86_400_000, // 24 hours
  },
  {
    eventType: "new_feature_shipped",
    pipelineTemplate: "Page Launch",
    priority: "P1",
    cooldownMs: 300_000, // 5 minutes — debounce rapid deploys
  },
  {
    eventType: "new_blog_post",
    pipelineTemplate: "Content Production",
    priority: "P2",
    cooldownMs: 300_000,
  },
  {
    eventType: "email_bounce_spike",
    pipelineTemplate: "Retention Sprint",
    priority: "P1",
    condition: (event) => {
      const spike = event.data.percentageSpike;
      return typeof spike === "number" && spike > 15;
    },
    cooldownMs: 3_600_000,
  },
  {
    eventType: "ab_test_significant",
    pipelineTemplate: "Conversion Sprint",
    priority: "P1",
    cooldownMs: 300_000,
  },
];
