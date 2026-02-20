import type { SkillName } from "../types/agent.ts";

// ── Record Types ────────────────────────────────────────────────────────────

export interface TaskExecutionRecord {
  readonly taskId: string;
  readonly skillName: SkillName;
  readonly status: "completed" | "failed";
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly timestamp: string;
}

export interface PipelineRunRecord {
  readonly pipelineRunId: string;
  readonly pipelineId: string;
  readonly status: "completed" | "failed" | "paused" | "cancelled";
  readonly stepCount: number;
  readonly totalDurationMs: number;
  readonly timestamp: string;
}

export interface GoalCompletionRecord {
  readonly goalId: string;
  readonly status: "completed" | "failed" | "iterating";
  readonly iterationCount: number;
  readonly totalDurationMs: number;
  readonly timestamp: string;
}

// ── Per-Skill Stats ─────────────────────────────────────────────────────────

export interface SkillStats {
  readonly skillName: SkillName;
  readonly executionCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly totalDurationMs: number;
  readonly averageDurationMs: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

// ── Aggregate Metrics Snapshot ──────────────────────────────────────────────

export interface MetricsSnapshot {
  readonly totalTaskExecutions: number;
  readonly totalSuccesses: number;
  readonly totalFailures: number;
  readonly successRate: number; // 0.0 to 1.0
  readonly totalPipelineRuns: number;
  readonly totalGoalCompletions: number;
  readonly skillStats: readonly SkillStats[];
  readonly pipelineRuns: readonly PipelineRunRecord[];
  readonly goalCompletions: readonly GoalCompletionRecord[];
  readonly collectedSince: string;
}

// ── File Writer (DI for testability) ────────────────────────────────────────

export interface MetricsFileWriter {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

// ── Internal Mutable Skill Stats ────────────────────────────────────────────

interface MutableSkillStats {
  executionCount: number;
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ── MetricsCollector ────────────────────────────────────────────────────────

export class MetricsCollector {
  private readonly taskRecords: TaskExecutionRecord[] = [];
  private readonly pipelineRecords: PipelineRunRecord[] = [];
  private readonly goalRecords: GoalCompletionRecord[] = [];
  private readonly skillMap = new Map<string, MutableSkillStats>();
  private startedAt: string;

  constructor() {
    this.startedAt = new Date().toISOString();
  }

  // ── Recording ───────────────────────────────────────────────────────────

  recordTaskExecution(record: TaskExecutionRecord): void {
    const durationMs = clampNonNegative(record.durationMs);
    const inputTokens = Math.round(clampNonNegative(record.inputTokens));
    const outputTokens = Math.round(clampNonNegative(record.outputTokens));

    const sanitized: TaskExecutionRecord = {
      taskId: record.taskId,
      skillName: record.skillName,
      status: record.status,
      durationMs,
      inputTokens,
      outputTokens,
      timestamp: record.timestamp,
    };

    this.taskRecords.push(sanitized);

    // Update per-skill stats
    let stats = this.skillMap.get(record.skillName);
    if (!stats) {
      stats = {
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        totalDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };
      this.skillMap.set(record.skillName, stats);
    }

    stats.executionCount += 1;
    if (record.status === "completed") {
      stats.successCount += 1;
    } else {
      stats.failureCount += 1;
    }
    stats.totalDurationMs += durationMs;
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
  }

  recordPipelineRun(record: PipelineRunRecord): void {
    const sanitized: PipelineRunRecord = {
      pipelineRunId: record.pipelineRunId,
      pipelineId: record.pipelineId,
      status: record.status,
      stepCount: Math.round(clampNonNegative(record.stepCount)),
      totalDurationMs: clampNonNegative(record.totalDurationMs),
      timestamp: record.timestamp,
    };

    this.pipelineRecords.push(sanitized);
  }

