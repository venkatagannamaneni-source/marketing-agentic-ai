import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

// ── YAML Config Schema ──────────────────────────────────────────────────────

export interface SkillRegistryData {
  readonly squads: Record<string, { readonly description: string }>;
  readonly foundation_skill: string;
  readonly skills: Record<
    string,
    {
      readonly squad: string | null;
      readonly description: string;
      readonly downstream: readonly string[] | "all";
    }
  >;
}

// ── Validation Error ────────────────────────────────────────────────────────

export class SkillRegistryError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

// ── Skill Registry ──────────────────────────────────────────────────────────

/**
 * Configuration-driven skill registry.
 *
 * Loads skill definitions, squad assignments, and dependency graphs
 * from a YAML config file (`.agents/skills.yaml`).
 *
 * This replaces the hardcoded `as const` arrays in `types/agent.ts`
 * and `agents/registry.ts` with a runtime-loaded configuration.
 */
export class SkillRegistry {
  readonly skillNames: readonly string[];
  readonly squadNames: readonly string[];
  readonly foundationSkill: string;
  readonly skillSquadMap: Record<string, string | null>;
  readonly dependencyGraph: Record<string, readonly string[]>;
  readonly squadDescriptions: Record<string, string>;

  private constructor(data: SkillRegistryData) {
    this.squadNames = Object.keys(data.squads);
    this.skillNames = Object.keys(data.skills);
    this.foundationSkill = data.foundation_skill;

    // Build squad descriptions
    this.squadDescriptions = {};
    for (const [name, squad] of Object.entries(data.squads)) {
      this.squadDescriptions[name] = squad.description;
    }

    // Build skill → squad map
    this.skillSquadMap = {};
    for (const [name, skill] of Object.entries(data.skills)) {
      this.skillSquadMap[name] = skill.squad;
    }

    // Build dependency graph (producer → consumers)
    this.dependencyGraph = {};
    for (const [name, skill] of Object.entries(data.skills)) {
      if (skill.downstream === "all") {
        this.dependencyGraph[name] = this.skillNames.filter(
          (s) => s !== name,
        );
      } else {
        this.dependencyGraph[name] = [...skill.downstream];
      }
    }
  }

  /**
   * Load registry from a YAML config file.
   * Parses the file, builds the registry, and validates all constraints.
   */
  static async fromYaml(yamlPath: string): Promise<SkillRegistry> {
    const content = await readFile(yamlPath, "utf-8");
    const data = parseYaml(content) as SkillRegistryData;
    const registry = new SkillRegistry(data);
    registry.validate();
    return registry;
  }

  /**
   * Create registry from in-memory data (useful for tests).
   * Validates all constraints on construction.
   */
  static fromData(data: SkillRegistryData): SkillRegistry {
    const registry = new SkillRegistry(data);
    registry.validate();
    return registry;
  }

  // ── Query Methods ───────────────────────────────────────────────────────

  /**
   * Get all skills belonging to a squad.
   */
  getSquadSkills(squad: string): string[] {
    return this.skillNames.filter((s) => this.skillSquadMap[s] === squad);
  }

  /**
   * Get upstream producers for a skill (skills whose output this skill consumes).
   */
  getUpstreamSkills(skill: string): string[] {
    const upstream: string[] = [];
    for (const [producer, consumers] of Object.entries(this.dependencyGraph)) {
      if ((consumers as readonly string[]).includes(skill)) {
        upstream.push(producer);
      }
    }
    return upstream;
  }

  /**
   * Get downstream consumers for a skill.
   */
  getDownstreamSkills(skill: string): readonly string[] {
    return this.dependencyGraph[skill] ?? [];
  }

  /**
   * Check if a name is a valid registered skill.
   */
  isValidSkill(name: string): boolean {
    return this.skillNames.includes(name);
  }

  /**
   * Check if a name is a valid registered squad.
   */
  isValidSquad(name: string): boolean {
    return this.squadNames.includes(name);
  }

  // ── Validation ──────────────────────────────────────────────────────────

  /**
   * Validate the registry configuration.
   * Throws SkillRegistryError if any constraints are violated.
   */
  validate(): void {
    const errors: string[] = [];

    // 1. Foundation skill must exist
    if (!this.skillNames.includes(this.foundationSkill)) {
      errors.push(
        `Foundation skill "${this.foundationSkill}" not found in skills`,
      );
    }

    // 2. Every skill must reference a valid squad (or null)
    for (const [name, squad] of Object.entries(this.skillSquadMap)) {
      if (squad !== null && !this.squadNames.includes(squad)) {
        errors.push(
          `Skill "${name}" references unknown squad "${squad}"`,
        );
      }
    }

    // 3. Every downstream target must be a valid skill
    for (const [name, consumers] of Object.entries(this.dependencyGraph)) {
      for (const consumer of consumers) {
        if (!this.skillNames.includes(consumer)) {
          errors.push(
            `Skill "${name}" lists unknown downstream skill "${consumer}"`,
          );
        }
      }
    }

    // 4. No orphan squads (every squad should have at least one skill)
    for (const squad of this.squadNames) {
      const skills = this.getSquadSkills(squad);
      if (skills.length === 0) {
        errors.push(`Squad "${squad}" has no skills assigned`);
      }
    }

    if (errors.length > 0) {
      throw new SkillRegistryError(
        `Skill registry validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }
}
