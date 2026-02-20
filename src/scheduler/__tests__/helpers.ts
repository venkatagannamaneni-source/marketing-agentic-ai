import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ScheduleEntry, ScheduleState } from "../../types/events.ts";
import type { BudgetState, BudgetLevel } from "../../director/types.ts";
import type { SchedulerDeps } from "../scheduler.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import { BufferLogger } from "../../observability/logger.ts";
import { MarketingDirector } from "../../director/director.ts";
import type { ClaudeClient, ClaudeMessageParams, ClaudeMessageResult } from "../../agents/claude-client.ts";
import type { Priority } from "../../types/task.ts";

// ── Mock Director Client ────────────────────────────────────────────────────

function createMockClaudeClient(): ClaudeClient & { calls: ClaudeMessageParams[] } {
  const calls: ClaudeMessageParams[] = [];
  return {
    calls,
    async createMessage(params: ClaudeMessageParams): Promise<ClaudeMessageResult> {
      calls.push(params);
      return {
        content: "[]",
        model: "claude-sonnet-4-5-20250929",
        inputTokens: 500,
        outputTokens: 300,
        stopReason: "end_turn",
        durationMs: 100,
      };
    },
  };
}

// ── Test Context ────────────────────────────────────────────────────────────

export interface SchedulerTestContext {
  deps: SchedulerDeps;
  logger: BufferLogger;
  workspace: FileSystemWorkspaceManager;
  director: MarketingDirector;
  tempDir: string;
  clock: { now: Date; fn: () => Date };
  budget: { state: BudgetState; fn: () => BudgetState };
  cleanup: () => Promise<void>;
}

export async function createSchedulerTestContext(
  overrides?: Partial<{
    clockDate: Date;
    budgetLevel: BudgetLevel;
  }>,
): Promise<SchedulerTestContext> {
  const tempDir = await mkdtemp(join(tmpdir(), "scheduler-test-"));
  const workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
  await workspace.init();

  // Write required product context
  await workspace.writeFile(
    "context/product-marketing-context.md",
    "# Product Context\nTest product for scheduler tests.\n",
  );

  const logger = new BufferLogger();
  const client = createMockClaudeClient();
  const director = new MarketingDirector(workspace, undefined, client);

  const clockDate = overrides?.clockDate ?? new Date(2026, 1, 16, 0, 0); // Monday Feb 16 2026
  const clock = {
    now: clockDate,
    fn: () => clock.now,
  };

  const budget = {
    state: createTestBudgetState(overrides?.budgetLevel ?? "normal"),
    fn: () => budget.state,
  };

  const deps: SchedulerDeps = {
    director,
    workspace,
    logger,
    budgetProvider: budget.fn,
    clock: clock.fn,
    config: {
      tickIntervalMs: 60_000,
      catchUpOnStart: false, // Off by default in tests
    },
  };

  return {
    deps,
    logger,
    workspace,
    director,
    tempDir,
    clock,
    budget,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export function createTestScheduleEntry(
  overrides?: Partial<ScheduleEntry>,
): ScheduleEntry {
  return {
    id: "test-schedule",
    name: "Test Schedule",
    cron: "0 6 * * *",
    pipelineId: "Content Production",
    enabled: true,
    description: "Test schedule for unit tests",
    priority: "P2" as Priority,
    goalCategory: "content",
    ...overrides,
  };
}

export function createTestBudgetState(
  level: BudgetLevel = "normal",
): BudgetState {
  const configs: Record<BudgetLevel, BudgetState> = {
    normal: {
      totalBudget: 1000,
      spent: 100,
      percentUsed: 10,
      level: "normal",
      allowedPriorities: ["P0", "P1", "P2", "P3"],
      modelOverride: null,
    },
    warning: {
      totalBudget: 1000,
      spent: 800,
      percentUsed: 80,
      level: "warning",
      allowedPriorities: ["P0", "P1", "P2"],
      modelOverride: null,
    },
    throttle: {
      totalBudget: 1000,
      spent: 900,
      percentUsed: 90,
      level: "throttle",
      allowedPriorities: ["P0", "P1"],
      modelOverride: null,
    },
    critical: {
      totalBudget: 1000,
      spent: 950,
      percentUsed: 95,
      level: "critical",
      allowedPriorities: ["P0"],
      modelOverride: "haiku",
    },
    exhausted: {
      totalBudget: 1000,
      spent: 1000,
      percentUsed: 100,
      level: "exhausted",
      allowedPriorities: [],
      modelOverride: "haiku",
    },
  };
  return configs[level];
}

export function createTestScheduleState(
  overrides?: Partial<ScheduleState>,
): ScheduleState {
  return {
    scheduleId: "test-schedule",
    lastFiredAt: null,
    lastSkipReason: null,
    fireCount: 0,
    ...overrides,
  };
}
