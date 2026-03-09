import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

// ── YAML Config Schema ──────────────────────────────────────────────────────

export interface DomainPhaseBlueprint {
  readonly name: string;
  readonly description: string;
}

export interface DomainCategory {
  readonly name: string;
  readonly default?: boolean;
  readonly patterns: readonly string[];
  readonly template: string | null;
  readonly phases: readonly DomainPhaseBlueprint[];
}

export interface DomainDirectorConfig {
  readonly role: string;
  readonly decision_rules: string;
  readonly review_standards: string;
  readonly escalation_criteria: string;
  readonly output_format: string;
  readonly memory: string;
}

export interface DomainDimensionWeight {
  readonly dimension: string;
  readonly weight: number;
  readonly min_score: number;
}

export interface DomainSkillCriteria {
  readonly profile: string;
  readonly required_sections: readonly string[];
  readonly min_word_count: number;
}

export interface DomainQualityConfig {
  readonly dimensions: readonly string[];
  readonly thresholds: {
    readonly approve_above: number;
    readonly revise_below: number;
    readonly reject_below: number;
  };
  readonly profiles: Record<string, readonly DomainDimensionWeight[]>;
  readonly skill_criteria: Record<string, DomainSkillCriteria>;
}

export interface DomainConfigData {
  readonly domain: {
    readonly name: string;
    readonly description: string;
    readonly queue_name: string;
  };
  readonly categories: readonly DomainCategory[];
  readonly director: DomainDirectorConfig;
  readonly quality: DomainQualityConfig;
}

// ── Validation Error ────────────────────────────────────────────────────────

export class DomainRegistryError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = "DomainRegistryError";
  }
}

// ── Domain Registry ─────────────────────────────────────────────────────────

/**
 * Configuration-driven domain registry.
 *
 * Loads the domain "personality" from `.agents/domain.yaml`:
 * - Domain identity (name, description, queue name)
 * - Goal categories with inference patterns and phase blueprints
 * - Director prompt template sections
 * - Quality dimensions, profiles, and per-skill criteria
 *
 * This is the key to making the system domain-agnostic.
 * Swap the YAML file to change from Marketing → DevOps → anything.
 */
export class DomainRegistry {
  readonly domainName: string;
  readonly domainDescription: string;
  readonly queueName: string;
  readonly categories: readonly DomainCategory[];
  readonly categoryNames: readonly string[];
  readonly defaultCategory: string;
  readonly director: DomainDirectorConfig;
  readonly quality: DomainQualityConfig;

  // Pre-compiled regex patterns for category inference
  private readonly _categoryPatterns: ReadonlyMap<string, readonly RegExp[]>;
  // Category → template mapping
  private readonly _categoryTemplateMap: ReadonlyMap<string, string | null>;
  // Category → phase blueprints
  private readonly _categoryPhases: ReadonlyMap<string, readonly DomainPhaseBlueprint[]>;

  private constructor(data: DomainConfigData) {
    this.domainName = data.domain.name;
    this.domainDescription = data.domain.description;
    this.queueName = data.domain.queue_name;
    this.categories = Object.freeze([...data.categories]);
    this.categoryNames = Object.freeze(data.categories.map((c) => c.name));
    this.director = data.director;
    this.quality = data.quality;

    // Find default category
    const defaultCat = data.categories.find((c) => c.default === true);
    this.defaultCategory = defaultCat?.name ?? data.categories[data.categories.length - 1]!.name;

    // Build compiled patterns (invalid patterns silently become empty — validate() catches them)
    const patterns = new Map<string, readonly RegExp[]>();
    for (const cat of data.categories) {
      const compiled: RegExp[] = [];
      for (const p of cat.patterns) {
        try {
          compiled.push(new RegExp(p, "i"));
        } catch {
          // Invalid regex — will be caught by validate()
        }
      }
      patterns.set(cat.name, Object.freeze(compiled));
    }
    this._categoryPatterns = patterns;

    // Build template map
    const templateMap = new Map<string, string | null>();
    for (const cat of data.categories) {
      templateMap.set(cat.name, cat.template);
    }
    this._categoryTemplateMap = templateMap;

    // Build phase blueprints map
    const phasesMap = new Map<string, readonly DomainPhaseBlueprint[]>();
    for (const cat of data.categories) {
      phasesMap.set(cat.name, Object.freeze([...cat.phases]));
    }
    this._categoryPhases = phasesMap;
  }

