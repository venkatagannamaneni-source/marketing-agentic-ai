import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { Priority } from "../types/task.ts";
import type { PipelineTemplate, PipelineTemplateStep, ReviewStepTemplate } from "./registry.ts";

// ── YAML Config Schema ──────────────────────────────────────────────────────

export interface PipelineStepData {
  readonly skill?: string;
  readonly parallel?: readonly string[];
  readonly review?: string;
}

export interface PipelineTemplateData {
  readonly name: string;
  readonly description: string;
  readonly trigger: string;
  readonly defaultPriority: string;
  readonly steps: readonly PipelineStepData[];
}

export interface PipelineTemplateRegistryData {
  readonly pipelines: readonly PipelineTemplateData[];
}

// ── Validation Error ────────────────────────────────────────────────────────

export class PipelineTemplateRegistryError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = "PipelineTemplateRegistryError";
  }
}

// ── Valid priorities ────────────────────────────────────────────────────────

const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

// ── Pipeline Template Registry ──────────────────────────────────────────────

export class PipelineTemplateRegistry {
  private readonly _templates: readonly PipelineTemplate[];
  private readonly _templatesByName: ReadonlyMap<string, PipelineTemplate>;
  private readonly _templateNames: readonly string[];

  private constructor(data: PipelineTemplateRegistryData, validSkills?: ReadonlySet<string>) {
    PipelineTemplateRegistry.validateData(data, validSkills);

    this._templates = Object.freeze(
      data.pipelines.map((p) => PipelineTemplateRegistry.convertTemplate(p)),
    );

    const byName = new Map<string, PipelineTemplate>();
    for (const t of this._templates) {
      byName.set(t.name, t);
    }
    this._templatesByName = byName;
    this._templateNames = Object.freeze(this._templates.map((t) => t.name));
  }

  static async fromYaml(
    yamlPath: string,
    validSkills?: ReadonlySet<string>,
  ): Promise<PipelineTemplateRegistry> {
    let content: string;
    try {
      content = await readFile(yamlPath, "utf-8");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new PipelineTemplateRegistryError(
          `Pipeline template file not found: ${yamlPath}`,
          [`File not found: ${yamlPath}`],
        );
      }
      throw new PipelineTemplateRegistryError(
        `Failed to read pipeline template file: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch (err: unknown) {
      throw new PipelineTemplateRegistryError(
        `Failed to parse YAML: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    PipelineTemplateRegistry.validateShape(raw);
    return new PipelineTemplateRegistry(raw, validSkills);
  }

  static fromData(
    data: PipelineTemplateRegistryData,
    validSkills?: ReadonlySet<string>,
  ): PipelineTemplateRegistry {
    PipelineTemplateRegistry.validateShape(data);
    return new PipelineTemplateRegistry(data, validSkills);
  }

  // ── Query Methods ───────────────────────────────────────────────────────

  get templates(): readonly PipelineTemplate[] {
    return this._templates;
  }

  get templateNames(): readonly string[] {
    return this._templateNames;
  }

  findTemplate(name: string): PipelineTemplate | undefined {
    return this._templatesByName.get(name);
  }

  // ── Static Helpers ────────────────────────────────────────────────────────

  private static convertTemplate(data: PipelineTemplateData): PipelineTemplate {
    const steps: PipelineTemplateStep[] = data.steps.map((step) => {
      if (step.parallel) {
        return Object.freeze([...step.parallel]);
      }
      if (step.review) {
        return { review: step.review } as ReviewStepTemplate;
      }
      return step.skill!;
    });

    return {
      name: data.name,
      description: data.description,
      trigger: data.trigger,
      defaultPriority: data.defaultPriority as Priority,
      steps: Object.freeze(steps),
    };
  }

  // ── Validation ──────────────────────────────────────────────────────────

  private static validateShape(
    data: unknown,
  ): asserts data is PipelineTemplateRegistryData {
    const errors: string[] = [];
    if (!data || typeof data !== "object") {
      throw new PipelineTemplateRegistryError(
        "Invalid YAML: expected an object at root",
        ["Root must be an object"],
      );
    }
    const d = data as Record<string, unknown>;
    if (!Array.isArray(d.pipelines)) {
      errors.push("Missing or invalid 'pipelines' key (expected an array)");
      throw new PipelineTemplateRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }

    for (let i = 0; i < d.pipelines.length; i++) {
      const entry = d.pipelines[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`pipelines[${i}]: expected an object`);
      }
    }
    if (errors.length > 0) {
      throw new PipelineTemplateRegistryError(
        `Invalid YAML schema: ${errors.length} error(s)`,
        errors,
      );
    }
  }

  private static validateData(
    data: PipelineTemplateRegistryData,
    validSkills?: ReadonlySet<string>,
  ): void {
    const errors: string[] = [];

    if (data.pipelines.length === 0) {
      errors.push("Pipeline templates array is empty");
    }

    const seenNames = new Set<string>();
    for (const pipeline of data.pipelines) {
      if (!pipeline.name || typeof pipeline.name !== "string") {
        errors.push("Pipeline template missing required 'name' field");
        continue;
      }

      if (seenNames.has(pipeline.name)) {
        errors.push(`Duplicate pipeline template name: "${pipeline.name}"`);
      }
      seenNames.add(pipeline.name);

      if (!pipeline.description || typeof pipeline.description !== "string") {
        errors.push(
          `Pipeline "${pipeline.name}" missing required 'description' field`,
        );
      }

      if (!pipeline.trigger || typeof pipeline.trigger !== "string") {
        errors.push(
          `Pipeline "${pipeline.name}" missing required 'trigger' field`,
        );
      }

      if (!VALID_PRIORITIES.has(pipeline.defaultPriority)) {
        errors.push(
          `Pipeline "${pipeline.name}" has invalid priority "${pipeline.defaultPriority}" (expected P0-P3)`,
        );
      }

      if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) {
        errors.push(`Pipeline "${pipeline.name}" must have at least one step`);
        continue;
      }

      for (let i = 0; i < pipeline.steps.length; i++) {
        const step = pipeline.steps[i]!;
        const stepLabel = `Pipeline "${pipeline.name}" step ${i}`;
        const keys = Object.keys(step).filter((k) =>
          ["skill", "parallel", "review"].includes(k),
        );

        if (keys.length === 0) {
          errors.push(
            `${stepLabel}: must have one of 'skill', 'parallel', or 'review'`,
          );
        } else if (keys.length > 1) {
          errors.push(
            `${stepLabel}: must have exactly one of 'skill', 'parallel', or 'review' (found: ${keys.join(", ")})`,
          );
        }

        if (validSkills) {
          if (step.skill && !validSkills.has(step.skill)) {
            errors.push(`${stepLabel}: unknown skill "${step.skill}"`);
          }
          if (step.parallel) {
            for (const s of step.parallel) {
              if (!validSkills.has(s)) {
                errors.push(`${stepLabel}: unknown skill "${s}" in parallel group`);
              }
            }
          }
          if (step.review && step.review !== "director" && !validSkills.has(step.review)) {
            errors.push(`${stepLabel}: unknown reviewer "${step.review}"`);
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new PipelineTemplateRegistryError(
        `Pipeline template validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }
}
