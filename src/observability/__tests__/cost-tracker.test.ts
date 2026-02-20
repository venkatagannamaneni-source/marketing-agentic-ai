import { describe, it, expect, beforeEach } from "bun:test";
import {
  CostTracker,
  DEFAULT_COST_TRACKER_CONFIG,
  type CostEntry,
  type CostFileWriter,
} from "../cost-tracker.ts";
import type { SkillName, ModelTier } from "../../types/agent.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

function createTestCostEntry(overrides?: Partial<CostEntry>): CostEntry {
  return {
    timestamp: new Date().toISOString(),
    taskId: "copywriting-20260220-abc123",
    skillName: "copywriting" as SkillName,
    modelTier: "sonnet" as ModelTier,
    inputTokens: 1000,
    outputTokens: 500,
    estimatedCost: 0.0105, // (1000 * 3 + 500 * 15) / 1_000_000
    ...overrides,
  };
}

function createMockWriter(): CostFileWriter & {
  writtenFiles: { path: string; content: string }[];
  mkdirCalls: string[];
} {
  const writer = {
    writtenFiles: [] as { path: string; content: string }[],
    mkdirCalls: [] as string[],
    async writeFile(path: string, content: string) {
      writer.writtenFiles.push({ path, content });
    },
    async mkdir(path: string) {
      writer.mkdirCalls.push(path);
    },
  };
  return writer;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  // ── record() ────────────────────────────────────────────────────────────

  describe("record", () => {
    it("records a valid cost entry", () => {
      const entry = createTestCostEntry();
      tracker.record(entry);
      expect(tracker.entryCount).toBe(1);
      const entries = tracker.getEntries();
      expect(entries[0]!.taskId).toBe("copywriting-20260220-abc123");
    });

    it("increments entry count", () => {
      tracker.record(createTestCostEntry());
      tracker.record(createTestCostEntry({ taskId: "task-2" }));
      tracker.record(createTestCostEntry({ taskId: "task-3" }));
      expect(tracker.entryCount).toBe(3);
    });

    it("clamps negative estimatedCost to 0", () => {
      tracker.record(createTestCostEntry({ estimatedCost: -5 }));
      expect(tracker.getTotalSpent()).toBe(0);
    });

    it("clamps NaN estimatedCost to 0", () => {
      tracker.record(createTestCostEntry({ estimatedCost: NaN }));
      expect(tracker.getTotalSpent()).toBe(0);
    });

    it("clamps Infinity estimatedCost to 0", () => {
      tracker.record(createTestCostEntry({ estimatedCost: Infinity }));
      expect(tracker.getTotalSpent()).toBe(0);
    });

    it("clamps -Infinity estimatedCost to 0", () => {
      tracker.record(createTestCostEntry({ estimatedCost: -Infinity }));
      expect(tracker.getTotalSpent()).toBe(0);
    });

    it("clamps negative inputTokens to 0", () => {
      tracker.record(createTestCostEntry({ inputTokens: -100 }));
      const entries = tracker.getEntries();
      expect(entries[0]!.inputTokens).toBe(0);
    });

    it("clamps negative outputTokens to 0", () => {
      tracker.record(createTestCostEntry({ outputTokens: -50 }));
      const entries = tracker.getEntries();
      expect(entries[0]!.outputTokens).toBe(0);
    });

    it("handles multiple rapid records", () => {
      for (let i = 0; i < 100; i++) {
        tracker.record(createTestCostEntry({ taskId: `task-${i}`, estimatedCost: 0.01 }));
      }
      expect(tracker.entryCount).toBe(100);
    });
  });

  // ── getTotalSpent() ─────────────────────────────────────────────────────

  describe("getTotalSpent", () => {
    it("returns 0 when no entries recorded", () => {
      expect(tracker.getTotalSpent()).toBe(0);
    });

    it("sums all recorded costs", () => {
      tracker.record(createTestCostEntry({ estimatedCost: 1.5 }));
      tracker.record(createTestCostEntry({ estimatedCost: 2.5 }));
      expect(tracker.getTotalSpent()).toBe(4);
    });

    it("avoids floating-point precision errors", () => {
      // Classic floating-point trap: 0.1 + 0.2 !== 0.3 in IEEE 754
      tracker.record(createTestCostEntry({ estimatedCost: 0.1 }));
      tracker.record(createTestCostEntry({ estimatedCost: 0.2 }));
      const total = tracker.getTotalSpent();
      // With microdollar arithmetic: 100000 + 200000 = 300000 → 0.3
      expect(total).toBe(0.3);
    });

    it("handles many small values without drift", () => {
      // 10 * 0.1 should equal 1.0 exactly
      for (let i = 0; i < 10; i++) {
        tracker.record(createTestCostEntry({ estimatedCost: 0.1 }));
      }
      expect(tracker.getTotalSpent()).toBe(1);
    });

    it("handles very small costs correctly", () => {
      tracker.record(createTestCostEntry({ estimatedCost: 0.000001 }));
      expect(tracker.getTotalSpent()).toBe(0.000001);
    });

    it("handles very large costs correctly", () => {
      tracker.record(createTestCostEntry({ estimatedCost: 999999.99 }));
      expect(tracker.getTotalSpent()).toBe(999999.99);
    });
  });

  // ── getSpentSince() ─────────────────────────────────────────────────────

  describe("getSpentSince", () => {
    it("returns total for entries after the given date", () => {
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-18T10:00:00.000Z", estimatedCost: 1 }),
      );
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-19T10:00:00.000Z", estimatedCost: 2 }),
      );
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-20T10:00:00.000Z", estimatedCost: 3 }),
      );

      const result = tracker.getSpentSince(new Date("2026-02-19T00:00:00.000Z"));
      expect(result).toBe(5); // 2 + 3
    });

    it("includes entries on the exact date boundary", () => {
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-19T00:00:00.000Z", estimatedCost: 5 }),
      );
      const result = tracker.getSpentSince(new Date("2026-02-19T00:00:00.000Z"));
      expect(result).toBe(5);
    });

    it("returns 0 when all entries are before the date", () => {
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-18T10:00:00.000Z", estimatedCost: 10 }),
      );
      const result = tracker.getSpentSince(new Date("2026-02-20T00:00:00.000Z"));
      expect(result).toBe(0);
    });

    it("returns 0 when no entries exist", () => {
      expect(tracker.getSpentSince(new Date())).toBe(0);
    });

    it("returns all entries when date is epoch", () => {
      tracker.record(createTestCostEntry({ estimatedCost: 7 }));
      const result = tracker.getSpentSince(new Date(0));
      expect(result).toBe(7);
    });

    it("returns 0 when date is in the future", () => {
      tracker.record(createTestCostEntry({ estimatedCost: 5 }));
      const result = tracker.getSpentSince(new Date("2099-01-01T00:00:00.000Z"));
      expect(result).toBe(0);
    });

    it("handles invalid date by returning all", () => {
      tracker.record(createTestCostEntry({ estimatedCost: 3 }));
      const result = tracker.getSpentSince(new Date("not-a-date"));
      expect(result).toBe(3);
    });
  });

  // ── getBySkill() ────────────────────────────────────────────────────────

  describe("getBySkill", () => {
    it("returns empty array when no entries", () => {
      expect(tracker.getBySkill()).toEqual([]);
    });

    it("groups entries by skill name", () => {
      tracker.record(
        createTestCostEntry({ skillName: "copywriting" as SkillName, estimatedCost: 1 }),
      );
      tracker.record(
        createTestCostEntry({ skillName: "seo-audit" as SkillName, estimatedCost: 2 }),
      );
      tracker.record(
        createTestCostEntry({ skillName: "copywriting" as SkillName, estimatedCost: 3 }),
      );

      const bySkill = tracker.getBySkill();
      expect(bySkill.length).toBe(2);

      const copywriting = bySkill.find((s) => s.skillName === "copywriting");
      expect(copywriting).toBeDefined();
      expect(copywriting!.totalCost).toBe(4);
      expect(copywriting!.entryCount).toBe(2);

      const seo = bySkill.find((s) => s.skillName === "seo-audit");
      expect(seo).toBeDefined();
      expect(seo!.totalCost).toBe(2);
      expect(seo!.entryCount).toBe(1);
    });

    it("sums tokens per skill", () => {
      tracker.record(
        createTestCostEntry({
          skillName: "copywriting" as SkillName,
          inputTokens: 100,
          outputTokens: 50,
        }),
      );
      tracker.record(
        createTestCostEntry({
          skillName: "copywriting" as SkillName,
          inputTokens: 200,
          outputTokens: 150,
        }),
      );

      const bySkill = tracker.getBySkill();
      const copywriting = bySkill.find((s) => s.skillName === "copywriting");
      expect(copywriting!.totalInputTokens).toBe(300);
      expect(copywriting!.totalOutputTokens).toBe(200);
    });
  });

  // ── getByModel() ────────────────────────────────────────────────────────

  describe("getByModel", () => {
    it("returns empty array when no entries", () => {
      expect(tracker.getByModel()).toEqual([]);
    });

    it("groups entries by model tier", () => {
      tracker.record(
        createTestCostEntry({ modelTier: "sonnet" as ModelTier, estimatedCost: 1 }),
      );
      tracker.record(
        createTestCostEntry({ modelTier: "haiku" as ModelTier, estimatedCost: 0.5 }),
      );
      tracker.record(
        createTestCostEntry({ modelTier: "sonnet" as ModelTier, estimatedCost: 2 }),
      );

      const byModel = tracker.getByModel();
      expect(byModel.length).toBe(2);

      const sonnet = byModel.find((m) => m.modelTier === "sonnet");
      expect(sonnet!.totalCost).toBe(3);
      expect(sonnet!.entryCount).toBe(2);

      const haiku = byModel.find((m) => m.modelTier === "haiku");
      expect(haiku!.totalCost).toBe(0.5);
      expect(haiku!.entryCount).toBe(1);
    });

    it("sums tokens per model", () => {
      tracker.record(
        createTestCostEntry({
          modelTier: "opus" as ModelTier,
          inputTokens: 500,
          outputTokens: 200,
        }),
      );
      tracker.record(
        createTestCostEntry({
          modelTier: "opus" as ModelTier,
          inputTokens: 300,
          outputTokens: 100,
        }),
      );

      const byModel = tracker.getByModel();
      const opus = byModel.find((m) => m.modelTier === "opus");
      expect(opus!.totalInputTokens).toBe(800);
      expect(opus!.totalOutputTokens).toBe(300);
    });
  });

  // ── getDailyBreakdown() ─────────────────────────────────────────────────

  describe("getDailyBreakdown", () => {
    it("returns empty array when no entries", () => {
      expect(tracker.getDailyBreakdown()).toEqual([]);
    });

    it("groups entries by date", () => {
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-18T10:00:00.000Z", estimatedCost: 1 }),
      );
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-18T15:00:00.000Z", estimatedCost: 2 }),
      );
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-19T10:00:00.000Z", estimatedCost: 3 }),
      );

      const daily = tracker.getDailyBreakdown();
      expect(daily.length).toBe(2);
      expect(daily[0]!.date).toBe("2026-02-18");
      expect(daily[0]!.totalCost).toBe(3);
      expect(daily[0]!.entryCount).toBe(2);
      expect(daily[1]!.date).toBe("2026-02-19");
      expect(daily[1]!.totalCost).toBe(3);
      expect(daily[1]!.entryCount).toBe(1);
    });

    it("sorts by date ascending", () => {
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-20T10:00:00.000Z", estimatedCost: 1 }),
      );
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-18T10:00:00.000Z", estimatedCost: 1 }),
      );
      tracker.record(
        createTestCostEntry({ timestamp: "2026-02-19T10:00:00.000Z", estimatedCost: 1 }),
      );

      const daily = tracker.getDailyBreakdown();
      expect(daily[0]!.date).toBe("2026-02-18");
      expect(daily[1]!.date).toBe("2026-02-19");
      expect(daily[2]!.date).toBe("2026-02-20");
    });
  });

  // ── toBudgetState() ─────────────────────────────────────────────────────

  describe("toBudgetState", () => {
    it("returns normal level when under warning threshold", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 100, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 } });
      tracker.record(createTestCostEntry({ estimatedCost: 50 })); // 50%
      const state = tracker.toBudgetState();
      expect(state.level).toBe("normal");
      expect(state.allowedPriorities).toEqual(["P0", "P1", "P2", "P3"]);
      expect(state.modelOverride).toBeNull();
    });

    it("returns warning level at warning threshold", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 100, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 } });
      tracker.record(createTestCostEntry({ estimatedCost: 80 })); // 80%
      const state = tracker.toBudgetState();
      expect(state.level).toBe("warning");
      expect(state.allowedPriorities).toEqual(["P0", "P1", "P2"]);
      expect(state.modelOverride).toBeNull();
    });

    it("returns throttle level at throttle threshold", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 100, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 } });
      tracker.record(createTestCostEntry({ estimatedCost: 90 })); // 90%
      const state = tracker.toBudgetState();
      expect(state.level).toBe("throttle");
      expect(state.allowedPriorities).toEqual(["P0", "P1"]);
      expect(state.modelOverride).toBeNull();
    });

    it("returns critical level at critical threshold", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 100, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 } });
      tracker.record(createTestCostEntry({ estimatedCost: 95 })); // 95%
      const state = tracker.toBudgetState();
      expect(state.level).toBe("critical");
      expect(state.allowedPriorities).toEqual(["P0"]);
      expect(state.modelOverride).toBe("haiku");
    });

    it("returns exhausted level at 100%", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 100, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 } });
      tracker.record(createTestCostEntry({ estimatedCost: 100 })); // 100%
      const state = tracker.toBudgetState();
      expect(state.level).toBe("exhausted");
      expect(state.allowedPriorities).toEqual([]);
      expect(state.modelOverride).toBeNull();
    });

    it("returns exhausted when spent exceeds budget", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 100, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 } });
      tracker.record(createTestCostEntry({ estimatedCost: 150 })); // 150%
      const state = tracker.toBudgetState();
      expect(state.level).toBe("exhausted");
      expect(state.percentUsed).toBeGreaterThan(100);
    });

    it("handles zero totalMonthly budget", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 0, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 } });
      tracker.record(createTestCostEntry({ estimatedCost: 5 }));
      const state = tracker.toBudgetState();
      // percentUsed = 0 when totalMonthly is 0 (avoid division by zero)
      expect(state.percentUsed).toBe(0);
      expect(state.level).toBe("normal");
    });

    it("includes correct spent and totalBudget values", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 500, warningPercent: 80, throttlePercent: 90, criticalPercent: 95 } });
      tracker.record(createTestCostEntry({ estimatedCost: 100 }));
      const state = tracker.toBudgetState();
      expect(state.totalBudget).toBe(500);
      expect(state.spent).toBe(100);
      expect(state.percentUsed).toBe(20);
    });

    it("uses custom config thresholds", () => {
      tracker = new CostTracker({ budget: { totalMonthly: 100, warningPercent: 50, throttlePercent: 60, criticalPercent: 70 } });
      tracker.record(createTestCostEntry({ estimatedCost: 55 })); // 55% — above custom warning
      const state = tracker.toBudgetState();
      expect(state.level).toBe("warning");
    });

    it("returns normal with no entries", () => {
      const state = tracker.toBudgetState();
      expect(state.level).toBe("normal");
      expect(state.spent).toBe(0);
    });
  });

  // ── flush() ─────────────────────────────────────────────────────────────

  describe("flush", () => {
    it("writes a markdown report to the specified directory", async () => {
      const writer = createMockWriter();
      tracker.record(createTestCostEntry({ estimatedCost: 1.5 }));
      await tracker.flush("/tmp/metrics", writer);

      expect(writer.writtenFiles.length).toBe(1);
      expect(writer.writtenFiles[0]!.path).toMatch(/^\/tmp\/metrics\/\d{4}-\d{2}-\d{2}-budget\.md$/);
      expect(writer.writtenFiles[0]!.content).toContain("# Cost Report");
    });

    it("calls mkdir before writeFile", async () => {
      const callOrder: string[] = [];
      const writer: CostFileWriter = {
        async mkdir(path) {
          callOrder.push(`mkdir:${path}`);
        },
        async writeFile(path, _content) {
          callOrder.push(`write:${path}`);
        },
      };

      await tracker.flush("/tmp/metrics", writer);
      expect(callOrder.length).toBe(2);
      expect(callOrder[0]).toBe("mkdir:/tmp/metrics");
      expect(callOrder[1]!).toMatch(/^write:/);
    });

    it("generates valid markdown with empty entries", async () => {
      const writer = createMockWriter();
      await tracker.flush("/tmp/metrics", writer);

      expect(writer.writtenFiles.length).toBe(1);
      const content = writer.writtenFiles[0]!.content;
      expect(content).toContain("Total entries: 0");
      expect(content).toContain("$0.000000");
      expect(content).toContain("No data collected.");
    });

    it("includes skill and model breakdowns", async () => {
      const writer = createMockWriter();
      tracker.record(createTestCostEntry({ skillName: "copywriting" as SkillName, modelTier: "sonnet" as ModelTier }));
      await tracker.flush("/tmp/metrics", writer);

      const content = writer.writtenFiles[0]!.content;
      expect(content).toContain("## By Skill");
      expect(content).toContain("copywriting");
      expect(content).toContain("## By Model");
      expect(content).toContain("sonnet");
    });

    it("propagates writer errors", async () => {
      const writer: CostFileWriter = {
        async mkdir() {
          throw new Error("Permission denied");
        },
        async writeFile() {},
      };

      await expect(tracker.flush("/tmp/metrics", writer)).rejects.toThrow("Permission denied");
    });
  });

  // ── reset() ─────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all entries", () => {
      tracker.record(createTestCostEntry());
      tracker.record(createTestCostEntry());
      expect(tracker.entryCount).toBe(2);
      tracker.reset();
      expect(tracker.entryCount).toBe(0);
    });

    it("getTotalSpent returns 0 after reset", () => {
      tracker.record(createTestCostEntry({ estimatedCost: 10 }));
      tracker.reset();
      expect(tracker.getTotalSpent()).toBe(0);
    });
  });

  // ── getEntries() ────────────────────────────────────────────────────────

  describe("getEntries", () => {
    it("returns a defensive copy", () => {
      tracker.record(createTestCostEntry());
      const entries1 = tracker.getEntries();
      const entries2 = tracker.getEntries();
      expect(entries1).not.toBe(entries2);
      expect(entries1).toEqual(entries2);
    });

    it("modifications to returned array do not affect tracker", () => {
      tracker.record(createTestCostEntry());
      const entries = tracker.getEntries() as CostEntry[];
      entries.length = 0;
      expect(tracker.entryCount).toBe(1);
    });
  });

  // ── DEFAULT_COST_TRACKER_CONFIG ─────────────────────────────────────────

  describe("DEFAULT_COST_TRACKER_CONFIG", () => {
    it("has expected default values", () => {
      expect(DEFAULT_COST_TRACKER_CONFIG.budget.totalMonthly).toBe(1000);
      expect(DEFAULT_COST_TRACKER_CONFIG.budget.warningPercent).toBe(80);
      expect(DEFAULT_COST_TRACKER_CONFIG.budget.throttlePercent).toBe(90);
      expect(DEFAULT_COST_TRACKER_CONFIG.budget.criticalPercent).toBe(95);
    });
  });
});