  // ── Factory Methods ──────────────────────────────────────────────────────

  static async fromYaml(yamlPath: string): Promise<DomainRegistry> {
    let content: string;
    try {
      content = await readFile(yamlPath, "utf-8");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new DomainRegistryError(
          `Domain config file not found: ${yamlPath}`,
          [`File not found: ${yamlPath}`],
        );
      }
      throw new DomainRegistryError(
        `Failed to read domain config: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch (err: unknown) {
      throw new DomainRegistryError(
        `Failed to parse YAML: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    DomainRegistry.validateShape(raw);
    const registry = new DomainRegistry(raw);
    registry.validate();
    return registry;
  }

  static fromData(data: DomainConfigData): DomainRegistry {
    DomainRegistry.validateShape(data);
    const registry = new DomainRegistry(data);
    registry.validate();
    return registry;
  }

  // ── Query Methods ────────────────────────────────────────────────────────

  /**
   * Infer goal category from a natural language description.
   * Tests patterns top-to-bottom; returns default category if none match.
   */
  inferCategory(description: string): string {
    const lower = description.toLowerCase();
    for (const cat of this.categories) {
      const patterns = this._categoryPatterns.get(cat.name) ?? [];
      for (const pattern of patterns) {
        if (pattern.test(lower)) {
          return cat.name;
        }
      }
    }
    return this.defaultCategory;
  }

  /**
   * Get the pipeline template name for a category (null = no template).
   */
  getCategoryTemplate(category: string): string | null {
    return this._categoryTemplateMap.get(category) ?? null;
  }

  /**
   * Get phase blueprints for a category.
   */
  getCategoryPhases(category: string): readonly DomainPhaseBlueprint[] {
    return this._categoryPhases.get(category) ?? [];
  }

  /**
   * Get the category → template map as a plain object.
   */
  getCategoryTemplateMap(): Record<string, string | null> {
    const map: Record<string, string | null> = {};
    for (const [k, v] of this._categoryTemplateMap) {
      map[k] = v;
    }
    return map;
  }

  /**
   * Check if a category name is valid.
   */
  isValidCategory(name: string): boolean {
    return this.categoryNames.includes(name);
  }

  /**
   * Get quality dimension profile by name.
   */
  getQualityProfile(profileName: string): readonly DomainDimensionWeight[] | undefined {
    return this.quality.profiles[profileName];
  }

  /**
   * Get skill-specific quality criteria.
   */
  getSkillQualityCriteria(skillName: string): DomainSkillCriteria | undefined {
    return this.quality.skill_criteria[skillName];
  }

  // ── Validation ───────────────────────────────────────────────────────────

  private static validateShape(data: unknown): asserts data is DomainConfigData {
    const errors: string[] = [];
    if (!data || typeof data !== "object") {
      throw new DomainRegistryError("Invalid YAML: expected an object at root", [
        "Root must be an object",
      ]);
    }
    const d = data as Record<string, unknown>;

    // domain section
    if (!d.domain || typeof d.domain !== "object") {
      errors.push("Missing or invalid 'domain' key (expected an object)");
    } else {
      const dom = d.domain as Record<string, unknown>;
      if (typeof dom.name !== "string" || dom.name.trim().length === 0) {
        errors.push("domain.name is required (non-empty string)");
      }
      if (typeof dom.description !== "string") {
        errors.push("domain.description is required (string)");
      }
      if (typeof dom.queue_name !== "string" || dom.queue_name.trim().length === 0) {
        errors.push("domain.queue_name is required (non-empty string)");
      }
    }

    // categories
    if (!Array.isArray(d.categories)) {
      errors.push("Missing or invalid 'categories' key (expected an array)");
    } else if (d.categories.length === 0) {
      errors.push("'categories' must have at least one entry");
    } else {
      for (let i = 0; i < d.categories.length; i++) {
        const cat = d.categories[i] as Record<string, unknown> | null;
        if (!cat || typeof cat !== "object") {
          errors.push(`categories[${i}]: expected an object`);
          continue;
        }
        if (typeof cat.name !== "string" || cat.name.trim().length === 0) {
          errors.push(`categories[${i}]: missing or invalid 'name'`);
        }
        if (!Array.isArray(cat.patterns)) {
          errors.push(`categories[${i}]: missing or invalid 'patterns' (expected array)`);
        }
        if (!Array.isArray(cat.phases)) {
          errors.push(`categories[${i}]: missing or invalid 'phases' (expected array)`);
        }
      }
    }

    // director
    if (!d.director || typeof d.director !== "object") {
      errors.push("Missing or invalid 'director' key (expected an object)");
    } else {
      const dir = d.director as Record<string, unknown>;
      for (const key of ["role", "decision_rules", "review_standards", "escalation_criteria", "output_format", "memory"]) {
        if (typeof dir[key] !== "string") {
          errors.push(`director.${key} is required (string)`);
        }
      }
    }

    // quality
    if (!d.quality || typeof d.quality !== "object") {
      errors.push("Missing or invalid 'quality' key (expected an object)");
    } else {
      const q = d.quality as Record<string, unknown>;
      if (!Array.isArray(q.dimensions) || q.dimensions.length === 0) {
        errors.push("quality.dimensions is required (non-empty array)");
      }
      if (!q.thresholds || typeof q.thresholds !== "object") {
        errors.push("quality.thresholds is required (object)");
      }
      if (!q.profiles || typeof q.profiles !== "object") {
        errors.push("quality.profiles is required (object)");
      }
      if (!q.skill_criteria || typeof q.skill_criteria !== "object") {
        errors.push("quality.skill_criteria is required (object)");
      }
    }

    if (errors.length > 0) {
      throw new DomainRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }
  }

  validate(): void {
    const errors: string[] = [];

    // Exactly one default category (or last one is implicit default)
    const defaults = this.categories.filter((c) => c.default === true);
    if (defaults.length > 1) {
      errors.push("Multiple categories marked as default (only one allowed)");
    }

    // No duplicate category names
    const catNames = new Set<string>();
    for (const cat of this.categories) {
      if (catNames.has(cat.name)) {
        errors.push(`Duplicate category name: "${cat.name}"`);
      }
      catNames.add(cat.name);
    }

    // Validate regex patterns compile
    for (const cat of this.categories) {
      for (const pattern of cat.patterns) {
        try {
          new RegExp(pattern, "i");
        } catch {
          errors.push(`Category "${cat.name}": invalid regex pattern "${pattern}"`);
        }
      }
    }

    // Validate quality profiles reference valid dimensions
    const validDimensions = new Set(this.quality.dimensions);
    for (const [profileName, weights] of Object.entries(this.quality.profiles)) {
      for (const w of weights) {
        if (!validDimensions.has(w.dimension)) {
          errors.push(
            `Quality profile "${profileName}": unknown dimension "${w.dimension}"`,
          );
        }
      }
    }

    // Validate skill criteria reference valid profiles
    const validProfiles = new Set(Object.keys(this.quality.profiles));
    for (const [skillName, criteria] of Object.entries(this.quality.skill_criteria)) {
      if (!validProfiles.has(criteria.profile)) {
        errors.push(
          `Skill criteria "${skillName}": unknown profile "${criteria.profile}"`,
        );
      }
    }

    if (errors.length > 0) {
      throw new DomainRegistryError(
        `Domain config validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }
}
