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
    this.squadNames = Object.freeze(Object.keys(data.squads));
    this.skillNames = Object.freeze(Object.keys(data.skills));
    this.foundationSkill = data.foundation_skill;

    // Build squad descriptions
    const descs: Record<string, string> = {};
    for (const [name, squad] of Object.entries(data.squads)) {
      descs[name] = squad.description;
    }
    this.squadDescriptions = Object.freeze(descs);

    // Build skill → squad map
    const sqMap: Record<string, string | null> = {};
    for (const [name, skill] of Object.entries(data.skills)) {
      sqMap[name] = skill.squad;
    }
    this.skillSquadMap = Object.freeze(sqMap);

    // Build dependency graph (producer → consumers)
    const graph: Record<string, readonly string[]> = {};
    for (const [name, skill] of Object.entries(data.skills)) {
      if (skill.downstream === "all") {
        graph[name] = Object.freeze(
          this.skillNames.filter((s) => s !== name),
        );
      } else {
        graph[name] = Object.freeze([...skill.downstream]);
      }
    }
    this.dependencyGraph = Object.freeze(graph);
  }

  /**
   * Load registry from a YAML config file.
   * Parses the file, builds the registry, and validates all constraints.
   */
  static async fromYaml(yamlPath: string): Promise<SkillRegistry> {
    let content: string;
    try {
      content = await readFile(yamlPath, "utf-8");
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillRegistryError(
          `Skill registry file not found: ${yamlPath}`,
          [`File not found: ${yamlPath}`],
        );
      }
      throw new SkillRegistryError(
        `Failed to read skill registry: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    const raw = parseYaml(content);
    SkillRegistry.validateShape(raw);
    const registry = new SkillRegistry(raw);
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
   * Validate the raw YAML shape before constructing a registry.
   * Catches missing/wrong-type top-level keys early with clear errors.
   */
  private static validateShape(data: unknown): asserts data is SkillRegistryData {
    const errors: string[] = [];
    if (!data || typeof data !== "object") {
      throw new SkillRegistryError("Invalid YAML: expected an object at root", [
        "Root must be an object",
      ]);
    }
    const d = data as Record<string, unknown>;
    if (!d.squads || typeof d.squads !== "object") {
      errors.push("Missing or invalid 'squads' key (expected an object)");
    }
    if (!d.skills || typeof d.skills !== "object") {
      errors.push("Missing or invalid 'skills' key (expected an object)");
    }
    if (typeof d.foundation_skill !== "string") {
      errors.push("Missing or invalid 'foundation_skill' (expected a string)");
    }
    if (errors.length > 0) {
      throw new SkillRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }
  }

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

    // 4. No self-referencing downstream
    for (const [name, consumers] of Object.entries(this.dependencyGraph)) {
      if ((consumers as readonly string[]).includes(name)) {
        errors.push(`Skill "${name}" lists itself as a downstream consumer`);
      }
    }

    // 5. No orphan squads (every squad should have at least one skill)
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
