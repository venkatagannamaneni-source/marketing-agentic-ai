import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import {
  PipelineTemplateRegistry,
  PipelineTemplateRegistryError,
  type PipelineTemplateRegistryData,
} from "../pipeline-template-registry.ts";
import { PIPELINE_TEMPLATES } from "../registry.ts";

// ── Test Data ────────────────────────────────────────────────────────────────

const MINIMAL_DATA: PipelineTemplateRegistryData = {
  pipelines: [
    {
      name: "Test Pipeline",
      description: "A test pipeline",
      trigger: "manual",
      defaultPriority: "P1",
      steps: [{ skill: "copywriting" }],
    },
  ],
};

const MULTI_DATA: PipelineTemplateRegistryData = {
  pipelines: [
    {
      name: "Pipeline A",
      description: "First pipeline",
      trigger: "weekly",
      defaultPriority: "P2",
      steps: [{ skill: "content-strategy" }, { skill: "copywriting" }],
    },
    {
      name: "Pipeline B",
      description: "Second pipeline",
      trigger: "monthly",
      defaultPriority: "P1",
      steps: [
        { skill: "page-cro" },
        { parallel: ["copywriting", "social-content"] },
      ],
    },
  ],
};

const REVIEW_DATA: PipelineTemplateRegistryData = {
  pipelines: [
    {
      name: "Review Pipeline",
      description: "Pipeline with review steps",
      trigger: "manual",
      defaultPriority: "P1",
      steps: [
        { skill: "copywriting" },
        { review: "copy-editing" },
        { review: "director" },
      ],
    },
  ],
};

const YAML_PATH = resolve(import.meta.dir, "../../../.agents/pipelines.yaml");

// ── fromData ────────────────────────────────────────────────────────────────

describe("PipelineTemplateRegistry.fromData", () => {
  it("creates registry from minimal data", () => {
    const registry = PipelineTemplateRegistry.fromData(MINIMAL_DATA);
    expect(registry.templates).toHaveLength(1);
  });

  it("creates registry with multiple pipelines", () => {
    const registry = PipelineTemplateRegistry.fromData(MULTI_DATA);
    expect(registry.templates).toHaveLength(2);
  });

  it("preserves template properties", () => {
    const registry = PipelineTemplateRegistry.fromData(MINIMAL_DATA);
    const t = registry.templates[0]!;
    expect(t.name).toBe("Test Pipeline");
    expect(t.description).toBe("A test pipeline");
    expect(t.trigger).toBe("manual");
    expect(t.defaultPriority).toBe("P1");
  });

  it("converts skill steps to strings", () => {
    const registry = PipelineTemplateRegistry.fromData(MINIMAL_DATA);
    expect(registry.templates[0]!.steps[0]).toBe("copywriting");
  });

  it("converts parallel steps to arrays", () => {
    const registry = PipelineTemplateRegistry.fromData(MULTI_DATA);
    const step = registry.templates[1]!.steps[1];
    expect(Array.isArray(step)).toBe(true);
    expect(step).toEqual(["copywriting", "social-content"]);
  });

  it("converts review steps to ReviewStepTemplate objects", () => {
    const registry = PipelineTemplateRegistry.fromData(REVIEW_DATA);
    const steps = registry.templates[0]!.steps;
    expect(steps[1]).toEqual({ review: "copy-editing" });
    expect(steps[2]).toEqual({ review: "director" });
  });
});

// ── Query Methods ────────────────────────────────────────────────────────────

