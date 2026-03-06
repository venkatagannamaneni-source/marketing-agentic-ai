import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  RoutingRegistry,
  RoutingRegistryError,
  type RoutingRegistryData,
} from "../routing-registry.ts";
import { ROUTING_RULES } from "../squad-router.ts";
import { GOAL_CATEGORIES } from "../../types/goal.ts";

// ── Test Data ────────────────────────────────────────────────────────────────

const MINIMAL_DATA: RoutingRegistryData = {
  rules: {
    strategic: [
      {
        squad: "strategy",
        skills: ["content-strategy"],
        reason: "Strategy handles strategic goals",
      },
    ],
  },
};

const YAML_PATH = resolve(import.meta.dir, "../../../.agents/routing.yaml");

// ── fromData ────────────────────────────────────────────────────────────────

describe("RoutingRegistry.fromData", () => {
  it("creates registry from data", () => {
    const registry = RoutingRegistry.fromData(MINIMAL_DATA);
    expect(registry.categories).toHaveLength(1);
  });

  it("returns routes for known category", () => {
    const registry = RoutingRegistry.fromData(MINIMAL_DATA);
    const routes = registry.routeGoal("strategic");
    expect(routes).toHaveLength(1);
    expect(routes[0]!.squad).toBe("strategy");
  });

  it("returns empty array for unknown category", () => {
    const registry = RoutingRegistry.fromData(MINIMAL_DATA);
    const routes = registry.routeGoal("content");
    expect(routes).toHaveLength(0);
  });

  it("categories are sorted alphabetically", () => {
    const data: RoutingRegistryData = {
      rules: {
        retention: [
          { squad: "activate", skills: ["onboarding-cro"], reason: "r" },
        ],
        content: [
          { squad: "strategy", skills: ["content-strategy"], reason: "c" },
        ],
      },
    };
    const registry = RoutingRegistry.fromData(data);
    expect(registry.categories).toEqual(["content", "retention"]);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("RoutingRegistry validation", () => {
  it("rejects unknown goal categories", () => {
    const bad: RoutingRegistryData = {
      rules: {
        nonexistent_category: [
          { squad: "strategy", skills: ["content-strategy"], reason: "x" },
        ],
      },
    };
    expect(() => RoutingRegistry.fromData(bad)).toThrow(RoutingRegistryError);
    expect(() => RoutingRegistry.fromData(bad)).toThrow(/Unknown goal category/);
  });

  it("rejects empty skills list", () => {
    const bad: RoutingRegistryData = {
      rules: {
        strategic: [
          { squad: "strategy", skills: [], reason: "empty" },
        ],
      },
    };
    expect(() => RoutingRegistry.fromData(bad)).toThrow(RoutingRegistryError);
    expect(() => RoutingRegistry.fromData(bad)).toThrow(/skills list is empty/);
  });

  it("rejects missing rules key", () => {
    expect(() =>
      RoutingRegistry.fromData({} as RoutingRegistryData),
    ).toThrow(RoutingRegistryError);
  });

  it("rejects non-object root", () => {
    expect(() =>
      RoutingRegistry.fromData(null as unknown as RoutingRegistryData),
    ).toThrow(RoutingRegistryError);
  });

  it("rejects non-string skills in array", () => {
    const bad = {
      rules: {
        strategic: [
          { squad: "strategy", skills: [123, null], reason: "test" },
        ],
      },
    };
    try {
      RoutingRegistry.fromData(bad as unknown as RoutingRegistryData);
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingRegistryError);
      const regErr = err as RoutingRegistryError;
      expect(regErr.errors.some((e) => e.includes("must be a string"))).toBe(true);
    }
  });

  it("wraps YAML parse errors in RoutingRegistryError", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "routing-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, ":\n  :\n    - [invalid yaml");
    try {
      await expect(RoutingRegistry.fromYaml(path)).rejects.toThrow(RoutingRegistryError);
    } finally {
      await unlink(path);
    }
  });
});

// ── Cross-validation ──────────────────────────────────────────────────────

describe("RoutingRegistry.validateAgainst", () => {
  it("passes with valid skills and squads", () => {
    const registry = RoutingRegistry.fromData(MINIMAL_DATA);
    expect(() =>
      registry.validateAgainst(["content-strategy"], ["strategy"]),
    ).not.toThrow();
  });

  it("fails with unknown squad", () => {
    const registry = RoutingRegistry.fromData(MINIMAL_DATA);
    expect(() =>
      registry.validateAgainst(["content-strategy"], ["creative"]),
    ).toThrow(RoutingRegistryError);
    expect(() =>
      registry.validateAgainst(["content-strategy"], ["creative"]),
    ).toThrow(/unknown squad/);
  });

  it("fails with unknown skill", () => {
    const registry = RoutingRegistry.fromData(MINIMAL_DATA);
    expect(() =>
      registry.validateAgainst(["other-skill"], ["strategy"]),
    ).toThrow(RoutingRegistryError);
    expect(() =>
      registry.validateAgainst(["other-skill"], ["strategy"]),
    ).toThrow(/unknown skill/);
  });
});

// ── YAML Loading ──────────────────────────────────────────────────────────

describe("RoutingRegistry.fromYaml", () => {
  it("loads .agents/routing.yaml successfully", async () => {
    const registry = await RoutingRegistry.fromYaml(YAML_PATH);
    expect(registry.categories.length).toBe(GOAL_CATEGORIES.length);
  });

  it("YAML matches hardcoded ROUTING_RULES categories", async () => {
    const registry = await RoutingRegistry.fromYaml(YAML_PATH);
    const yamlCategories = ([...registry.categories] as string[]).sort();
    const tsCategories = Object.keys(ROUTING_RULES).sort();
    expect(yamlCategories).toEqual(tsCategories);
  });

  it("YAML matches hardcoded ROUTING_RULES route count per category", async () => {
    const registry = await RoutingRegistry.fromYaml(YAML_PATH);
    for (const [category, routes] of Object.entries(ROUTING_RULES)) {
      const yamlRoutes = registry.routeGoal(category as any);
      expect(yamlRoutes.length).toBe(routes.length);
    }
  });

  it("throws RoutingRegistryError for missing file", async () => {
    await expect(
      RoutingRegistry.fromYaml("/nonexistent/routing.yaml"),
    ).rejects.toThrow(RoutingRegistryError);
    await expect(
      RoutingRegistry.fromYaml("/nonexistent/routing.yaml"),
    ).rejects.toThrow(/not found/);
  });
});

// ── Exports ─────────────────────────────────────────────────────────────────

describe("RoutingRegistry exports", () => {
  it("is exported from director/index.ts", async () => {
    const mod = await import("../index.ts");
    expect(mod.RoutingRegistry).toBeDefined();
    expect(mod.RoutingRegistryError).toBeDefined();
  });

  it("is exported from src/index.ts", async () => {
    const mod = await import("../../index.ts");
    expect(mod.RoutingRegistry).toBeDefined();
    expect(mod.RoutingRegistryError).toBeDefined();
  });
});
