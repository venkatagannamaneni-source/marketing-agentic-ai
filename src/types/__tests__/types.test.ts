import { describe, expect, it } from "bun:test";
import {
  SQUAD_NAMES,
  SKILL_NAMES,
  SKILL_SQUAD_MAP,
  FOUNDATION_SKILL,
  getSquadSkills,
  PRIORITIES,
  TASK_STATUSES,
  REVIEW_VERDICTS,
  PIPELINE_STATUSES,
  EVENT_TYPES,
  SYSTEM_STATES,
  DEGRADATION_LEVELS,
  DEGRADATION_DESCRIPTIONS,
  WORKSPACE_DIRS,
} from "../index.ts";

describe("Squad Names", () => {
  it("has exactly 5 squads", () => {
    expect(SQUAD_NAMES).toHaveLength(5);
  });

  it("contains expected squads", () => {
    expect(SQUAD_NAMES).toContain("strategy");
    expect(SQUAD_NAMES).toContain("creative");
    expect(SQUAD_NAMES).toContain("convert");
    expect(SQUAD_NAMES).toContain("activate");
    expect(SQUAD_NAMES).toContain("measure");
  });
});

describe("Skill Names", () => {
  it("has exactly 26 skills", () => {
    expect(SKILL_NAMES).toHaveLength(26);
  });

  it("has no duplicates", () => {
    const unique = new Set(SKILL_NAMES);
    expect(unique.size).toBe(SKILL_NAMES.length);
  });

  it("includes foundation skill", () => {
    expect(SKILL_NAMES).toContain(FOUNDATION_SKILL);
    expect(FOUNDATION_SKILL).toBe("product-marketing-context");
  });
});

describe("Skill-Squad Mapping", () => {
  it("maps every skill to a squad or null", () => {
    for (const skill of SKILL_NAMES) {
      expect(skill in SKILL_SQUAD_MAP).toBe(true);
    }
  });

  it("maps product-marketing-context to null (foundation)", () => {
    expect(SKILL_SQUAD_MAP["product-marketing-context"]).toBeNull();
  });

  it("has correct count per squad", () => {
    expect(getSquadSkills("strategy")).toHaveLength(6);
    expect(getSquadSkills("creative")).toHaveLength(7);
    expect(getSquadSkills("convert")).toHaveLength(5);
    expect(getSquadSkills("activate")).toHaveLength(4);
    expect(getSquadSkills("measure")).toHaveLength(3);
  });

  it("all squad skills sum to 25 (26 minus foundation)", () => {
    const total = SQUAD_NAMES.reduce(
      (sum, squad) => sum + getSquadSkills(squad).length,
      0,
    );
    expect(total).toBe(25);
  });
});

describe("Priority", () => {
  it("has 4 levels in order", () => {
    expect(PRIORITIES).toEqual(["P0", "P1", "P2", "P3"]);
  });
});

describe("Task Statuses", () => {
  it("has 11 statuses", () => {
    expect(TASK_STATUSES).toHaveLength(11);
  });

  it("includes critical lifecycle states", () => {
    expect(TASK_STATUSES).toContain("pending");
    expect(TASK_STATUSES).toContain("in_progress");
    expect(TASK_STATUSES).toContain("completed");
    expect(TASK_STATUSES).toContain("failed");
    expect(TASK_STATUSES).toContain("approved");
  });
});

describe("Review Verdicts", () => {
  it("has 3 verdicts", () => {
    expect(REVIEW_VERDICTS).toEqual(["APPROVE", "REVISE", "REJECT"]);
  });
});

describe("Pipeline Statuses", () => {
  it("has 6 statuses", () => {
    expect(PIPELINE_STATUSES).toHaveLength(6);
  });
});

describe("Event Types", () => {
  it("has 12 event types", () => {
    expect(EVENT_TYPES).toHaveLength(12);
  });
});

describe("System Health", () => {
  it("has 4 system states", () => {
    expect(SYSTEM_STATES).toHaveLength(4);
  });

  it("has 5 degradation levels (0-4)", () => {
    expect(DEGRADATION_LEVELS).toEqual([0, 1, 2, 3, 4]);
  });

  it("has description for each degradation level", () => {
    for (const level of DEGRADATION_LEVELS) {
      expect(DEGRADATION_DESCRIPTIONS[level]).toBeDefined();
      expect(typeof DEGRADATION_DESCRIPTIONS[level]).toBe("string");
    }
  });
});

describe("Workspace Dirs", () => {
  it("has 8 directories", () => {
    expect(WORKSPACE_DIRS).toEqual([
      "context",
      "tasks",
      "outputs",
      "reviews",
      "metrics",
      "memory",
      "goals",
      "schedules",
    ]);
  });
});
