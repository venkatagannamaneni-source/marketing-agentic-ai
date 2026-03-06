import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { GoalCategory } from "../types/goal.ts";
import type { SquadRoute } from "./types.ts";
import { GOAL_CATEGORIES } from "../types/goal.ts";

// ── YAML Config Schema ──────────────────────────────────────────────────────

export interface RoutingRuleData {
  readonly squad: string;
  readonly skills: readonly string[];
  readonly reason: string;
}

export interface RoutingRegistryData {
  readonly rules: Record<string, readonly RoutingRuleData[]>;
}

// ── Validation Error ────────────────────────────────────────────────────────

export class RoutingRegistryError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = "RoutingRegistryError";
  }
}

// ── Routing Registry ────────────────────────────────────────────────────────

export class RoutingRegistry {
  private readonly _rules: ReadonlyMap<GoalCategory, readonly SquadRoute[]>;
  private readonly _categories: readonly GoalCategory[];

  private constructor(data: RoutingRegistryData) {
    const rulesMap = new Map<GoalCategory, readonly SquadRoute[]>();

    for (const [category, routes] of Object.entries(data.rules)) {
      const squadRoutes: SquadRoute[] = routes.map((r) => ({
        squad: r.squad,
        skills: Object.freeze([...r.skills]),
        reason: r.reason,
      }));
      rulesMap.set(category as GoalCategory, Object.freeze(squadRoutes));
    }

    this._rules = rulesMap;
    this._categories = Object.freeze(
      [...rulesMap.keys()].sort(),
    );
  }

  static async fromYaml(yamlPath: string): Promise<RoutingRegistry> {
    let content: string;
    try {
      content = await readFile(yamlPath, "utf-8");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new RoutingRegistryError(
          `Routing registry file not found: ${yamlPath}`,
          [`File not found: ${yamlPath}`],
        );
      }
      throw new RoutingRegistryError(
        `Failed to read routing registry: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch (err: unknown) {
      throw new RoutingRegistryError(
        `Failed to parse YAML: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    RoutingRegistry.validateShape(raw);
    const registry = new RoutingRegistry(raw);
    registry.validate();
    return registry;
  }

  static fromData(data: RoutingRegistryData): RoutingRegistry {
    RoutingRegistry.validateShape(data);
    const registry = new RoutingRegistry(data);
    registry.validate();
    return registry;
  }

  // ── Query Methods ───────────────────────────────────────────────────────

  routeGoal(category: GoalCategory): readonly SquadRoute[] {
    return this._rules.get(category) ?? [];
  }

  get categories(): readonly GoalCategory[] {
    return this._categories;
  }

  get rules(): ReadonlyMap<GoalCategory, readonly SquadRoute[]> {
    return this._rules;
  }

  // ── Validation ──────────────────────────────────────────────────────────

  private static validateShape(
    data: unknown,
  ): asserts data is RoutingRegistryData {
    const errors: string[] = [];
    if (!data || typeof data !== "object") {
      throw new RoutingRegistryError(
        "Invalid YAML: expected an object at root",
        ["Root must be an object"],
      );
    }
    const d = data as Record<string, unknown>;
    if (!d.rules || typeof d.rules !== "object") {
      errors.push("Missing or invalid 'rules' key (expected an object)");
    }
    if (errors.length > 0) {
      throw new RoutingRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }

    const rules = d.rules as Record<string, unknown>;
    for (const [category, routes] of Object.entries(rules)) {
      if (!Array.isArray(routes)) {
        errors.push(
          `Category "${category}": expected an array of routes, got ${typeof routes}`,
        );
        continue;
      }
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        if (!route || typeof route !== "object") {
          errors.push(`Category "${category}" route ${i}: expected an object`);
          continue;
        }
        const r = route as Record<string, unknown>;
        if (typeof r.squad !== "string") {
          errors.push(
            `Category "${category}" route ${i}: missing or invalid 'squad' (expected string)`,
          );
        }
        if (!Array.isArray(r.skills)) {
          errors.push(
            `Category "${category}" route ${i}: missing or invalid 'skills' (expected array)`,
          );
        } else {
          for (let j = 0; j < r.skills.length; j++) {
            if (typeof r.skills[j] !== "string") {
              errors.push(
                `Category "${category}" route ${i}: skills[${j}] must be a string, got ${typeof r.skills[j]}`,
              );
            }
          }
        }
        if (typeof r.reason !== "string") {
          errors.push(
            `Category "${category}" route ${i}: missing or invalid 'reason' (expected string)`,
          );
        }
      }
    }
    if (errors.length > 0) {
      throw new RoutingRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }
  }

  validate(): void {
    const errors: string[] = [];

    for (const category of this._rules.keys()) {
      if (!(GOAL_CATEGORIES as readonly string[]).includes(category)) {
        errors.push(`Unknown goal category: "${category}"`);
      }
    }

    for (const [category, routes] of this._rules.entries()) {
      if (routes.length === 0) {
        errors.push(`Category "${category}" has no routes`);
      }
    }

    for (const [category, routes] of this._rules.entries()) {
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i]!;
        if (!route.squad || route.squad.trim().length === 0) {
          errors.push(
            `Category "${category}" route ${i}: squad name is empty`,
          );
        }
        if (route.skills.length === 0) {
          errors.push(
            `Category "${category}" route ${i}: skills list is empty`,
          );
        }
        for (const skill of route.skills) {
          if (!skill || (typeof skill === "string" && skill.trim().length === 0)) {
            errors.push(
              `Category "${category}" route ${i}: contains empty skill name`,
            );
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new RoutingRegistryError(
        `Routing registry validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }

  validateAgainst(validSkills: readonly string[], validSquads: readonly string[]): void {
    const errors: string[] = [];

    for (const [category, routes] of this._rules.entries()) {
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i]!;
        if (!validSquads.includes(route.squad)) {
          errors.push(
            `Category "${category}" route ${i}: unknown squad "${route.squad}"`,
          );
        }
        for (const skill of route.skills) {
          if (!validSkills.includes(skill)) {
            errors.push(
              `Category "${category}" route ${i}: unknown skill "${skill}"`,
            );
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new RoutingRegistryError(
        `Routing registry cross-validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }
}
