import { describe, expect, it } from "bun:test";
import {
  GoalDecomposer,
  GOAL_CATEGORY_TEMPLATE_MAP,
} from "../goal-decomposer.ts";
import { PIPELINE_TEMPLATES } from "../../agents/registry.ts";
import { SkillRegistry } from "../../agents/skill-registry.ts";
import type { SkillRegistryData } from "../../agents/skill-registry.ts";
import { GOAL_CATEGORIES } from "../types.ts";
import type { GoalCategory } from "../types.ts";
import { routeGoal } from "../squad-router.ts";
import { createTestGoal } from "./helpers.ts";

const decomposer = new GoalDecomposer(PIPELINE_TEMPLATES);

describe("GOAL_CATEGORY_TEMPLATE_MAP", () => {
  it("maps content to Content Production", () => {
    expect(GOAL_CATEGORY_TEMPLATE_MAP.content).toBe("Content Production");
  });

  it("maps optimization to Conversion Sprint", () => {
    expect(GOAL_CATEGORY_TEMPLATE_MAP.optimization).toBe("Conversion Sprint");
  });

  it("maps retention to Retention Sprint", () => {
    expect(GOAL_CATEGORY_TEMPLATE_MAP.retention).toBe("Retention Sprint");
  });

  it("maps competitive to Competitive Response", () => {
    expect(GOAL_CATEGORY_TEMPLATE_MAP.competitive).toBe(
      "Competitive Response",
    );
  });

  it("maps measurement to SEO Cycle", () => {
    expect(GOAL_CATEGORY_TEMPLATE_MAP.measurement).toBe("SEO Cycle");
  });

  it("maps strategic to null (custom plan)", () => {
    expect(GOAL_CATEGORY_TEMPLATE_MAP.strategic).toBeNull();
  });
});

