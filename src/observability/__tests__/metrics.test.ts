import { describe, it, expect, beforeEach } from "bun:test";
import {
  MetricsCollector,
  type TaskExecutionRecord,
  type PipelineRunRecord,
  type GoalCompletionRecord,
  type MetricsFileWriter,
  type SkillStats,
} from "../metrics.ts";
import type { SkillName } from "../../types/agent.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

function createTestTaskRecord(
  overrides?: Partial<TaskExecutionRecord>,
): TaskExecutionRecord {
  return {
    taskId: "copywriting-20260220-abc123",
    skillName: "copywriting" as SkillName,
    status: "completed",
    durationMs: 5000,
    inputTokens: 1000,
    outputTokens: 500,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function createTestPipelineRecord(
  overrides?: Partial<PipelineRunRecord>,
): PipelineRunRecord {
  return {
    pipelineRunId: "run-001",
    pipelineId: "launch-campaign",
    status: "completed",
    stepCount: 3,
    totalDurationMs: 15000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function createTestGoalRecord(
  overrides?: Partial<GoalCompletionRecord>,
): GoalCompletionRecord {
  return {
    goalId: "goal-001",
    status: "completed",
    iterationCount: 1,
    totalDurationMs: 60000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function createMockWriter(): MetricsFileWriter & {
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

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  // ── recordTaskExecution() ───────────────────────────────────────────────

  describe("recordTaskExecution", () => {
    it("records a task execution", () => {
      collector.recordTaskExecution(createTestTaskRecord());
      const stats = collector.getStats();
      expect(stats.totalTaskExecutions).toBe(1);
    });

    it("updates per-skill stats", () => {
      collector.recordTaskExecution(createTestTaskRecord());
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats).not.toBeNull();
      expect(skillStats!.executionCount).toBe(1);
    });

    it("increments success count for completed tasks", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ status: "completed" }),
      );
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats!.successCount).toBe(1);
      expect(skillStats!.failureCount).toBe(0);
    });

    it("increments failure count for failed tasks", () => {
      collector.recordTaskExecution(createTestTaskRecord({ status: "failed" }));
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats!.successCount).toBe(0);
      expect(skillStats!.failureCount).toBe(1);
    });

    it("accumulates duration and tokens", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({
          durationMs: 3000,
          inputTokens: 100,
          outputTokens: 50,
        }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({
          durationMs: 7000,
          inputTokens: 200,
          outputTokens: 150,
        }),
      );
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats!.totalDurationMs).toBe(10000);
      expect(skillStats!.totalInputTokens).toBe(300);
      expect(skillStats!.totalOutputTokens).toBe(200);
    });

    it("clamps negative durationMs to 0", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ durationMs: -500 }),
      );
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats!.totalDurationMs).toBe(0);
    });

    it("clamps negative tokens to 0", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ inputTokens: -100, outputTokens: -50 }),
      );
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats!.totalInputTokens).toBe(0);
      expect(skillStats!.totalOutputTokens).toBe(0);
    });

    it("clamps NaN durationMs to 0", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ durationMs: NaN }),
      );
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats!.totalDurationMs).toBe(0);
    });

    it("clamps Infinity tokens to 0", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ inputTokens: Infinity }),
      );
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats!.totalInputTokens).toBe(0);
    });

    it("tracks multiple skills independently", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ skillName: "copywriting" as SkillName }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({ skillName: "seo-audit" as SkillName }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({ skillName: "copywriting" as SkillName }),
      );

      expect(
        collector.getSkillStats("copywriting" as SkillName)!.executionCount,
      ).toBe(2);
      expect(
        collector.getSkillStats("seo-audit" as SkillName)!.executionCount,
      ).toBe(1);
    });

    it("handles zero durationMs as valid", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ durationMs: 0 }),
      );
      const skillStats = collector.getSkillStats("copywriting" as SkillName);
      expect(skillStats!.totalDurationMs).toBe(0);
      expect(skillStats!.averageDurationMs).toBe(0);
    });
  });

  // ── recordPipelineRun() ─────────────────────────────────────────────────

  describe("recordPipelineRun", () => {
    it("records a pipeline run", () => {
      collector.recordPipelineRun(createTestPipelineRecord());
      const stats = collector.getStats();
      expect(stats.totalPipelineRuns).toBe(1);
      expect(stats.pipelineRuns.length).toBe(1);
    });

    it("records multiple pipeline runs", () => {
      collector.recordPipelineRun(createTestPipelineRecord({ pipelineRunId: "run-1" }));
      collector.recordPipelineRun(createTestPipelineRecord({ pipelineRunId: "run-2" }));
      expect(collector.getStats().totalPipelineRuns).toBe(2);
    });

    it("clamps negative stepCount", () => {
      collector.recordPipelineRun(createTestPipelineRecord({ stepCount: -1 }));
      expect(collector.getStats().pipelineRuns[0]!.stepCount).toBe(0);
    });

    it("clamps negative totalDurationMs", () => {
      collector.recordPipelineRun(createTestPipelineRecord({ totalDurationMs: -100 }));
      expect(collector.getStats().pipelineRuns[0]!.totalDurationMs).toBe(0);
    });
  });

  // ── recordGoalCompletion() ──────────────────────────────────────────────

  describe("recordGoalCompletion", () => {
    it("records a goal completion", () => {
      collector.recordGoalCompletion(createTestGoalRecord());
      const stats = collector.getStats();
      expect(stats.totalGoalCompletions).toBe(1);
      expect(stats.goalCompletions.length).toBe(1);
    });

    it("records multiple goal completions", () => {
      collector.recordGoalCompletion(createTestGoalRecord({ goalId: "goal-1" }));
      collector.recordGoalCompletion(createTestGoalRecord({ goalId: "goal-2" }));
      expect(collector.getStats().totalGoalCompletions).toBe(2);
    });

    it("clamps negative iterationCount", () => {
      collector.recordGoalCompletion(createTestGoalRecord({ iterationCount: -1 }));
      expect(collector.getStats().goalCompletions[0]!.iterationCount).toBe(0);
    });

    it("clamps negative totalDurationMs", () => {
      collector.recordGoalCompletion(createTestGoalRecord({ totalDurationMs: -100 }));
      expect(collector.getStats().goalCompletions[0]!.totalDurationMs).toBe(0);
    });
  });

  // ── getStats() ──────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("returns zeroed snapshot when empty", () => {
      const stats = collector.getStats();
      expect(stats.totalTaskExecutions).toBe(0);
      expect(stats.totalSuccesses).toBe(0);
      expect(stats.totalFailures).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.totalPipelineRuns).toBe(0);
      expect(stats.totalGoalCompletions).toBe(0);
      expect(stats.skillStats.length).toBe(0);
      expect(stats.pipelineRuns.length).toBe(0);
      expect(stats.goalCompletions.length).toBe(0);
    });

    it("computes correct success rate", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ status: "completed" }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({ status: "completed" }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({ status: "failed" }),
      );
      const stats = collector.getStats();
      expect(stats.successRate).toBeCloseTo(2 / 3);
    });

    it("success rate is 0 when no executions", () => {
      expect(collector.getStats().successRate).toBe(0);
    });

    it("computes correct per-skill stats", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({
          skillName: "copywriting" as SkillName,
          status: "completed",
          durationMs: 3000,
        }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({
          skillName: "copywriting" as SkillName,
          status: "failed",
          durationMs: 1000,
        }),
      );

      const stats = collector.getStats();
      const copywriting = stats.skillStats.find(
        (s) => s.skillName === "copywriting",
      );
      expect(copywriting).toBeDefined();
      expect(copywriting!.executionCount).toBe(2);
      expect(copywriting!.successCount).toBe(1);
      expect(copywriting!.failureCount).toBe(1);
    });

    it("includes averageDurationMs per skill", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ durationMs: 2000 }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({ durationMs: 4000 }),
      );

      const stats = collector.getStats();
      const skill = stats.skillStats[0]!;
      expect(skill.averageDurationMs).toBe(3000);
    });

    it("includes collectedSince timestamp", () => {
      const before = new Date().toISOString();
      const freshCollector = new MetricsCollector();
      const after = new Date().toISOString();
      const stats = freshCollector.getStats();
      expect(stats.collectedSince >= before).toBe(true);
      expect(stats.collectedSince <= after).toBe(true);
    });

    it("includes pipeline and goal records in snapshot", () => {
      collector.recordPipelineRun(createTestPipelineRecord());
      collector.recordGoalCompletion(createTestGoalRecord());
      const stats = collector.getStats();
      expect(stats.pipelineRuns.length).toBe(1);
      expect(stats.goalCompletions.length).toBe(1);
    });

    it("returns defensive copies of arrays", () => {
      collector.recordPipelineRun(createTestPipelineRecord());
      const stats1 = collector.getStats();
      const stats2 = collector.getStats();
      expect(stats1.pipelineRuns).not.toBe(stats2.pipelineRuns);
      expect(stats1.goalCompletions).not.toBe(stats2.goalCompletions);
    });
  });

  // ── getSkillStats() ─────────────────────────────────────────────────────

  describe("getSkillStats", () => {
    it("returns stats for a recorded skill", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ skillName: "copywriting" as SkillName }),
      );
      const stats = collector.getSkillStats("copywriting" as SkillName);
      expect(stats).not.toBeNull();
      expect(stats!.skillName).toBe("copywriting");
      expect(stats!.executionCount).toBe(1);
    });

    it("returns null for an unrecorded skill", () => {
      const stats = collector.getSkillStats("seo-audit" as SkillName);
      expect(stats).toBeNull();
    });

    it("computes averageDurationMs correctly", () => {
      collector.recordTaskExecution(
        createTestTaskRecord({ durationMs: 1000 }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({ durationMs: 3000 }),
      );
      collector.recordTaskExecution(
        createTestTaskRecord({ durationMs: 5000 }),
      );
      const stats = collector.getSkillStats("copywriting" as SkillName);
      expect(stats!.averageDurationMs).toBe(3000);
    });
  });

  // ── writeReport() ──────────────────────────────────────────────────────

  describe("writeReport", () => {
    it("writes a markdown report", async () => {
      const writer = createMockWriter();
      collector.recordTaskExecution(createTestTaskRecord());
      await collector.writeReport("/tmp/metrics", writer);

      expect(writer.writtenFiles.length).toBe(1);
      expect(writer.writtenFiles[0]!.path).toMatch(
        /^\/tmp\/metrics\/\d{4}-\d{2}-\d{2}-report\.md$/,
      );
      expect(writer.writtenFiles[0]!.content).toContain("# Metrics Report");
    });

    it("calls mkdir before writeFile", async () => {
      const callOrder: string[] = [];
      const writer: MetricsFileWriter = {
        async mkdir(path) {
          callOrder.push(`mkdir:${path}`);
        },
        async writeFile(path, _content) {
          callOrder.push(`write:${path}`);
        },
      };

      await collector.writeReport("/tmp/metrics", writer);
      expect(callOrder.length).toBe(2);
      expect(callOrder[0]).toBe("mkdir:/tmp/metrics");
      expect(callOrder[1]!).toMatch(/^write:/);
    });

    it("handles empty metrics gracefully", async () => {
      const writer = createMockWriter();
      await collector.writeReport("/tmp/metrics", writer);

      const content = writer.writtenFiles[0]!.content;
      expect(content).toContain("Total task executions: 0");
      expect(content).toContain("Success rate: 0.0%");
      expect(content).toContain("No data collected.");
    });

    it("includes per-skill breakdown table", async () => {
      const writer = createMockWriter();
      collector.recordTaskExecution(
        createTestTaskRecord({ skillName: "copywriting" as SkillName }),
      );
      await collector.writeReport("/tmp/metrics", writer);

      const content = writer.writtenFiles[0]!.content;
      expect(content).toContain("## Per-Skill Breakdown");
      expect(content).toContain("copywriting");
      expect(content).toContain("| Skill |");
    });

    it("includes pipeline runs section", async () => {
      const writer = createMockWriter();
      collector.recordPipelineRun(createTestPipelineRecord());
      await collector.writeReport("/tmp/metrics", writer);

      const content = writer.writtenFiles[0]!.content;
      expect(content).toContain("## Pipeline Runs");
      expect(content).toContain("launch-campaign");
    });

    it("includes goal completions section", async () => {
      const writer = createMockWriter();
      collector.recordGoalCompletion(createTestGoalRecord());
      await collector.writeReport("/tmp/metrics", writer);

      const content = writer.writtenFiles[0]!.content;
      expect(content).toContain("## Goal Completions");
      expect(content).toContain("goal-001");
    });

    it("propagates writer errors", async () => {
      const writer: MetricsFileWriter = {
        async mkdir() {
          throw new Error("Disk full");
        },
        async writeFile() {},
      };

      await expect(
        collector.writeReport("/tmp/metrics", writer),
      ).rejects.toThrow("Disk full");
    });
  });

  // ── reset() ─────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all records", () => {
      collector.recordTaskExecution(createTestTaskRecord());
      collector.recordPipelineRun(createTestPipelineRecord());
      collector.recordGoalCompletion(createTestGoalRecord());
      collector.reset();

      const stats = collector.getStats();
      expect(stats.totalTaskExecutions).toBe(0);
      expect(stats.totalPipelineRuns).toBe(0);
      expect(stats.totalGoalCompletions).toBe(0);
      expect(stats.skillStats.length).toBe(0);
    });

    it("resets startedAt to current time", () => {
      const oldStats = collector.getStats();
      const oldSince = oldStats.collectedSince;

      // Small delay to ensure different timestamp
      collector.reset();
      const newStats = collector.getStats();
      expect(newStats.collectedSince >= oldSince).toBe(true);
    });

    it("getStats returns zeroed snapshot after reset", () => {
      collector.recordTaskExecution(createTestTaskRecord());
      collector.recordTaskExecution(
        createTestTaskRecord({ status: "failed" }),
      );
      collector.reset();

      const stats = collector.getStats();
      expect(stats.totalTaskExecutions).toBe(0);
      expect(stats.totalSuccesses).toBe(0);
      expect(stats.totalFailures).toBe(0);
      expect(stats.successRate).toBe(0);
    });

    it("skill stats are cleared after reset", () => {
      collector.recordTaskExecution(createTestTaskRecord());
      collector.reset();
      expect(collector.getSkillStats("copywriting" as SkillName)).toBeNull();
    });
  });
});
