import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  ScheduleRegistry,
  ScheduleRegistryError,
  type ScheduleRegistryData,
} from "../schedule-registry.ts";
import { DEFAULT_SCHEDULES } from "../default-schedules.ts";

// ── Test Data ────────────────────────────────────────────────────────────────

const MINIMAL_DATA: ScheduleRegistryData = {
  schedules: [
    {
      id: "test-schedule",
      name: "Test Schedule",
      cron: "0 9 * * *",
      pipelineId: "goal:test",
      enabled: true,
      description: "A test schedule",
      priority: "P2",
      goalCategory: "content",
    },
  ],
};

const TWO_SCHEDULE_DATA: ScheduleRegistryData = {
  schedules: [
    {
      id: "sched-a",
      name: "Schedule A",
      cron: "0 6 * * *",
      pipelineId: "goal:a",
      enabled: true,
      description: "Schedule A",
      priority: "P1",
      goalCategory: "measurement",
    },
    {
      id: "sched-b",
      name: "Schedule B",
      cron: "0 0 * * 1",
      pipelineId: "Content Production",
      enabled: true,
      description: "Schedule B",
      priority: "P2",
      goalCategory: "content",
    },
  ],
};

// ── fromData ─────────────────────────────────────────────────────────────────

describe("ScheduleRegistry.fromData", () => {
  it("creates registry from data", () => {
    const registry = ScheduleRegistry.fromData(MINIMAL_DATA);
    expect(registry.schedules).toHaveLength(1);
  });

  it("creates registry with multiple schedules", () => {
    const registry = ScheduleRegistry.fromData(TWO_SCHEDULE_DATA);
    expect(registry.schedules).toHaveLength(2);
  });

  it("preserves schedule properties", () => {
    const registry = ScheduleRegistry.fromData(MINIMAL_DATA);
    const s = registry.schedules[0]!;
    expect(s.id).toBe("test-schedule");
    expect(s.name).toBe("Test Schedule");
    expect(s.cron).toBe("0 9 * * *");
    expect(s.pipelineId).toBe("goal:test");
    expect(s.enabled).toBe(true);
    expect(s.description).toBe("A test schedule");
    expect(s.priority).toBe("P2");
    expect(s.goalCategory).toBe("content");
  });
});

// ── schedules ────────────────────────────────────────────────────────────────

describe("ScheduleRegistry.schedules", () => {
  it("returns all entries", () => {
    const registry = ScheduleRegistry.fromData(TWO_SCHEDULE_DATA);
    const schedules = registry.schedules;
    expect(schedules).toHaveLength(2);
    expect(schedules[0]!.id).toBe("sched-a");
    expect(schedules[1]!.id).toBe("sched-b");
  });

  it("returns readonly array", () => {
    const registry = ScheduleRegistry.fromData(MINIMAL_DATA);
    expect(Object.isFrozen(registry.schedules)).toBe(true);
  });
});

// ── getSchedule ──────────────────────────────────────────────────────────────