describe("GoalDecomposer", () => {
  describe("findMatchingTemplate", () => {
    it("returns Content Production for content category", () => {
      const template = decomposer.findMatchingTemplate("content");
      expect(template).not.toBeNull();
      expect(template!.name).toBe("Content Production");
    });

    it("returns Conversion Sprint for optimization category", () => {
      const template = decomposer.findMatchingTemplate("optimization");
      expect(template).not.toBeNull();
      expect(template!.name).toBe("Conversion Sprint");
    });

    it("returns Retention Sprint for retention category", () => {
      const template = decomposer.findMatchingTemplate("retention");
      expect(template!.name).toBe("Retention Sprint");
    });

    it("returns Competitive Response for competitive category", () => {
      const template = decomposer.findMatchingTemplate("competitive");
      expect(template!.name).toBe("Competitive Response");
    });

    it("returns SEO Cycle for measurement category", () => {
      const template = decomposer.findMatchingTemplate("measurement");
      expect(template!.name).toBe("SEO Cycle");
    });

    it("returns null for strategic category", () => {
      const template = decomposer.findMatchingTemplate("strategic");
      expect(template).toBeNull();
    });
  });

  describe("templateToPhases", () => {
    it("converts sequential steps to sequential phases", () => {
      const template = PIPELINE_TEMPLATES.find(
        (t) => t.name === "Content Production",
      )!;
      const phases = decomposer.templateToPhases(template);
      expect(phases.length).toBe(5); // 5 sequential steps
      for (const phase of phases) {
        expect(phase.parallel).toBe(false);
        expect(phase.skills.length).toBe(1);
      }
    });

    it("converts parallel step arrays to parallel phases", () => {
      const template = PIPELINE_TEMPLATES.find(
        (t) => t.name === "Product Launch",
      )!;
      const phases = decomposer.templateToPhases(template);
      expect(phases.length).toBe(2);
      expect(phases[0]!.parallel).toBe(false);
      expect(phases[0]!.skills).toEqual(["launch-strategy"]);
      expect(phases[1]!.parallel).toBe(true);
      expect(phases[1]!.skills.length).toBe(4);
    });

    it("sets dependsOnPhase correctly", () => {
      const template = PIPELINE_TEMPLATES.find(
        (t) => t.name === "Content Production",
      )!;
      const phases = decomposer.templateToPhases(template);
      expect(phases[0]!.dependsOnPhase).toBeNull();
      expect(phases[1]!.dependsOnPhase).toBe(0);
      expect(phases[2]!.dependsOnPhase).toBe(1);
    });

    it("handles SEO Cycle template with mixed sequential/parallel", () => {
      const template = PIPELINE_TEMPLATES.find(
        (t) => t.name === "SEO Cycle",
      )!;
      const phases = decomposer.templateToPhases(template);
      expect(phases.length).toBe(2);
      expect(phases[0]!.parallel).toBe(false);
      expect(phases[0]!.skills).toEqual(["seo-audit"]);
      expect(phases[1]!.parallel).toBe(true);
      expect(phases[1]!.skills).toContain("programmatic-seo");
      expect(phases[1]!.skills).toContain("schema-markup");
      expect(phases[1]!.skills).toContain("content-strategy");
    });
  });

  describe("routingToPhases", () => {
    it("builds phases from strategic routing decision", () => {
      const routing = routeGoal("strategic");
      const phases = decomposer.routingToPhases(routing, "strategic");
      expect(phases.length).toBe(routing.routes.length);
      expect(phases[0]!.name).toBe("PLAN");
      expect(phases[1]!.name).toBe("MEASURE");
    });

    it("builds phases from content routing decision", () => {
      const routing = routeGoal("content");
      const phases = decomposer.routingToPhases(routing, "content");
      expect(phases.length).toBe(3);
      expect(phases[0]!.name).toBe("PLAN");
      expect(phases[1]!.name).toBe("CREATE");
      expect(phases[2]!.name).toBe("MEASURE");
    });

    it("builds phases with correct skill assignments for retention goals", () => {
      const routing = routeGoal("retention");
      const phases = decomposer.routingToPhases(routing, "retention");
      expect(phases[0]!.skills).toContain("onboarding-cro");
      expect(phases[0]!.skills).toContain("email-sequence");
    });

    it("sets dependsOnPhase correctly", () => {
      const routing = routeGoal("competitive");
      const phases = decomposer.routingToPhases(routing, "competitive");
      expect(phases[0]!.dependsOnPhase).toBeNull();
      for (let i = 1; i < phases.length; i++) {
        expect(phases[i]!.dependsOnPhase).toBe(i - 1);
      }
    });

    it("determines parallelism based on dependency graph", () => {
      const routing = routeGoal("optimization");
      const phases = decomposer.routingToPhases(routing, "optimization");
      // Convert squad has page-cro → form-cro/popup-cro dependencies
      const convertPhase = phases[0]!;
      // page-cro has downstream to form-cro and popup-cro, so they can't all be parallel
      expect(convertPhase.parallel).toBe(false);
    });
  });

  describe("decompose", () => {
    it("produces a GoalPlan from a content goal using template", () => {
      const goal = createTestGoal({ category: "content" });
      const routing = routeGoal("content");
      const plan = decomposer.decompose(goal, routing);
      expect(plan.goalId).toBe(goal.id);
      expect(plan.pipelineTemplateName).toBe("Content Production");
      expect(plan.phases.length).toBe(5); // Content Production has 5 steps
    });

    it("produces a GoalPlan from a strategic goal using custom routing", () => {
      const goal = createTestGoal({ category: "strategic" });
      const routing = routeGoal("strategic");
      const plan = decomposer.decompose(goal, routing);
      expect(plan.goalId).toBe(goal.id);
      expect(plan.pipelineTemplateName).toBeNull();
      expect(plan.phases.length).toBe(routing.routes.length);
    });

    it("produces a GoalPlan from an optimization goal using Conversion Sprint", () => {
      const goal = createTestGoal({ category: "optimization" });
      const routing = routeGoal("optimization");
      const plan = decomposer.decompose(goal, routing);
      expect(plan.pipelineTemplateName).toBe("Conversion Sprint");
    });

    it("returns correct estimatedTaskCount", () => {
      const goal = createTestGoal({ category: "content" });
      const routing = routeGoal("content");
      const plan = decomposer.decompose(goal, routing);
      const totalSkills = plan.phases.reduce(
        (sum, p) => sum + p.skills.length,
        0,
      );
      expect(plan.estimatedTaskCount).toBe(totalSkills);
    });

    it("handles all goal categories without error", () => {
      for (const category of GOAL_CATEGORIES) {
        const goal = createTestGoal({ category });
        const routing = routeGoal(category);
        const plan = decomposer.decompose(goal, routing);
        expect(plan.goalId).toBe(goal.id);
        expect(plan.phases.length).toBeGreaterThan(0);
        expect(plan.estimatedTaskCount).toBeGreaterThan(0);
      }
    });
  });

  describe("canRunParallel", () => {
    it("returns true for empty skill list", () => {
      expect(decomposer.canRunParallel([])).toBe(true);
    });

    it("returns true for single-skill list", () => {
      expect(decomposer.canRunParallel(["copywriting"])).toBe(true);
    });

    it("returns true for skills with no dependency between them", () => {
      // social-content and cold-email have no dependency relationship
      expect(
        decomposer.canRunParallel(["social-content", "cold-email"]),
      ).toBe(true);
    });

    it("returns false when one skill is upstream of another", () => {
      // copywriting → page-cro (copywriting produces for page-cro)
      expect(
        decomposer.canRunParallel(["copywriting", "page-cro"]),
      ).toBe(false);
    });

    it("returns false when dependency exists in either direction", () => {
      // content-strategy → copywriting
      expect(
        decomposer.canRunParallel(["content-strategy", "copywriting"]),
      ).toBe(false);
    });

    it("returns true for parallel skills from Product Launch template", () => {
      // email-sequence, social-content, paid-ads have no direct dependencies
      expect(
        decomposer.canRunParallel([
          "email-sequence",
          "social-content",
          "paid-ads",
        ]),
      ).toBe(true);
    });
  });
});