describe("PipelineTemplateRegistry query methods", () => {
  it("templateNames returns all names", () => {
    const registry = PipelineTemplateRegistry.fromData(MULTI_DATA);
    expect(registry.templateNames).toEqual(["Pipeline A", "Pipeline B"]);
  });

  it("findTemplate returns template by name", () => {
    const registry = PipelineTemplateRegistry.fromData(MULTI_DATA);
    const t = registry.findTemplate("Pipeline A");
    expect(t).toBeDefined();
    expect(t!.name).toBe("Pipeline A");
  });

  it("findTemplate returns undefined for unknown name", () => {
    const registry = PipelineTemplateRegistry.fromData(MINIMAL_DATA);
    expect(registry.findTemplate("Nonexistent")).toBeUndefined();
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("PipelineTemplateRegistry validation", () => {
  it("rejects empty pipelines array", () => {
    expect(() =>
      PipelineTemplateRegistry.fromData({ pipelines: [] }),
    ).toThrow(PipelineTemplateRegistryError);
    expect(() =>
      PipelineTemplateRegistry.fromData({ pipelines: [] }),
    ).toThrow(/empty/);
  });

  it("rejects duplicate names", () => {
    const bad: PipelineTemplateRegistryData = {
      pipelines: [
        {
          name: "Same Name",
          description: "First",
          trigger: "manual",
          defaultPriority: "P1",
          steps: [{ skill: "copywriting" }],
        },
        {
          name: "Same Name",
          description: "Second",
          trigger: "weekly",
          defaultPriority: "P2",
          steps: [{ skill: "seo-audit" }],
        },
      ],
    };
    expect(() => PipelineTemplateRegistry.fromData(bad)).toThrow(
      PipelineTemplateRegistryError,
    );
    expect(() => PipelineTemplateRegistry.fromData(bad)).toThrow(/Duplicate/);
  });

  it("rejects invalid priority", () => {
    const bad: PipelineTemplateRegistryData = {
      pipelines: [
        {
          name: "Bad Priority",
          description: "Bad",
          trigger: "manual",
          defaultPriority: "P9",
          steps: [{ skill: "copywriting" }],
        },
      ],
    };
    expect(() => PipelineTemplateRegistry.fromData(bad)).toThrow(
      PipelineTemplateRegistryError,
    );
    expect(() => PipelineTemplateRegistry.fromData(bad)).toThrow(/priority/);
  });

  it("rejects steps with no skill/parallel/review", () => {
    const bad: PipelineTemplateRegistryData = {
      pipelines: [
        {
          name: "Bad Steps",
          description: "Bad",
          trigger: "manual",
          defaultPriority: "P1",
          steps: [{}] as any,
        },
      ],
    };
    expect(() => PipelineTemplateRegistry.fromData(bad)).toThrow(
      PipelineTemplateRegistryError,
    );
  });

  it("rejects missing pipelines key", () => {
    expect(() =>
      PipelineTemplateRegistry.fromData({} as PipelineTemplateRegistryData),
    ).toThrow(PipelineTemplateRegistryError);
  });

  it("rejects non-object root", () => {
    expect(() =>
      PipelineTemplateRegistry.fromData(null as unknown as PipelineTemplateRegistryData),
    ).toThrow(PipelineTemplateRegistryError);
  });

  it("validates skill references when validSkills provided", () => {
    const data: PipelineTemplateRegistryData = {
      pipelines: [
        {
          name: "Test",
          description: "Test",
          trigger: "manual",
          defaultPriority: "P1",
          steps: [{ skill: "unknown-skill" }],
        },
      ],
    };
    expect(() =>
      PipelineTemplateRegistry.fromData(data, new Set(["copywriting"])),
    ).toThrow(PipelineTemplateRegistryError);
    expect(() =>
      PipelineTemplateRegistry.fromData(data, new Set(["copywriting"])),
    ).toThrow(/unknown skill/);
  });

  it("allows director as review step without validSkills check", () => {
    const data: PipelineTemplateRegistryData = {
      pipelines: [
        {
          name: "Test",
          description: "Test",
          trigger: "manual",
          defaultPriority: "P1",
          steps: [{ skill: "copywriting" }, { review: "director" }],
        },
      ],
    };
    expect(() =>
      PipelineTemplateRegistry.fromData(data, new Set(["copywriting"])),
    ).not.toThrow();
  });
});

// ── YAML Loading ──────────────────────────────────────────────────────────

describe("PipelineTemplateRegistry.fromYaml", () => {
  it("loads .agents/pipelines.yaml successfully", async () => {
    const registry = await PipelineTemplateRegistry.fromYaml(YAML_PATH);
    expect(registry.templates.length).toBe(PIPELINE_TEMPLATES.length);
  });

  it("YAML template names match hardcoded PIPELINE_TEMPLATES", async () => {
    const registry = await PipelineTemplateRegistry.fromYaml(YAML_PATH);
    const yamlNames = [...registry.templateNames].sort();
    const tsNames = PIPELINE_TEMPLATES.map((t) => t.name).sort();
    expect(yamlNames).toEqual(tsNames);
  });

  it("YAML template step counts match hardcoded PIPELINE_TEMPLATES", async () => {
    const registry = await PipelineTemplateRegistry.fromYaml(YAML_PATH);
    for (const tsTemplate of PIPELINE_TEMPLATES) {
      const yamlTemplate = registry.findTemplate(tsTemplate.name);
      expect(yamlTemplate).toBeDefined();
      expect(yamlTemplate!.steps.length).toBe(tsTemplate.steps.length);
    }
  });

  it("throws PipelineTemplateRegistryError for missing file", async () => {
    await expect(
      PipelineTemplateRegistry.fromYaml("/nonexistent/pipelines.yaml"),
    ).rejects.toThrow(PipelineTemplateRegistryError);
    await expect(
      PipelineTemplateRegistry.fromYaml("/nonexistent/pipelines.yaml"),
    ).rejects.toThrow(/not found/);
  });
});

// ── Exports ──────────────────────────────────────────────────────────────────

describe("PipelineTemplateRegistry exports", () => {
  it("is exported from agents/index.ts", async () => {
    const mod = await import("../index.ts");
    expect(mod.PipelineTemplateRegistry).toBeDefined();
    expect(mod.PipelineTemplateRegistryError).toBeDefined();
  });

  it("is exported from src/index.ts", async () => {
    const mod = await import("../../index.ts");
    expect(mod.PipelineTemplateRegistry).toBeDefined();
    expect(mod.PipelineTemplateRegistryError).toBeDefined();
  });
});
