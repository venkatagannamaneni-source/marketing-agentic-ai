import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  SkillRegistry,
  SkillRegistryError,
  type SkillRegistryData,
} from "../skill-registry.ts";
import { SKILL_NAMES, SQUAD_NAMES, SKILL_SQUAD_MAP } from "../../types/agent.ts";
import { AGENT_DEPENDENCY_GRAPH } from "../registry.ts";

// ── Test Data ────────────────────────────────────────────────────────────────

const MINIMAL_DATA: SkillRegistryData = {
  squads: {
    alpha: { description: "Alpha squad" },
    beta: { description: "Beta squad" },
  },
  foundation_skill: "foundation",
  skills: {
    foundation: {
      squad: null,
      description: "Foundation skill",
      downstream: "all",
    },
    "skill-a": {
      squad: "alpha",
      description: "Skill A",
      downstream: ["skill-b"],
    },
    "skill-b": {
      squad: "beta",
      description: "Skill B",
      downstream: [],
    },
  },
};

// ── fromData ─────────────────────────────────────────────────────────────────

describe("SkillRegistry.fromData", () => {
  it("creates registry with correct skill count", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    expect(registry.skillNames).toHaveLength(3);
  });

  it("creates registry with correct squad count", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    expect(registry.squadNames).toHaveLength(2);
  });

  it("sets foundation skill", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    expect(registry.foundationSkill).toBe("foundation");
  });

  it("builds skillSquadMap", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    expect(registry.skillSquadMap["foundation"]).toBeNull();
    expect(registry.skillSquadMap["skill-a"]).toBe("alpha");
    expect(registry.skillSquadMap["skill-b"]).toBe("beta");
  });

  it("builds squad descriptions", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    expect(registry.squadDescriptions["alpha"]).toBe("Alpha squad");
    expect(registry.squadDescriptions["beta"]).toBe("Beta squad");
  });

  it("expands 'downstream: all' to all other skills", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    const consumers = registry.dependencyGraph["foundation"];
    expect(consumers).toHaveLength(2);
    expect(consumers).toContain("skill-a");
    expect(consumers).toContain("skill-b");
    expect(consumers).not.toContain("foundation");
  });

  it("preserves explicit downstream lists", () => {
    const registry = SkillRegistry.fromData(MINIMAL_DATA);
    expect(registry.dependencyGraph["skill-a"]).toEqual(["skill-b"]);
    expect(registry.dependencyGraph["skill-b"]).toEqual([]);
  });
});

// ── Query Methods ────────────────────────────────────────────────────────────

