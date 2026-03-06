import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { EVENT_TYPES, type SystemEvent } from "../types/events.ts";
import { PRIORITIES, type Priority } from "../types/task.ts";
import type { EventMapping } from "./event-bus.ts";

// ── Condition Types ──────────────────────────────────────────────────────────

export type ConditionOperator =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "eq"
  | "neq"
  | "exists"
  | "contains";

const VALID_OPERATORS: readonly ConditionOperator[] = [
  "gt", "gte", "lt", "lte", "eq", "neq", "exists", "contains",
];

export interface EventCondition {
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value?: unknown;
}

// ── YAML Config Schema ──────────────────────────────────────────────────────

export interface EventMappingConfig {
  readonly eventType: string;
  readonly pipelineTemplate: string;
  readonly priority: string;
  readonly cooldownMs?: number;
  readonly condition?: EventCondition;
  readonly description?: string;
}

export interface EventRegistryData {
  readonly mappings: readonly EventMappingConfig[];
}

// ── Validation Error ────────────────────────────────────────────────────────

export class EventRegistryError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = "EventRegistryError";
  }
}

// ── Event Registry ──────────────────────────────────────────────────────────

export class EventRegistry {
  private readonly _mappings: readonly EventMappingConfig[];

  private constructor(data: EventRegistryData) {
    this._mappings = Object.freeze([...data.mappings]);
  }

  static async fromYaml(yamlPath: string): Promise<EventRegistry> {
    let content: string;
    try {
      content = await readFile(yamlPath, "utf-8");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new EventRegistryError(
          `Event registry file not found: ${yamlPath}`,
          [`File not found: ${yamlPath}`],
        );
      }
      throw new EventRegistryError(
        `Failed to read event registry: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch (err: unknown) {
      throw new EventRegistryError(
        `Failed to parse YAML: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    EventRegistry.validateShape(raw);
    const registry = new EventRegistry(raw);
    registry.validate();
    return registry;
  }

  static fromData(data: EventRegistryData): EventRegistry {
    EventRegistry.validateShape(data);
    const registry = new EventRegistry(data);
    registry.validate();
    return registry;
  }

  // ── Query Methods ───────────────────────────────────────────────────────

  get mappings(): readonly EventMappingConfig[] {
    return this._mappings;
  }

  getMappingsForEvent(eventType: string): readonly EventMappingConfig[] {
    return this._mappings.filter((m) => m.eventType === eventType);
  }

  evaluateCondition(
    condition: EventCondition,
    eventData: Record<string, unknown>,
  ): boolean {
    const fieldValue = eventData[condition.field];

    switch (condition.operator) {
      case "exists":
        return fieldValue !== undefined && fieldValue !== null;
      case "eq":
        return fieldValue === condition.value;
      case "neq":
        return fieldValue !== condition.value;
      case "gt":
        return (
          typeof fieldValue === "number" &&
          typeof condition.value === "number" &&
          fieldValue > condition.value
        );
      case "gte":
        return (
          typeof fieldValue === "number" &&
          typeof condition.value === "number" &&
          fieldValue >= condition.value
        );
      case "lt":
        return (
          typeof fieldValue === "number" &&
          typeof condition.value === "number" &&
          fieldValue < condition.value
        );
      case "lte":
        return (
          typeof fieldValue === "number" &&
          typeof condition.value === "number" &&
          fieldValue <= condition.value
        );
      case "contains":
        if (typeof fieldValue === "string" && typeof condition.value === "string") {
          return fieldValue.includes(condition.value);
        }
        if (Array.isArray(fieldValue)) {
          return fieldValue.includes(condition.value);
        }
        return false;
      default:
        return false;
    }
  }

  toEventMappings(): EventMapping[] {
    return this._mappings.map((config) => {
      const mapping: EventMapping = {
        eventType: config.eventType as SystemEvent["type"],
        pipelineTemplate: config.pipelineTemplate,
        priority: config.priority as Priority,
        cooldownMs: config.cooldownMs,
      };

      if (config.condition) {
        const condition = config.condition;
        return {
          ...mapping,
          condition: (event: SystemEvent): boolean =>
            this.evaluateCondition(condition, (event.data ?? {}) as Record<string, unknown>),
        };
      }

      return mapping;
    });
  }

  // ── Validation ──────────────────────────────────────────────────────────

  private static validateShape(
    data: unknown,
  ): asserts data is EventRegistryData {
    const errors: string[] = [];
    if (!data || typeof data !== "object") {
      throw new EventRegistryError(
        "Invalid YAML: expected an object at root",
        ["Root must be an object"],
      );
    }
    const d = data as Record<string, unknown>;
    if (!Array.isArray(d.mappings)) {
      errors.push("Missing or invalid 'mappings' key (expected an array)");
    }
    if (errors.length > 0) {
      throw new EventRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }
  }

  private validate(): void {
    const errors: string[] = [];
    const validEventTypes = EVENT_TYPES as readonly string[];
    const validPriorities = PRIORITIES as readonly string[];

    for (let i = 0; i < this._mappings.length; i++) {
      const m = this._mappings[i]!;
      const prefix = `mappings[${i}]`;

      if (!m.eventType || typeof m.eventType !== "string") {
        errors.push(`${prefix}: missing or invalid 'eventType'`);
      } else if (!validEventTypes.includes(m.eventType)) {
        errors.push(
          `${prefix}: unknown eventType "${m.eventType}" (valid: ${validEventTypes.join(", ")})`,
        );
      }

      if (!m.pipelineTemplate || typeof m.pipelineTemplate !== "string") {
        errors.push(`${prefix}: missing or invalid 'pipelineTemplate'`);
      }

      if (!m.priority || typeof m.priority !== "string") {
        errors.push(`${prefix}: missing or invalid 'priority'`);
      } else if (!validPriorities.includes(m.priority)) {
        errors.push(
          `${prefix}: invalid priority "${m.priority}" (valid: ${validPriorities.join(", ")})`,
        );
      }

      if (
        m.cooldownMs !== undefined &&
        (typeof m.cooldownMs !== "number" || m.cooldownMs < 0)
      ) {
        errors.push(`${prefix}: 'cooldownMs' must be a non-negative number`);
      }

      if (m.condition) {
        if (!m.condition.field || typeof m.condition.field !== "string") {
          errors.push(`${prefix}.condition: missing or invalid 'field'`);
        }
        if (!m.condition.operator || typeof m.condition.operator !== "string") {
          errors.push(`${prefix}.condition: missing or invalid 'operator'`);
        } else if (
          !VALID_OPERATORS.includes(m.condition.operator as ConditionOperator)
        ) {
          errors.push(
            `${prefix}.condition: invalid operator "${m.condition.operator}" (valid: ${VALID_OPERATORS.join(", ")})`,
          );
        }
        if (
          m.condition.operator !== "exists" &&
          m.condition.value === undefined
        ) {
          errors.push(
            `${prefix}.condition: 'value' is required for operator "${m.condition.operator}"`,
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new EventRegistryError(
        `Event registry validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }
}
