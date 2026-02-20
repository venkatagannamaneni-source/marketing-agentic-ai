import type { SkillName, ModelTier } from "../types/agent.ts";
import type { Priority } from "../types/task.ts";
import type { BudgetState, BudgetLevel } from "../director/types.ts";

// ── Cost Entry ──────────────────────────────────────────────────────────────

export interface CostEntry {
  readonly timestamp: string;
  readonly taskId: string;
  readonly skillName: SkillName;
  readonly modelTier: ModelTier;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number; // dollars
}

// ── Cost Tracker Config ─────────────────────────────────────────────────────

export interface CostTrackerConfig {
  readonly budget: {
    readonly totalMonthly: number;
    readonly warningPercent: number;
    readonly throttlePercent: number;
    readonly criticalPercent: number;
  };
}

export const DEFAULT_COST_TRACKER_CONFIG: CostTrackerConfig = {
  budget: {
    totalMonthly: 1000,
    warningPercent: 80,
    throttlePercent: 90,
    criticalPercent: 95,
  },
};

// ── Summary Types ───────────────────────────────────────────────────────────

export interface SkillCostSummary {
  readonly skillName: SkillName;
  readonly totalCost: number;
  readonly entryCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

export interface ModelCostSummary {
  readonly modelTier: ModelTier;
  readonly totalCost: number;
  readonly entryCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

export interface DailyCostSummary {
  readonly date: string; // YYYY-MM-DD
  readonly totalCost: number;
  readonly entryCount: number;
}

// ── File Writer (DI for testability) ────────────────────────────────────────

export interface CostFileWriter {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function dollarsToMicro(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

function microToDollars(micro: number): number {
  return micro / 1_000_000;
}

function sanitizeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function extractDate(isoTimestamp: string): string {
  // Extract YYYY-MM-DD from ISO string
  return isoTimestamp.slice(0, 10);
}

function formatDollars(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

// ── CostTracker ─────────────────────────────────────────────────────────────

export class CostTracker {
  private readonly entries: CostEntry[] = [];
  private readonly microCosts: number[] = [];
  private readonly config: CostTrackerConfig;

  constructor(config?: Partial<CostTrackerConfig>) {
    this.config = {
      budget: {
        ...DEFAULT_COST_TRACKER_CONFIG.budget,
        ...config?.budget,
      },
    };
  }

  // ── Recording ───────────────────────────────────────────────────────────

  record(entry: CostEntry): void {
    const sanitizedCost = sanitizeNumber(entry.estimatedCost);
    const sanitizedInput = Math.round(sanitizeNumber(entry.inputTokens));
    const sanitizedOutput = Math.round(sanitizeNumber(entry.outputTokens));

    const sanitizedEntry: CostEntry = {
      timestamp: entry.timestamp,
      taskId: entry.taskId,
      skillName: entry.skillName,
      modelTier: entry.modelTier,
      inputTokens: sanitizedInput,
      outputTokens: sanitizedOutput,
      estimatedCost: sanitizedCost,
    };

    this.entries.push(sanitizedEntry);
    this.microCosts.push(dollarsToMicro(sanitizedCost));
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  getTotalSpent(): number {
    let totalMicro = 0;
    for (const micro of this.microCosts) {
      totalMicro += micro;
    }
    return microToDollars(totalMicro);
  }

  getSpentSince(since: Date): number {
    const sinceMs = since.getTime();
    if (!Number.isFinite(sinceMs)) {
      // Invalid date: treat as epoch, return all
      return this.getTotalSpent();
    }

    let totalMicro = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const entryMs = new Date(entry.timestamp).getTime();
      if (entryMs >= sinceMs) {
        totalMicro += this.microCosts[i]!;
      }
    }
    return microToDollars(totalMicro);
  }

  getBySkill(): readonly SkillCostSummary[] {
    if (this.entries.length === 0) return [];

    const map = new Map<
      string,
      { microCost: number; count: number; inputTokens: number; outputTokens: number }
    >();

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const existing = map.get(entry.skillName);
      if (existing) {
        existing.microCost += this.microCosts[i]!;
        existing.count += 1;
        existing.inputTokens += entry.inputTokens;
        existing.outputTokens += entry.outputTokens;
      } else {
        map.set(entry.skillName, {
          microCost: this.microCosts[i]!,
          count: 1,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
        });
      }
    }

    const results: SkillCostSummary[] = [];
    for (const [skillName, data] of map) {
      results.push({
        skillName: skillName as SkillName,
        totalCost: microToDollars(data.microCost),
        entryCount: data.count,
        totalInputTokens: data.inputTokens,
        totalOutputTokens: data.outputTokens,
      });
    }
    return results;
  }

  getByModel(): readonly ModelCostSummary[] {
    if (this.entries.length === 0) return [];

    const map = new Map<
      string,
      { microCost: number; count: number; inputTokens: number; outputTokens: number }
    >();

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const existing = map.get(entry.modelTier);
      if (existing) {
        existing.microCost += this.microCosts[i]!;
        existing.count += 1;
        existing.inputTokens += entry.inputTokens;
        existing.outputTokens += entry.outputTokens;
      } else {
        map.set(entry.modelTier, {
          microCost: this.microCosts[i]!,
          count: 1,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
        });
      }
    }

    const results: ModelCostSummary[] = [];
    for (const [modelTier, data] of map) {
      results.push({
        modelTier: modelTier as ModelTier,
        totalCost: microToDollars(data.microCost),
        entryCount: data.count,
        totalInputTokens: data.inputTokens,
        totalOutputTokens: data.outputTokens,
      });
    }
    return results;
  }

  getDailyBreakdown(): readonly DailyCostSummary[] {
    if (this.entries.length === 0) return [];

    const map = new Map<string, { microCost: number; count: number }>();

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const date = extractDate(entry.timestamp);
      const existing = map.get(date);
      if (existing) {
        existing.microCost += this.microCosts[i]!;
        existing.count += 1;
      } else {
        map.set(date, {
          microCost: this.microCosts[i]!,
          count: 1,
        });
      }
    }

    const results: DailyCostSummary[] = [];
    for (const [date, data] of map) {
      results.push({
        date,
        totalCost: microToDollars(data.microCost),
        entryCount: data.count,
      });
    }

    // Sort ascending by date
    results.sort((a, b) => a.date.localeCompare(b.date));
    return results;
  }