// ── GoalDecomposer with SkillRegistry ─────────────────────────────────────────

describe("GoalDecomposer with SkillRegistry", () => {
  // Registry where social-content depends on cold-email (reversed from defaults)
  const registryData: SkillRegistryData = {
    squads: {
      creative: { description: "Creative squad" },
      strategy: { description: "Strategy squad" },
    },
    foundation_skill: "product-marketing-context",
    skills: {
      "product-marketing-context": {
        squad: null,
        description: "Foundation",
        downstream: "all",
      },
      "social-content": {
        squad: "creative",
        description: "Social",
        downstream: ["cold-email"],
      },
      "cold-email": {
        squad: "creative",
        description: "Email",
        downstream: [],
      },
      "copywriting": {
        squad: "creative",
        description: "Copy",
        downstream: [],
      },
      "content-strategy": {
        squad: "strategy",
        description: "Strategy",
        downstream: [],
      },
    },
  };

  const registry = SkillRegistry.fromData(registryData);
  const decomposerWithRegistry = new GoalDecomposer(PIPELINE_TEMPLATES, registry);

  it("uses registry dependency graph for canRunParallel", () => {
    // In registry: social-content → cold-email (dependent)
    expect(
      decomposerWithRegistry.canRunParallel(["social-content", "cold-email"]),
    ).toBe(false);
  });

  it("detects independence using registry graph", () => {
    // In registry: cold-email and copywriting have no dependency
    expect(
      decomposerWithRegistry.canRunParallel(["cold-email", "copywriting"]),
    ).toBe(true);
  });

  it("uses hardcoded defaults when no registry is provided", () => {
    const decomposerNoRegistry = new GoalDecomposer(PIPELINE_TEMPLATES);
    // In hardcoded defaults: social-content and cold-email have no dependency
    expect(
      decomposerNoRegistry.canRunParallel(["social-content", "cold-email"]),
    ).toBe(true);
  });

  it("decompose still works with custom registry", () => {
    const goal = createTestGoal({ category: "content" });
    const routing = routeGoal("content");
    const plan = decomposerWithRegistry.decompose(goal, routing);
    expect(plan.goalId).toBe(goal.id);
    expect(plan.phases.length).toBeGreaterThan(0);
  });
});
