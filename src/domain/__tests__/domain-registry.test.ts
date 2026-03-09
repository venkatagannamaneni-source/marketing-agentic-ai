import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import {
  DomainRegistry,
  DomainRegistryError,
  type DomainConfigData,
} from "../domain-registry.ts";

// ── Minimal valid config ────────────────────────────────────────────────────

const MINIMAL_CONFIG: DomainConfigData = {
  domain: {
    name: "TestDomain",
    description: "A test domain",
    queue_name: "test-tasks",
  },
  categories: [
    {
      name: "general",
      default: true,
      patterns: [],
      template: null,
      phases: [{ name: "EXECUTE", description: "Do the work" }],
    },
    {
      name: "urgent",
      patterns: ["\\b(urgent|critical|asap)\\b"],
      template: "Fast Track",
      phases: [
        { name: "TRIAGE", description: "Assess urgency" },
        { name: "ACT", description: "Take immediate action" },
      ],
    },
  ],
  director: {
    role: "You coordinate all work.",
    decision_rules: "Route urgent tasks first.",
    review_standards: "Check completeness.",
    escalation_criteria: "Escalate budget issues.",
    output_format: "Use structured format.",
    memory: "Read context files before planning.",
  },
  quality: {
    dimensions: ["completeness", "accuracy"],
    thresholds: { approve_above: 7.0, revise_below: 7.0, reject_below: 4.0 },
    profiles: {
      default: [
        { dimension: "completeness", weight: 0.5, min_score: 5 },
        { dimension: "accuracy", weight: 0.5, min_score: 5 },
      ],
    },
    skill_criteria: {
      "test-skill": {
        profile: "default",
        required_sections: ["Summary"],
        min_word_count: 100,
      },
    },
  },
};

// ── Construction ─────────────────────────────────────────────────────────────

describe("DomainRegistry construction", () => {
  it("creates from valid data", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    expect(registry.domainName).toBe("TestDomain");
    expect(registry.domainDescription).toBe("A test domain");
    expect(registry.queueName).toBe("test-tasks");
    expect(registry.categoryNames).toEqual(["general", "urgent"]);
    expect(registry.defaultCategory).toBe("general");
  });

  it("uses last category as default if none marked", () => {
    const config: DomainConfigData = {
      ...MINIMAL_CONFIG,
      categories: [
        {
          name: "alpha",
          patterns: [],
          template: null,
          phases: [{ name: "DO", description: "do it" }],
        },
        {
          name: "beta",
          patterns: [],
          template: null,
          phases: [{ name: "DO", description: "do it" }],
        },
      ],
    };
    const registry = DomainRegistry.fromData(config);
    expect(registry.defaultCategory).toBe("beta");
  });
});

// ── Category Inference ──────────────────────────────────────────────────────

describe("DomainRegistry inferCategory", () => {
  it("matches patterns case-insensitively", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    expect(registry.inferCategory("This is URGENT!")).toBe("urgent");
    expect(registry.inferCategory("Handle critical issue")).toBe("urgent");
    expect(registry.inferCategory("Do this ASAP")).toBe("urgent");
  });

  it("returns default for no match", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    expect(registry.inferCategory("Just a regular task")).toBe("general");
  });
});

// ── Template Map ────────────────────────────────────────────────────────────

describe("DomainRegistry template map", () => {
  it("returns correct templates per category", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    expect(registry.getCategoryTemplate("general")).toBeNull();
    expect(registry.getCategoryTemplate("urgent")).toBe("Fast Track");
    expect(registry.getCategoryTemplate("nonexistent")).toBeNull();
  });

  it("returns full template map", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    const map = registry.getCategoryTemplateMap();
    expect(map).toEqual({ general: null, urgent: "Fast Track" });
  });
});

// ── Phase Blueprints ────────────────────────────────────────────────────────

describe("DomainRegistry phase blueprints", () => {
  it("returns phases for known categories", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    const phases = registry.getCategoryPhases("urgent");
    expect(phases).toHaveLength(2);
    expect(phases[0]!.name).toBe("TRIAGE");
    expect(phases[1]!.name).toBe("ACT");
  });

  it("returns empty for unknown categories", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    expect(registry.getCategoryPhases("unknown")).toEqual([]);
  });
});

// ── Quality ─────────────────────────────────────────────────────────────────

describe("DomainRegistry quality config", () => {
  it("provides quality profiles", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    const profile = registry.getQualityProfile("default");
    expect(profile).toBeDefined();
    expect(profile!).toHaveLength(2);
    expect(profile![0]!.dimension).toBe("completeness");
  });

  it("provides skill criteria", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    const criteria = registry.getSkillQualityCriteria("test-skill");
    expect(criteria).toBeDefined();
    expect(criteria!.profile).toBe("default");
    expect(criteria!.min_word_count).toBe(100);
  });

  it("returns undefined for unknown skill", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    expect(registry.getSkillQualityCriteria("no-such-skill")).toBeUndefined();
  });
});

