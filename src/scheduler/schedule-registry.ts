import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { parseCron } from "./cron.ts";
import type { ScheduleEntry } from "../types/events.ts";
import { GOAL_CATEGORIES } from "../types/goal.ts";
import { PRIORITIES } from "../types/task.ts";

// ── YAML Config Schema ──────────────────────────────────────────────────────

export interface ScheduleRegistryData {
  readonly schedules: readonly ScheduleEntryData[];
}

export interface ScheduleEntryData {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly pipelineId: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly priority?: string;
  readonly goalCategory?: string;
}

// ── Validation Error ────────────────────────────────────────────────────────

export class ScheduleRegistryError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = "ScheduleRegistryError";
  }
}

// ── Schedule Registry ──────────────────────────────────────────────────────

export class ScheduleRegistry {
  private readonly _schedules: readonly ScheduleEntry[];
  private readonly _scheduleMap: Map<string, ScheduleEntry>;

  private constructor(entries: readonly ScheduleEntry[]) {
    this._schedules = Object.freeze([...entries]);
    this._scheduleMap = new Map(entries.map((e) => [e.id, e]));
  }

  static async fromYaml(yamlPath: string): Promise<ScheduleRegistry> {
    let content: string;
    try {
      content = await readFile(yamlPath, "utf-8");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new ScheduleRegistryError(
          `Schedule registry file not found: ${yamlPath}`,
          [`File not found: ${yamlPath}`],
        );
      }
      throw new ScheduleRegistryError(
        `Failed to read schedule registry: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch (err: unknown) {
      throw new ScheduleRegistryError(
        `Failed to parse YAML: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    ScheduleRegistry.validateShape(raw);
    const entries = ScheduleRegistry.toScheduleEntries(raw);
    const registry = new ScheduleRegistry(entries);
    registry.validate();
    return registry;
  }

  static fromData(data: ScheduleRegistryData): ScheduleRegistry {
    ScheduleRegistry.validateShape(data);
    const entries = ScheduleRegistry.toScheduleEntries(data);
    const registry = new ScheduleRegistry(entries);
    registry.validate();
    return registry;
  }

  // ── Query Methods ───────────────────────────────────────────────────────

  get schedules(): readonly ScheduleEntry[] {
    return this._schedules;
  }

  getSchedule(id: string): ScheduleEntry | undefined {
    return this._scheduleMap.get(id);
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  private static toScheduleEntries(
    data: ScheduleRegistryData,
  ): ScheduleEntry[] {
    return data.schedules.map((s) => ({
      id: s.id,
      name: s.name,
      cron: s.cron,
      pipelineId: s.pipelineId,
      enabled: s.enabled,
      description: s.description,
      priority: s.priority as ScheduleEntry["priority"],
      goalCategory: s.goalCategory as ScheduleEntry["goalCategory"],
    }));
  }

  // ── Validation ──────────────────────────────────────────────────────────

  private static validateShape(
    data: unknown,
  ): asserts data is ScheduleRegistryData {
    const errors: string[] = [];
    if (!data || typeof data !== "object") {
      throw new ScheduleRegistryError(
        "Invalid YAML: expected an object at root",
        ["Root must be an object"],
      );
    }
    const d = data as Record<string, unknown>;
    if (!Array.isArray(d.schedules)) {
      errors.push("Missing or invalid 'schedules' key (expected an array)");
      throw new ScheduleRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }

    for (let i = 0; i < d.schedules.length; i++) {
      const entry = d.schedules[i];
      if (!entry || typeof entry !== "object") {
        errors.push(`schedules[${i}]: expected an object`);
        continue;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || e.id.trim().length === 0) {
        errors.push(`schedules[${i}]: missing or invalid 'id' (expected non-empty string)`);
      }
      if (typeof e.name !== "string" || e.name.trim().length === 0) {
        errors.push(`schedules[${i}]: missing or invalid 'name' (expected non-empty string)`);
      }
      if (typeof e.cron !== "string" || e.cron.trim().length === 0) {
        errors.push(`schedules[${i}]: missing or invalid 'cron' (expected non-empty string)`);
      }
      if (typeof e.pipelineId !== "string" || e.pipelineId.trim().length === 0) {
        errors.push(`schedules[${i}]: missing or invalid 'pipelineId' (expected non-empty string)`);
      }
      if (typeof e.enabled !== "boolean") {
        errors.push(`schedules[${i}]: missing or invalid 'enabled' (expected boolean)`);
      }
    }
    if (errors.length > 0) {
      throw new ScheduleRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }
  }

  validate(): void {
    const errors: string[] = [];

    if (this._schedules.length === 0) {
      errors.push("No schedules defined");
    }

    const ids = new Set<string>();
    for (const s of this._schedules) {
      if (ids.has(s.id)) {
        errors.push(`Duplicate schedule ID: "${s.id}"`);
      }
      ids.add(s.id);
    }

    for (const s of this._schedules) {
      try {
        parseCron(s.cron);
      } catch {
        errors.push(
          `Schedule "${s.id}" has invalid cron expression: "${s.cron}"`,
        );
      }
    }

    const validPriorities = PRIORITIES as readonly string[];
    for (const s of this._schedules) {
      if (s.priority && !validPriorities.includes(s.priority)) {
        errors.push(
          `Schedule "${s.id}" has invalid priority: "${s.priority}"`,
        );
      }
    }

    const validCategories = GOAL_CATEGORIES as readonly string[];
    for (const s of this._schedules) {
      if (s.goalCategory && !validCategories.includes(s.goalCategory)) {
        errors.push(
          `Schedule "${s.id}" has invalid goalCategory: "${s.goalCategory}"`,
        );
      }
    }

    if (errors.length > 0) {
      throw new ScheduleRegistryError(
        `Schedule registry validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }
}
