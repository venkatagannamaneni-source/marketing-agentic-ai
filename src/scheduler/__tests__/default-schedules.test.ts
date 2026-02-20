import { describe, expect, it } from "bun:test";
import { DEFAULT_SCHEDULES } from "../default-schedules.ts";
import { parseCron } from "../cron.ts";
import { PIPELINE_TEMPLATES } from "../../agents/registry.ts";
import { GOAL_CATEGORIES } from "../../types/goal.ts";
import { PRIORITIES } from "../../types/task.ts";

describe("DEFAULT_SCHEDULES", () => {
  it("has exactly 6 schedules", () => {
    expect(DEFAULT_SCHEDULES).toHaveLength(6);
  });

  it("all IDs are unique", () => {
    const ids = DEFAULT_SCHEDULES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all cron expressions parse without error", () => {
    for (const schedule of DEFAULT_SCHEDULES) {
      expect(() => parseCron(schedule.cron)).not.toThrow();
    }
  });

  it("template-based schedules reference existing PIPELINE_TEMPLATES", () => {
    const templateNames = new Set(PIPELINE_TEMPLATES.map((t) => t.name));
    const templateSchedules = DEFAULT_SCHEDULES.filter(
      (s) => !s.pipelineId.startsWith("goal:"),
    );

    expect(templateSchedules.length).toBeGreaterThan(0);
    for (const schedule of templateSchedules) {
      expect(templateNames.has(schedule.pipelineId)).toBe(true);
    }
  });

  it("goal-based schedules have pipelineId starting with goal:", () => {
    const goalSchedules = DEFAULT_SCHEDULES.filter((s) =>
      s.pipelineId.startsWith("goal:"),
    );
    expect(goalSchedules.length).toBeGreaterThan(0);
    for (const schedule of goalSchedules) {
      expect(schedule.pipelineId).toMatch(/^goal:\w/);
    }
  });

  it("all schedules with goalCategory have valid categories", () => {
    const validCategories = new Set(GOAL_CATEGORIES);
    for (const schedule of DEFAULT_SCHEDULES) {
      if (schedule.goalCategory) {
        expect(validCategories.has(schedule.goalCategory)).toBe(true);
      }
    }
  });

  it("all schedules with priority have valid priorities", () => {
    const validPriorities = new Set(PRIORITIES);
    for (const schedule of DEFAULT_SCHEDULES) {
      if (schedule.priority) {
        expect(validPriorities.has(schedule.priority)).toBe(true);
      }
    }
  });

  it("all schedules are enabled by default", () => {
    for (const schedule of DEFAULT_SCHEDULES) {
      expect(schedule.enabled).toBe(true);
    }
  });

  it("all schedules have non-empty name and description", () => {
    for (const schedule of DEFAULT_SCHEDULES) {
      expect(schedule.name.length).toBeGreaterThan(0);
      expect(schedule.description.length).toBeGreaterThan(0);
    }
  });

  it("contains expected schedule IDs", () => {
    const ids = DEFAULT_SCHEDULES.map((s) => s.id);
    expect(ids).toContain("daily-social");
    expect(ids).toContain("daily-review");
    expect(ids).toContain("weekly-content");
    expect(ids).toContain("weekly-seo");
    expect(ids).toContain("monthly-cro");
    expect(ids).toContain("monthly-review");
  });
});
