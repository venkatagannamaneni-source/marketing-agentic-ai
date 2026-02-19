import type { SkillName } from "../types/agent.ts";
import type { Priority } from "../types/task.ts";
import { SKILL_NAMES } from "../types/agent.ts";

// ── Agent Dependency Graph ───────────────────────────────────────────────────
// Producer → Consumer relationships from PROJECT_PROPOSAL.md Appendix A.
// Each key produces output consumed by the listed skills.

export const AGENT_DEPENDENCY_GRAPH: Record<SkillName, readonly SkillName[]> = {
  // Foundation — consumed by all 25 other agents
  "product-marketing-context": SKILL_NAMES.filter(
    (s) => s !== "product-marketing-context",
  ),

  // Strategy → Creative
  "content-strategy": ["copywriting", "programmatic-seo", "social-content"],
  "pricing-strategy": ["copywriting", "page-cro"],
  "launch-strategy": [
    "email-sequence",
    "social-content",
    "paid-ads",
    "page-cro",
  ],
  "competitor-alternatives": ["copywriting", "programmatic-seo"],
  "marketing-ideas": [],
  "marketing-psychology": [],

  // Creative → Convert
  "copywriting": ["page-cro", "copy-editing"],
  "copy-editing": ["page-cro"],

  // Convert → Creative (iteration loop)
  "page-cro": ["copywriting", "form-cro", "popup-cro"],
  "signup-flow-cro": ["onboarding-cro"],

  // Activate → Measure
  "onboarding-cro": ["email-sequence"],
  "email-sequence": ["analytics-tracking"],
  "referral-program": ["analytics-tracking"],
  "paywall-upgrade-cro": [],

  // Measure → feedback
  "analytics-tracking": [],
  "ab-test-setup": [],
  "seo-audit": ["content-strategy", "programmatic-seo"],

  // No direct downstream consumers
  "social-content": [],
  "cold-email": [],
  "paid-ads": [],
  "programmatic-seo": [],
  "schema-markup": [],
  "form-cro": [],
  "popup-cro": [],
  "free-tool-strategy": [],
};

/**
 * Get upstream producers for a given skill (skills whose output this skill consumes).
 */
export function getUpstreamSkills(skill: SkillName): SkillName[] {
  const upstream: SkillName[] = [];
  for (const [producer, consumers] of Object.entries(AGENT_DEPENDENCY_GRAPH)) {
    if ((consumers as readonly string[]).includes(skill)) {
      upstream.push(producer as SkillName);
    }
  }
  return upstream;
}

/**
 * Get downstream consumers for a given skill.
 */
export function getDownstreamSkills(skill: SkillName): readonly SkillName[] {
  return AGENT_DEPENDENCY_GRAPH[skill];
}

// ── Pipeline Templates ───────────────────────────────────────────────────────
// Built-in pipelines from PROJECT_PROPOSAL.md Section 4.
// Steps are either a single SkillName (sequential) or an array (parallel).

export interface PipelineTemplate {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly (SkillName | readonly SkillName[])[];
  readonly trigger: string;
  readonly defaultPriority: Priority;
}

export const PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  {
    name: "Content Production",
    description: "Weekly content pipeline from strategy to publication",
    steps: [
      "content-strategy",
      "copywriting",
      "copy-editing",
      "seo-audit",
      "schema-markup",
    ],
    trigger: "weekly",
    defaultPriority: "P2",
  },
  {
    name: "Page Launch",
    description: "Optimize and instrument a new page",
    steps: ["copywriting", "page-cro", "ab-test-setup", "analytics-tracking"],
    trigger: "new page created",
    defaultPriority: "P1",
  },
  {
    name: "Product Launch",
    description: "Full launch campaign across channels",
    steps: [
      "launch-strategy",
      ["copywriting", "email-sequence", "social-content", "paid-ads"],
    ],
    trigger: "launch date approaching",
    defaultPriority: "P0",
  },
  {
    name: "Conversion Sprint",
    description: "Monthly CRO cycle with measurement",
    steps: ["page-cro", "copywriting", "ab-test-setup", "analytics-tracking"],
    trigger: "monthly",
    defaultPriority: "P1",
  },
  {
    name: "Competitive Response",
    description: "React to competitor launches",
    steps: [
      "competitor-alternatives",
      "copywriting",
      "pricing-strategy",
      "paid-ads",
    ],
    trigger: "competitor launch detected",
    defaultPriority: "P1",
  },
  {
    name: "Retention Sprint",
    description: "Address churn with activation improvements",
    steps: [
      "onboarding-cro",
      "email-sequence",
      "paywall-upgrade-cro",
      "ab-test-setup",
    ],
    trigger: "churn spike detected",
    defaultPriority: "P1",
  },
  {
    name: "SEO Cycle",
    description: "Monthly SEO audit and response",
    steps: [
      "seo-audit",
      ["programmatic-seo", "schema-markup", "content-strategy"],
    ],
    trigger: "monthly",
    defaultPriority: "P2",
  },
  {
    name: "Outreach Campaign",
    description: "Cold email campaign with testing",
    steps: ["cold-email", "ab-test-setup", "analytics-tracking"],
    trigger: "new prospect list available",
    defaultPriority: "P2",
  },
];