  get entryCount(): number {
    return this.entries.length;
  }

  getEntries(): readonly CostEntry[] {
    return [...this.entries];
  }

  // ── Budget Integration ──────────────────────────────────────────────────

  toBudgetState(): BudgetState {
    const spent = this.getTotalSpent();
    const totalBudget = this.config.budget.totalMonthly;
    // Zero budget with nonzero spending → treat as fully exhausted
    const percentUsed =
      totalBudget > 0 ? (spent / totalBudget) * 100 : spent > 0 ? 100 : 0;

    let level: BudgetLevel;
    let allowedPriorities: readonly Priority[];
    let modelOverride: ModelTier | null = null;

    if (percentUsed >= 100) {
      level = "exhausted";
      allowedPriorities = [];
    } else if (percentUsed >= this.config.budget.criticalPercent) {
      level = "critical";
      allowedPriorities = ["P0"];
      modelOverride = "haiku";
    } else if (percentUsed >= this.config.budget.throttlePercent) {
      level = "throttle";
      allowedPriorities = ["P0", "P1"];
    } else if (percentUsed >= this.config.budget.warningPercent) {
      level = "warning";
      allowedPriorities = ["P0", "P1", "P2"];
    } else {
      level = "normal";
      allowedPriorities = ["P0", "P1", "P2", "P3"];
    }

    return {
      totalBudget,
      spent,
      percentUsed,
      level,
      allowedPriorities,
      modelOverride,
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  async flush(dir: string, writer: CostFileWriter): Promise<void> {
    await writer.mkdir(dir);

    const today = new Date().toISOString().slice(0, 10);
    const totalSpent = this.getTotalSpent();
    const skillSummaries = this.getBySkill();
    const modelSummaries = this.getByModel();

    const lines: string[] = [];
    lines.push(`# Cost Report — ${today}`);
    lines.push("");
    lines.push("## Summary");
    lines.push(`- Total entries: ${this.entries.length}`);
    lines.push(`- Total cost: ${formatDollars(totalSpent)}`);

    if (this.entries.length > 0) {
      const dates = this.entries.map((e) => extractDate(e.timestamp));
      const minDate = dates.reduce((a, b) => (a < b ? a : b));
      const maxDate = dates.reduce((a, b) => (a > b ? a : b));
      lines.push(`- Period: ${minDate} to ${maxDate}`);
    }

    lines.push("");

    // By Skill
    lines.push("## By Skill");
    if (skillSummaries.length === 0) {
      lines.push("No data collected.");
    } else {
      lines.push("| Skill | Entries | Input Tokens | Output Tokens | Cost |");
      lines.push("|-------|---------|--------------|---------------|------|");
      for (const s of skillSummaries) {
        lines.push(
          `| ${s.skillName} | ${s.entryCount} | ${s.totalInputTokens} | ${s.totalOutputTokens} | ${formatDollars(s.totalCost)} |`,
        );
      }
    }

    lines.push("");

    // By Model
    lines.push("## By Model");
    if (modelSummaries.length === 0) {
      lines.push("No data collected.");
    } else {
      lines.push("| Model | Entries | Input Tokens | Output Tokens | Cost |");
      lines.push("|-------|---------|--------------|---------------|------|");
      for (const m of modelSummaries) {
        lines.push(
          `| ${m.modelTier} | ${m.entryCount} | ${m.totalInputTokens} | ${m.totalOutputTokens} | ${formatDollars(m.totalCost)} |`,
        );
      }
    }

    lines.push("");

    // By Day
    const dailySummaries = this.getDailyBreakdown();
    lines.push("## By Day");
    if (dailySummaries.length === 0) {
      lines.push("No data collected.");
    } else {
      lines.push("| Date | Entries | Cost |");
      lines.push("|------|---------|------|");
      for (const d of dailySummaries) {
        lines.push(`| ${d.date} | ${d.entryCount} | ${formatDollars(d.totalCost)} |`);
      }
    }

    lines.push("");

    const filePath = `${dir}/${today}-budget.md`;
    await writer.writeFile(filePath, lines.join("\n"));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  reset(): void {
    this.entries.length = 0;
    this.microCosts.length = 0;
  }
}
