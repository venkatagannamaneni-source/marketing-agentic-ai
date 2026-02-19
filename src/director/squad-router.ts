import type { SkillName } from "../types/agent.ts";
import type { GoalCategory, RoutingDecision, SquadRoute } from "./types.ts";

// ── Routing Rules ────────────────────────────────────────────────────────────
// Static config encoding the Director decision rules from PROJECT_PROPOSAL.md.
// Each goal category maps to an ordered sequence of squad routes.

export const ROUTING_RULES: Record<GoalCategory, readonly SquadRoute[]> = {
  strategic: [
    {
      squad: "strategy",
      skills: [
        "content-strategy",
        "pricing-strategy",
        "launch-strategy",
        "marketing-ideas",
        "marketing-psychology",
        "competitor-alternatives",
      ],
      reason: "Strategic goals route directly to the Strategy Squad",
    },
    {
      squad: "measure",
      skills: ["analytics-tracking"],
      reason: "Measure Squad closes the feedback loop",
    },
  ],
  content: [
    {
      squad: "strategy",
      skills: ["content-strategy"],
      reason: "Content goals start with a content strategy",
    },
    {
      squad: "creative",
      skills: [
        "copywriting",
        "copy-editing",
        "social-content",
        "programmatic-seo",
        "schema-markup",
      ],
      reason:
        "Creative Squad produces the content with Strategy output as input",
    },
    {
      squad: "measure",
      skills: ["seo-audit", "analytics-tracking"],
      reason: "Measure Squad audits and tracks the content",
    },
  ],
  optimization: [
    {
      squad: "convert",
      skills: ["page-cro", "form-cro", "signup-flow-cro", "popup-cro"],
      reason: "Convert Squad audits existing touchpoints first",
    },
    {
      squad: "creative",
      skills: ["copywriting"],
      reason: "Creative Squad executes rewrites based on audit findings",
    },
    {
      squad: "measure",
      skills: ["ab-test-setup", "analytics-tracking"],
      reason: "Measure Squad tests and tracks the changes",
    },
  ],
  retention: [
    {
      squad: "activate",
      skills: [
        "onboarding-cro",
        "email-sequence",
        "paywall-upgrade-cro",
        "referral-program",
      ],
      reason: "Activate Squad handles retention-focused work",
    },
    {
      squad: "measure",
      skills: ["ab-test-setup", "analytics-tracking"],
      reason: "Measure Squad tests and tracks retention changes",
    },
  ],
  competitive: [
    {
      squad: "strategy",
      skills: ["competitor-alternatives"],
      reason: "Strategy Squad researches the competitive landscape",
    },
    {
      squad: "creative",
      skills: ["copywriting", "paid-ads"],
      reason: "Creative Squad produces response content and ads",
    },
    {
      squad: "strategy",
      skills: ["pricing-strategy"],
      reason: "Strategy Squad may adjust pricing in response",
    },
    {
      squad: "measure",
      skills: ["analytics-tracking"],
      reason: "Measure Squad tracks competitive response effectiveness",
    },
  ],
  measurement: [
    {
      squad: "measure",
      skills: ["seo-audit", "analytics-tracking", "ab-test-setup"],
      reason: "Measurement goals route directly to Measure Squad",
    },
  ],
};

/**
 * Route a goal category to the appropriate squad sequence.
 */
export function routeGoal(category: GoalCategory): RoutingDecision {
  const routes = ROUTING_RULES[category];
  return {
    goalCategory: category,
    routes,
    measureSquadFinal: true,
  };
}

/**
 * Flatten a routing decision into a de-duplicated, ordered skill list.
 */
export function selectSkills(routing: RoutingDecision): readonly SkillName[] {
  const skills: SkillName[] = [];
  for (const route of routing.routes) {
    for (const skill of route.skills) {
      if (!skills.includes(skill)) {
        skills.push(skill);
      }
    }
  }
  return skills;
}