describe("ScheduleRegistry.getSchedule", () => {
  it("finds schedule by id", () => {
    const registry = ScheduleRegistry.fromData(TWO_SCHEDULE_DATA);
    const s = registry.getSchedule("sched-a");
    expect(s).toBeDefined();
    expect(s!.name).toBe("Schedule A");
  });

  it("returns undefined for unknown id", () => {
    const registry = ScheduleRegistry.fromData(MINIMAL_DATA);
    expect(registry.getSchedule("nonexistent")).toBeUndefined();
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("ScheduleRegistry validation", () => {
  it("rejects empty schedules", () => {
    expect(() =>
      ScheduleRegistry.fromData({ schedules: [] }),
    ).toThrow(ScheduleRegistryError);
    expect(() =>
      ScheduleRegistry.fromData({ schedules: [] }),
    ).toThrow(/No schedules defined/);
  });

  it("rejects invalid cron expression", () => {
    const bad: ScheduleRegistryData = {
      schedules: [
        {
          id: "bad-cron",
          name: "Bad Cron",
          cron: "not-a-cron",
          pipelineId: "goal:test",
          enabled: true,
          description: "Bad cron",
        },
      ],
    };
    expect(() => ScheduleRegistry.fromData(bad)).toThrow(ScheduleRegistryError);
    expect(() => ScheduleRegistry.fromData(bad)).toThrow(/invalid cron expression/);
  });

  it("rejects duplicate schedule IDs", () => {
    const bad: ScheduleRegistryData = {
      schedules: [
        {
          id: "dup",
          name: "Dup 1",
          cron: "0 9 * * *",
          pipelineId: "goal:a",
          enabled: true,
          description: "Dup 1",
        },
        {
          id: "dup",
          name: "Dup 2",
          cron: "0 10 * * *",
          pipelineId: "goal:b",
          enabled: true,
          description: "Dup 2",
        },
      ],
    };
    expect(() => ScheduleRegistry.fromData(bad)).toThrow(ScheduleRegistryError);
    expect(() => ScheduleRegistry.fromData(bad)).toThrow(/Duplicate schedule ID/);
  });

  it("rejects invalid priority", () => {
    const bad: ScheduleRegistryData = {
      schedules: [
        {
          id: "bad-priority",
          name: "Bad Priority",
          cron: "0 9 * * *",
          pipelineId: "goal:test",
          enabled: true,
          description: "Bad priority",
          priority: "P9",
        },
      ],
    };
    expect(() => ScheduleRegistry.fromData(bad)).toThrow(ScheduleRegistryError);
    expect(() => ScheduleRegistry.fromData(bad)).toThrow(/invalid priority/);
  });

  it("rejects invalid goalCategory", () => {
    const bad: ScheduleRegistryData = {
      schedules: [
        {
          id: "bad-cat",
          name: "Bad Category",
          cron: "0 9 * * *",
          pipelineId: "goal:test",
          enabled: true,
          description: "Bad category",
          goalCategory: "nonexistent",
        },
      ],
    };
    expect(() => ScheduleRegistry.fromData(bad)).toThrow(ScheduleRegistryError);
    expect(() => ScheduleRegistry.fromData(bad)).toThrow(/invalid goalCategory/);
  });

  it("collects multiple errors", () => {
    const bad: ScheduleRegistryData = {
      schedules: [
        {
          id: "multi-bad",
          name: "Multi Bad",
          cron: "invalid",
          pipelineId: "goal:test",
          enabled: true,
          description: "Multiple issues",
          priority: "P9",
          goalCategory: "fake",
        },
      ],
    };
    try {
      ScheduleRegistry.fromData(bad);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScheduleRegistryError);
      const err = e as ScheduleRegistryError;
      expect(err.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ── Schema validation ───────────────────────────────────────────────────────

describe("ScheduleRegistry schema validation", () => {
  it("rejects YAML with missing schedules key", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "sched-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, "something_else: true\n");
    try {
      await expect(ScheduleRegistry.fromYaml(path)).rejects.toThrow(
        ScheduleRegistryError,
      );
    } finally {
      await unlink(path);
    }
  });

  it("rejects YAML with non-object root", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "sched-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, "just a string\n");
    try {
      await expect(ScheduleRegistry.fromYaml(path)).rejects.toThrow(
        ScheduleRegistryError,
      );
    } finally {
      await unlink(path);
    }
  });
});

// ── Required field validation ───────────────────────────────────────────────

describe("ScheduleRegistry required field validation", () => {
  it("rejects schedule entry missing id", () => {
    const bad = { schedules: [{ name: "X", cron: "0 9 * * *", pipelineId: "p", enabled: true, description: "d" }] };
    try {
      ScheduleRegistry.fromData(bad as unknown as ScheduleRegistryData);
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduleRegistryError);
      expect((err as ScheduleRegistryError).errors.some((e) => e.includes("missing or invalid 'id'"))).toBe(true);
    }
  });

  it("rejects schedule entry missing enabled", () => {
    const bad = { schedules: [{ id: "x", name: "X", cron: "0 9 * * *", pipelineId: "p", description: "d" }] };
    try {
      ScheduleRegistry.fromData(bad as unknown as ScheduleRegistryData);
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduleRegistryError);
      expect((err as ScheduleRegistryError).errors.some((e) => e.includes("missing or invalid 'enabled'"))).toBe(true);
    }
  });

  it("rejects non-object schedule entry", () => {
    const bad = { schedules: ["not-an-object"] };
    try {
      ScheduleRegistry.fromData(bad as unknown as ScheduleRegistryData);
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduleRegistryError);
      expect((err as ScheduleRegistryError).errors.some((e) => e.includes("expected an object"))).toBe(true);
    }
  });

  it("rejects malformed YAML with parse error wrapped in ScheduleRegistryError", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "sched-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, ":\n  :\n    - [invalid yaml");
    try {
      await expect(ScheduleRegistry.fromYaml(path)).rejects.toThrow(ScheduleRegistryError);
    } finally {
      await unlink(path);
    }
  });
});

// ── YAML Loading ─────────────────────────────────────────────────────────────

describe("ScheduleRegistry.fromYaml", () => {
  const yamlPath = resolve(import.meta.dir, "../../../.agents/schedules.yaml");

  it("loads .agents/schedules.yaml successfully", async () => {
    const registry = await ScheduleRegistry.fromYaml(yamlPath);
    expect(registry.schedules.length).toBe(6);
  });

  it("all schedule IDs are unique", async () => {
    const registry = await ScheduleRegistry.fromYaml(yamlPath);
    const ids = registry.schedules.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("throws ScheduleRegistryError for missing file", async () => {
    await expect(
      ScheduleRegistry.fromYaml("/nonexistent/path/schedules.yaml"),
    ).rejects.toThrow(ScheduleRegistryError);
    await expect(
      ScheduleRegistry.fromYaml("/nonexistent/path/schedules.yaml"),
    ).rejects.toThrow(/not found/);
  });
});

// ── YAML ↔ Defaults Sync ────────────────────────────────────────────────────

describe("YAML matches TypeScript defaults", () => {
  const yamlPath = resolve(import.meta.dir, "../../../.agents/schedules.yaml");

  it("schedule count matches", async () => {
    const registry = await ScheduleRegistry.fromYaml(yamlPath);
    expect(registry.schedules.length).toBe(DEFAULT_SCHEDULES.length);
  });

  it("schedule IDs match", async () => {
    const registry = await ScheduleRegistry.fromYaml(yamlPath);
    const yamlIds = registry.schedules.map((s) => s.id).sort();
    const tsIds = DEFAULT_SCHEDULES.map((s) => s.id).sort();
    expect(yamlIds).toEqual(tsIds);
  });

  it("schedule data matches for each entry", async () => {
    const registry = await ScheduleRegistry.fromYaml(yamlPath);
    for (const defaultEntry of DEFAULT_SCHEDULES) {
      const yamlEntry = registry.getSchedule(defaultEntry.id);
      expect(yamlEntry).toBeDefined();
      expect(yamlEntry!.name).toBe(defaultEntry.name);
      expect(yamlEntry!.cron).toBe(defaultEntry.cron);
      expect(yamlEntry!.pipelineId).toBe(defaultEntry.pipelineId);
      expect(yamlEntry!.enabled).toBe(defaultEntry.enabled);
      expect(yamlEntry!.description).toBe(defaultEntry.description);
      expect(yamlEntry!.priority).toBe(defaultEntry.priority);
      expect(yamlEntry!.goalCategory).toBe(defaultEntry.goalCategory);
    }
  });
});

// ── Exports ──────────────────────────────────────────────────────────────────

describe("ScheduleRegistry exports", () => {
  it("is exported from scheduler/index.ts", async () => {
    const mod = await import("../index.ts");
    expect(mod.ScheduleRegistry).toBeDefined();
    expect(mod.ScheduleRegistryError).toBeDefined();
  });

  it("is exported from src/index.ts", async () => {
    const mod = await import("../../index.ts");
    expect(mod.ScheduleRegistry).toBeDefined();
    expect(mod.ScheduleRegistryError).toBeDefined();
  });
});