// ── Category Validation ─────────────────────────────────────────────────────

describe("DomainRegistry isValidCategory", () => {
  it("returns true for known categories", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    expect(registry.isValidCategory("general")).toBe(true);
    expect(registry.isValidCategory("urgent")).toBe(true);
  });

  it("returns false for unknown categories", () => {
    const registry = DomainRegistry.fromData(MINIMAL_CONFIG);
    expect(registry.isValidCategory("fake")).toBe(false);
  });
});

// ── Validation Errors ───────────────────────────────────────────────────────

describe("DomainRegistry validation", () => {
  it("rejects missing domain section", () => {
    expect(() =>
      DomainRegistry.fromData({} as DomainConfigData),
    ).toThrow(DomainRegistryError);
  });

  it("rejects duplicate category names", () => {
    const config: DomainConfigData = {
      ...MINIMAL_CONFIG,
      categories: [
        { name: "dupe", patterns: [], template: null, phases: [{ name: "X", description: "x" }] },
        { name: "dupe", patterns: [], template: null, phases: [{ name: "Y", description: "y" }] },
      ],
    };
    expect(() => DomainRegistry.fromData(config)).toThrow(/Duplicate category/);
  });

  it("rejects invalid regex patterns", () => {
    const config: DomainConfigData = {
      ...MINIMAL_CONFIG,
      categories: [
        { name: "bad", patterns: ["[invalid"], template: null, phases: [{ name: "X", description: "x" }] },
      ],
    };
    expect(() => DomainRegistry.fromData(config)).toThrow(/invalid regex/);
  });

  it("rejects quality profile referencing unknown dimension", () => {
    const config: DomainConfigData = {
      ...MINIMAL_CONFIG,
      quality: {
        ...MINIMAL_CONFIG.quality,
        profiles: {
          bad_profile: [
            { dimension: "nonexistent", weight: 1.0, min_score: 5 },
          ],
        },
        skill_criteria: {},
      },
    };
    expect(() => DomainRegistry.fromData(config)).toThrow(/unknown dimension/);
  });

  it("rejects skill criteria referencing unknown profile", () => {
    const config: DomainConfigData = {
      ...MINIMAL_CONFIG,
      quality: {
        ...MINIMAL_CONFIG.quality,
        skill_criteria: {
          "bad-skill": {
            profile: "nonexistent",
            required_sections: [],
            min_word_count: 50,
          },
        },
      },
    };
    expect(() => DomainRegistry.fromData(config)).toThrow(/unknown profile/);
  });

  it("rejects multiple defaults", () => {
    const config: DomainConfigData = {
      ...MINIMAL_CONFIG,
      categories: [
        { name: "a", default: true, patterns: [], template: null, phases: [{ name: "X", description: "x" }] },
        { name: "b", default: true, patterns: [], template: null, phases: [{ name: "Y", description: "y" }] },
      ],
    };
    expect(() => DomainRegistry.fromData(config)).toThrow(/Multiple categories marked as default/);
  });
});

// ── YAML Loading ────────────────────────────────────────────────────────────

describe("DomainRegistry fromYaml", () => {
  it("loads the actual .agents/domain.yaml", async () => {
    const yamlPath = resolve(import.meta.dir, "../../../.agents/domain.yaml");
    const registry = await DomainRegistry.fromYaml(yamlPath);

    // Marketing domain
    expect(registry.domainName).toBe("Marketing");
    expect(registry.queueName).toBe("marketing-tasks");
    expect(registry.categoryNames).toContain("strategic");
    expect(registry.categoryNames).toContain("content");
    expect(registry.categoryNames).toContain("competitive");

    // Inference works
    expect(registry.inferCategory("Create a content strategy")).toBe("content");
    expect(registry.inferCategory("Analyze competitor pricing")).toBe("competitive");
    expect(registry.inferCategory("Random business goal")).toBe("strategic");

    // Director prompt sections populated
    expect(registry.director.role.length).toBeGreaterThan(10);
    expect(registry.director.decision_rules.length).toBeGreaterThan(10);

    // Quality config populated
    expect(registry.quality.dimensions.length).toBeGreaterThan(3);
    expect(Object.keys(registry.quality.profiles).length).toBeGreaterThan(0);
    expect(Object.keys(registry.quality.skill_criteria).length).toBeGreaterThan(10);
  });

  it("throws DomainRegistryError for missing file", async () => {
    try {
      await DomainRegistry.fromYaml("/nonexistent/path/domain.yaml");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DomainRegistryError);
      expect((e as DomainRegistryError).errors[0]).toContain("not found");
    }
  });
});