describe("SkillRegistry query methods", () => {
  const registry = SkillRegistry.fromData(MINIMAL_DATA);

  it("getSquadSkills returns skills for a squad", () => {
    expect(registry.getSquadSkills("alpha")).toEqual(["skill-a"]);
    expect(registry.getSquadSkills("beta")).toEqual(["skill-b"]);
  });

  it("getSquadSkills returns empty for unknown squad", () => {
    expect(registry.getSquadSkills("unknown")).toEqual([]);
  });

  it("getUpstreamSkills returns producers", () => {
    // skill-b is consumed by skill-a and foundation
    const upstream = registry.getUpstreamSkills("skill-b");
    expect(upstream).toContain("foundation");
    expect(upstream).toContain("skill-a");
  });

  it("getUpstreamSkills returns empty for root skills", () => {
    // foundation has no upstream (nothing produces for it)
    expect(registry.getUpstreamSkills("foundation")).toEqual([]);
  });

  it("getDownstreamSkills returns consumers", () => {
    expect(registry.getDownstreamSkills("skill-a")).toEqual(["skill-b"]);
  });

  it("getDownstreamSkills returns empty for unknown skill", () => {
    expect(registry.getDownstreamSkills("nonexistent")).toEqual([]);
  });

  it("isValidSkill returns true for registered skills", () => {
    expect(registry.isValidSkill("foundation")).toBe(true);
    expect(registry.isValidSkill("skill-a")).toBe(true);
  });

  it("isValidSkill returns false for unknown skills", () => {
    expect(registry.isValidSkill("unknown")).toBe(false);
  });

  it("isValidSquad returns true for registered squads", () => {
    expect(registry.isValidSquad("alpha")).toBe(true);
  });

  it("isValidSquad returns false for unknown squads", () => {
    expect(registry.isValidSquad("unknown")).toBe(false);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("SkillRegistry validation", () => {
  it("rejects unknown squad reference", () => {
    const bad: SkillRegistryData = {
      squads: { alpha: { description: "A" } },
      foundation_skill: "f",
      skills: {
        f: { squad: null, description: "F", downstream: [] },
        x: { squad: "nonexistent", description: "X", downstream: [] },
      },
    };
    expect(() => SkillRegistry.fromData(bad)).toThrow(SkillRegistryError);
    expect(() => SkillRegistry.fromData(bad)).toThrow(
      /unknown squad "nonexistent"/,
    );
  });

  it("rejects unknown downstream target", () => {
    const bad: SkillRegistryData = {
      squads: { alpha: { description: "A" } },
      foundation_skill: "f",
      skills: {
        f: { squad: null, description: "F", downstream: ["ghost"] },
        a: { squad: "alpha", description: "A", downstream: [] },
      },
    };
    expect(() => SkillRegistry.fromData(bad)).toThrow(SkillRegistryError);
    expect(() => SkillRegistry.fromData(bad)).toThrow(
      /unknown downstream skill "ghost"/,
    );
  });

  it("rejects missing foundation skill", () => {
    const bad: SkillRegistryData = {
      squads: { alpha: { description: "A" } },
      foundation_skill: "missing",
      skills: {
        a: { squad: "alpha", description: "A", downstream: [] },
      },
    };
    expect(() => SkillRegistry.fromData(bad)).toThrow(SkillRegistryError);
    expect(() => SkillRegistry.fromData(bad)).toThrow(
      /Foundation skill "missing" not found/,
    );
  });

  it("rejects orphan squads (squad with no skills)", () => {
    const bad: SkillRegistryData = {
      squads: {
        alpha: { description: "A" },
        orphan: { description: "No skills" },
      },
      foundation_skill: "f",
      skills: {
        f: { squad: null, description: "F", downstream: [] },
        a: { squad: "alpha", description: "A", downstream: [] },
      },
    };
    expect(() => SkillRegistry.fromData(bad)).toThrow(SkillRegistryError);
    expect(() => SkillRegistry.fromData(bad)).toThrow(
      /Squad "orphan" has no skills/,
    );
  });

  it("collects multiple errors", () => {
    const bad: SkillRegistryData = {
      squads: { orphan: { description: "Empty" } },
      foundation_skill: "missing",
      skills: {
        x: { squad: "nope", description: "X", downstream: ["ghost"] },
      },
    };
    try {
      SkillRegistry.fromData(bad);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillRegistryError);
      const err = e as SkillRegistryError;
      expect(err.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ── YAML Loading ─────────────────────────────────────────────────────────────

describe("SkillRegistry.fromYaml", () => {
  const yamlPath = resolve(
    import.meta.dir,
    "../../../.agents/skills.yaml",
  );

  it("loads .agents/skills.yaml successfully", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    expect(registry.skillNames.length).toBe(26);
    expect(registry.squadNames.length).toBe(5);
  });

  it("has product-marketing-context as foundation skill", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    expect(registry.foundationSkill).toBe("product-marketing-context");
  });

  it("foundation skill produces for all 25 other skills", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const consumers = registry.dependencyGraph["product-marketing-context"];
    expect(consumers).toHaveLength(25);
    expect(consumers).not.toContain("product-marketing-context");
  });

  it("has correct squad assignments", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    expect(registry.getSquadSkills("strategy")).toHaveLength(6);
    expect(registry.getSquadSkills("creative")).toHaveLength(7);
    expect(registry.getSquadSkills("convert")).toHaveLength(5);
    expect(registry.getSquadSkills("activate")).toHaveLength(4);
    expect(registry.getSquadSkills("measure")).toHaveLength(3);
  });
});

// ── YAML ↔ Defaults Sync ────────────────────────────────────────────────────

describe("YAML matches TypeScript defaults", () => {
  const yamlPath = resolve(
    import.meta.dir,
    "../../../.agents/skills.yaml",
  );

  it("skill names match", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const yamlSkills = [...registry.skillNames].sort();
    const tsSkills = [...SKILL_NAMES].sort();
    expect(yamlSkills).toEqual(tsSkills);
  });

  it("squad names match", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    const yamlSquads = [...registry.squadNames].sort();
    const tsSquads = [...SQUAD_NAMES].sort();
    expect(yamlSquads).toEqual(tsSquads);
  });

  it("skill-squad map matches", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    for (const skill of SKILL_NAMES) {
      expect(registry.skillSquadMap[skill]).toBe(SKILL_SQUAD_MAP[skill]);
    }
  });

  it("dependency graph matches", async () => {
    const registry = await SkillRegistry.fromYaml(yamlPath);
    for (const skill of SKILL_NAMES) {
      const yamlDownstream = [...registry.getDownstreamSkills(skill)].sort();
      const tsDownstream = [...(AGENT_DEPENDENCY_GRAPH[skill] ?? [])].sort();
      expect(yamlDownstream).toEqual(tsDownstream);
    }
  });
});