  recordGoalCompletion(record: GoalCompletionRecord): void {
    const sanitized: GoalCompletionRecord = {
      goalId: record.goalId,
      status: record.status,
      iterationCount: Math.round(clampNonNegative(record.iterationCount)),
      totalDurationMs: clampNonNegative(record.totalDurationMs),
      timestamp: record.timestamp,
    };

    this.goalRecords.push(sanitized);
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  getStats(): MetricsSnapshot {
    let totalExecutions = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;

    const skillStats: SkillStats[] = [];

    for (const [skillName, stats] of this.skillMap) {
      totalExecutions += stats.executionCount;
      totalSuccesses += stats.successCount;
      totalFailures += stats.failureCount;

      skillStats.push({
        skillName: skillName as SkillName,
        executionCount: stats.executionCount,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        totalDurationMs: stats.totalDurationMs,
        averageDurationMs:
          stats.executionCount > 0
            ? Math.round(stats.totalDurationMs / stats.executionCount)
            : 0,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
      });
    }

    return {
      totalTaskExecutions: totalExecutions,
      totalSuccesses,
      totalFailures,
      successRate: totalExecutions > 0 ? totalSuccesses / totalExecutions : 0,
      totalPipelineRuns: this.pipelineRecords.length,
      totalGoalCompletions: this.goalRecords.length,
      skillStats,
      pipelineRuns: [...this.pipelineRecords],
      goalCompletions: [...this.goalRecords],
      collectedSince: this.startedAt,
    };
  }

  getSkillStats(skill: SkillName): SkillStats | null {
    const stats = this.skillMap.get(skill);
    if (!stats) return null;

    return {
      skillName: skill,
      executionCount: stats.executionCount,
      successCount: stats.successCount,
      failureCount: stats.failureCount,
      totalDurationMs: stats.totalDurationMs,
      averageDurationMs:
        stats.executionCount > 0
          ? Math.round(stats.totalDurationMs / stats.executionCount)
          : 0,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  async writeReport(dir: string, writer: MetricsFileWriter): Promise<void> {
    await writer.mkdir(dir);

    const today = new Date().toISOString().slice(0, 10);
    const snapshot = this.getStats();

    const lines: string[] = [];
    lines.push(`# Metrics Report — ${today}`);
    lines.push("");
    lines.push("## Summary");
    lines.push(`- Total task executions: ${snapshot.totalTaskExecutions}`);
    lines.push(
      `- Successes: ${snapshot.totalSuccesses} | Failures: ${snapshot.totalFailures}`,
    );
    lines.push(`- Success rate: ${formatRate(snapshot.successRate)}`);
    lines.push(`- Pipeline runs: ${snapshot.totalPipelineRuns}`);
    lines.push(`- Goal completions: ${snapshot.totalGoalCompletions}`);
    lines.push(`- Collecting since: ${snapshot.collectedSince}`);
    lines.push("");

    // Per-Skill Breakdown
    lines.push("## Per-Skill Breakdown");
    if (snapshot.skillStats.length === 0) {
      lines.push("No data collected.");
    } else {
      lines.push(
        "| Skill | Executions | Success | Fail | Avg Duration | Input Tokens | Output Tokens |",
      );
      lines.push(
        "|-------|-----------|---------|------|-------------|--------------|---------------|",
      );
      for (const s of snapshot.skillStats) {
        lines.push(
          `| ${s.skillName} | ${s.executionCount} | ${s.successCount} | ${s.failureCount} | ${formatMs(s.averageDurationMs)} | ${s.totalInputTokens} | ${s.totalOutputTokens} |`,
        );
      }
    }

    lines.push("");

    // Pipeline Runs
    lines.push("## Pipeline Runs");
    if (snapshot.pipelineRuns.length === 0) {
      lines.push("No pipeline runs recorded.");
    } else {
      lines.push("| Pipeline | Run ID | Status | Steps | Duration |");
      lines.push("|----------|--------|--------|-------|----------|");
      for (const p of snapshot.pipelineRuns) {
        lines.push(
          `| ${p.pipelineId} | ${p.pipelineRunId} | ${p.status} | ${p.stepCount} | ${formatMs(p.totalDurationMs)} |`,
        );
      }
    }

    lines.push("");

    // Goal Completions
    lines.push("## Goal Completions");
    if (snapshot.goalCompletions.length === 0) {
      lines.push("No goal completions recorded.");
    } else {
      lines.push("| Goal ID | Status | Iterations | Duration |");
      lines.push("|---------|--------|-----------|----------|");
      for (const g of snapshot.goalCompletions) {
        lines.push(
          `| ${g.goalId} | ${g.status} | ${g.iterationCount} | ${formatMs(g.totalDurationMs)} |`,
        );
      }
    }

    lines.push("");

    const filePath = `${dir}/${today}-report.md`;
    await writer.writeFile(filePath, lines.join("\n"));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  reset(): void {
    this.taskRecords.length = 0;
    this.pipelineRecords.length = 0;
    this.goalRecords.length = 0;
    this.skillMap.clear();
    this.startedAt = new Date().toISOString();
  }
}
