import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { buildDirectorPrompt, DIRECTOR_SYSTEM_PROMPT } from "../system-prompt.ts";
import {
  SkillRegistry,
  type SkillRegistryData,
} from "../../agents/skill-registry.ts";

// ── Test Data ────────────────────────────────────────────────────────────────

const MINIMAL_DATA: SkillRegistryData = {
  squads: {
    ops: { description: "handles operations" },
  },
  foundation_skill: "base",
  skills: {
    base: {
      squad: null,
      description: "Foundation context",
      downstream: "all",
    },
    "task-a": {
      squad: "ops",
      description: "Does task A",
      downstream: ["task-b"],
    },
    "task-b": {
      squad: "ops",
      description: "Does task B",
      downstream: [],
    },
  },
};

const TWO_SQUAD_DATA: SkillRegistryData = {
  squads: {
    alpha: { description: "first squad" },
    beta: { description: "second squad" },
  },
  foundation_skill: "core",
  skills: {
    core: {
      squad: null,
      description: "Core context",
      downstream: "all",
    },
    "alpha-1": {
      squad: "alpha",
      description: "Alpha skill one",
      downstream: [],
    },
    "alpha-2": {
      squad: "alpha",
      description: "Alpha skill two",
      downstream: [],
    },
    "beta-1": {
      squad: "beta",
      description: "Beta skill one",
      downstream: [],
    },
  },
};

// ── buildDirectorPrompt ─────────────────────────────────────────────────────

describe("buildDirectorPrompt", () => {
  it("contains correct agent count (excludes foundation skill)", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const prompt = buildDirectorPrompt(registry);
    // 2 squad-assigned skills (task-a, task-b), not 3 (base has squad: null)
    expect(prompt).toContain("2 specialized marketing AI agents");
  });

  it("contains correct squad count", () => {
    const registry = SkillRegistry.fromData(TWO_SQUAD_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("2 squads");
  });

  it("lists all squads with title-cased names", () => {
    const registry = SkillRegistry.fromData(TWO_SQUAD_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("### Alpha Squad (first squad)");
    expect(prompt).toContain("### Beta Squad (second squad)");
  });

  it("lowercases first character of squad description in parenthetical", () => {
    const uppercaseData: SkillRegistryData = {
      squads: { dev: { description: "Builds software" } },
      foundation_skill: "ctx",
      skills: {
        ctx: { squad: null, description: "Context", downstream: "all" },
        "coder": { squad: "dev", description: "Writes code", downstream: [] },
      },
    };
    const registry = SkillRegistry.fromData(uppercaseData);
    const prompt = buildDirectorPrompt(registry);
    // "Builds" in YAML becomes "builds" in the parenthetical
    expect(prompt).toContain("### Dev Squad (builds software)");
  });

  it("lists all skills per squad with descriptions", () => {
    const registry = SkillRegistry.fromData(TWO_SQUAD_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("- alpha-1: Alpha skill one");
    expect(prompt).toContain("- alpha-2: Alpha skill two");
    expect(prompt).toContain("- beta-1: Beta skill one");
  });

  it("does not list foundation skill in any squad", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const prompt = buildDirectorPrompt(registry);
    // "base" is the foundation skill with squad: null
    expect(prompt).not.toContain("- base:");
  });

  it("contains static Decision Rules section", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("## Decision Rules");
    expect(prompt).toContain("Route to Strategy Squad");
  });

  it("contains static Review Standards section", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("## Review Standards");
    expect(prompt).toContain("APPROVE");
    expect(prompt).toContain("REVISE");
    expect(prompt).toContain("REJECT");
  });

  it("contains static Escalation Criteria section", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("## Escalation Criteria");
    expect(prompt).toContain("Budget");
  });

  it("contains static Output Format section", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("## Output Format");
  });

  it("contains static Memory and Learning section", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("## Memory and Learning");
    expect(prompt).toContain("learnings.md");
  });

  it("single-squad prompt only shows one squad", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("### Ops Squad (handles operations)");
    expect(prompt).toContain("1 squad");
  });
});

// ── Default registry matches legacy prompt ──────────────────────────────────

describe("buildDirectorPrompt with default registry", () => {
  const yamlPath = resolve(
    import.meta.dir,
    "../../../.agents/skills.yaml",
  );

  it("contains 25 agents and 5 squads (matching legacy prompt)", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const prompt = buildDirectorPrompt(registry);
    // 26 total skills minus 1 foundation = 25 squad-assigned agents
    expect(prompt).toContain("25 specialized marketing AI agents");
    expect(prompt).toContain("5 squads");
  });

  it("lists all 5 squad headers matching legacy prompt", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("Strategy Squad");
    expect(prompt).toContain("Creative Squad");
    expect(prompt).toContain("Convert Squad");
    expect(prompt).toContain("Activate Squad");
    expect(prompt).toContain("Measure Squad");
  });

  it("lists all 25 squad-assigned skills", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const prompt = buildDirectorPrompt(registry);
    for (const skill of registry.skillNames) {
      if (registry.skillSquadMap[skill] !== null) {
        expect(prompt).toContain(`- ${skill}:`);
      }
    }
  });

  it("includes skill descriptions matching legacy prompt", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).toContain("- content-strategy: Plans content pillars and topics");
    expect(prompt).toContain("- copywriting: Writes marketing page copy");
    expect(prompt).toContain("- analytics-tracking: Sets up GA4/GTM tracking");
  });

  it("does not list foundation skill", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const prompt = buildDirectorPrompt(registry);
    expect(prompt).not.toContain("- product-marketing-context:");
  });

  it("contains all static sections from legacy prompt", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const prompt = buildDirectorPrompt(registry);
    // Verify key sections exist (same as legacy DIRECTOR_SYSTEM_PROMPT)
    expect(prompt).toContain("## Your Role");
    expect(prompt).toContain("## Your Team");
    expect(prompt).toContain("## Decision Rules");
    expect(prompt).toContain("## Review Standards");
    expect(prompt).toContain("## Escalation Criteria");
    expect(prompt).toContain("## Output Format");
    expect(prompt).toContain("## Memory and Learning");
  });
});
