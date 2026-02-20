import type { Logger } from "../observability/logger.ts";
import type { MarketingDirector } from "../director/director.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { ScheduleEntry, ScheduleState } from "../types/events.ts";
import type { BudgetState } from "../director/types.ts";
import type { GoalCategory } from "../types/goal.ts";
import type { Priority } from "../types/task.ts";
import { parseCron, cronMatches, previousCronMatch, CronParseError } from "./cron.ts";
import type { CronFields } from "./cron.ts";

// ── Config ──────────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  readonly tickIntervalMs: number;
  readonly catchUpOnStart: boolean;
  readonly catchUpLookbackDays: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  tickIntervalMs: 60_000,
  catchUpOnStart: true,
  catchUpLookbackDays: 7,
};

// ── Dependencies ────────────────────────────────────────────────────────────

export interface SchedulerDeps {
  readonly director: MarketingDirector;
  readonly workspace: WorkspaceManager;
  readonly logger: Logger;
  readonly budgetProvider: () => BudgetState;
  readonly config?: Partial<SchedulerConfig>;
  readonly clock?: () => Date;
}

// ── Tick Result ─────────────────────────────────────────────────────────────

export interface TickResult {
  readonly timestamp: string;
  readonly fired: readonly string[];
  readonly skipped: readonly SkipEntry[];
}

export interface SkipEntry {
  readonly id: string;
  readonly reason: string;
}

// ── Internal Types ──────────────────────────────────────────────────────────

interface ParsedSchedule {
  readonly entry: ScheduleEntry;
  readonly cron: CronFields;
  enabled: boolean;
}

interface RunningPipeline {
  readonly startedAt: string;
  readonly pipelineId: string;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

export class Scheduler {
  private readonly config: SchedulerConfig;
  private readonly clock: () => Date;

  private readonly director: MarketingDirector;
  private readonly workspace: WorkspaceManager;
  private readonly logger: Logger;
  private readonly budgetProvider: () => BudgetState;

  private readonly schedules = new Map<string, ParsedSchedule>();
  private readonly states = new Map<string, ScheduleState>();
  private readonly runningPipelines = new Map<string, RunningPipeline>();
  private readonly firedThisMinute = new Set<string>();
  private lastMinuteKey = "";

  private running = false;
  private tickInProgress = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private alignTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SchedulerDeps) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...deps.config };
    this.clock = deps.clock ?? (() => new Date());
    this.director = deps.director;
    this.workspace = deps.workspace;
    this.logger = deps.logger.child({ module: "scheduler" });
    this.budgetProvider = deps.budgetProvider;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Load schedules, restore persisted state, run catch-up, and start the tick loop.
   */
  async start(schedules?: readonly ScheduleEntry[]): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load schedules
    if (schedules) {
      for (const entry of schedules) {
        this.addScheduleInternal(entry);
      }
    }

    // Restore persisted state
    await this.restoreStates();

    // Catch-up missed firings
    if (this.config.catchUpOnStart) {
      await this.catchUpMissed();
    }

    // Start tick loop — align to next minute boundary
    this.startTickLoop();

    this.logger.info("scheduler_started", {
      scheduleCount: this.schedules.size,
      catchUp: this.config.catchUpOnStart,
    });
  }

  /**
   * Stop the tick loop and wait for any in-flight tick to finish.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.alignTimer) {
      clearTimeout(this.alignTimer);
      this.alignTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    // Wait for in-flight tick
    let waitCount = 0;
    while (this.tickInProgress && waitCount < 100) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      waitCount++;
    }

    this.logger.info("scheduler_stopped");
  }

  // ── Schedule Management ─────────────────────────────────────────────────

  addSchedule(entry: ScheduleEntry): void {
    this.addScheduleInternal(entry);
    this.logger.info("schedule_added", { scheduleId: entry.id, cron: entry.cron });
  }

  removeSchedule(id: string): void {
    const removed = this.schedules.delete(id);
    if (removed) {
      this.states.delete(id);
      this.runningPipelines.delete(id);
      this.logger.info("schedule_removed", { scheduleId: id });
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    const schedule = this.schedules.get(id);
    if (schedule) {
      schedule.enabled = enabled;
      this.logger.info("schedule_enabled_changed", { scheduleId: id, enabled });
    }
  }

  /**
   * Mark a pipeline run as completed, clearing the overlap tracking.
   */
  markCompleted(scheduleId: string): void {
    const removed = this.runningPipelines.delete(scheduleId);
    if (removed) {
      this.logger.debug("schedule_pipeline_completed", { scheduleId });
    }
  }

  // ── Introspection ───────────────────────────────────────────────────────

  getScheduleStates(): ReadonlyMap<string, ScheduleState> {
    return this.states;
  }

  getActiveSchedules(): readonly ScheduleEntry[] {
    return [...this.schedules.values()]
      .filter((s) => s.enabled)
      .map((s) => s.entry);
  }

  getAllSchedules(): readonly ScheduleEntry[] {
    return [...this.schedules.values()].map((s) => s.entry);
  }

  getNextFiring(id: string): Date | null {
    const schedule = this.schedules.get(id);
    if (!schedule || !schedule.enabled) return null;

    const now = this.clock();
    // Look forward up to 366 days
    const limit = new Date(now);
    limit.setDate(limit.getDate() + 366);

    // Iterate forward minute by minute (optimized: skip to next matching day)
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    while (candidate <= limit) {
      if (cronMatches(schedule.cron, candidate)) {
        return candidate;
      }

      // Smart advance: if day doesn't match, skip to next day
      const month = candidate.getMonth() + 1;
      const dayOfMonth = candidate.getDate();
      const dayOfWeek = candidate.getDay();

      if (
        !schedule.cron.month.includes(month) ||
        !schedule.cron.dayOfMonth.includes(dayOfMonth) ||
        !schedule.cron.dayOfWeek.includes(dayOfWeek)
      ) {
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(0, 0, 0, 0);
      } else if (!schedule.cron.hour.includes(candidate.getHours())) {
        candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      } else {
        candidate.setMinutes(candidate.getMinutes() + 1);
      }
    }

    return null;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Tick (public for testing) ───────────────────────────────────────────

  /**
   * Execute a single tick: evaluate all schedules against the current time.
   * Returns which schedules fired and which were skipped.
   */
  async tick(): Promise<TickResult> {
    const now = this.clock();
    const minuteKey = toMinuteKey(now);

    // Reset dedup set if we moved to a new minute
    if (minuteKey !== this.lastMinuteKey) {
      this.firedThisMinute.clear();
      this.lastMinuteKey = minuteKey;
    }

    const fired: string[] = [];
    const skipped: SkipEntry[] = [];

    // Snapshot schedule IDs to iterate (safe against concurrent modification)
    const scheduleIds = [...this.schedules.keys()];

    for (const id of scheduleIds) {
      const schedule = this.schedules.get(id);
      if (!schedule) continue;

      // 1. Enabled?
      if (!schedule.enabled) {
        skipped.push({ id, reason: "disabled" });
        continue;
      }

      // 2. Cron matches?
      if (!cronMatches(schedule.cron, now)) {
        continue; // Not due — not logged (too noisy)
      }

      // 3. Already fired this minute?
      if (this.firedThisMinute.has(id)) {
        skipped.push({ id, reason: "already_fired_this_minute" });
        this.logger.debug("schedule_dedup_skipped", { scheduleId: id });
        continue;
      }

      // 4. Pipeline already running?
      if (this.runningPipelines.has(id)) {
        skipped.push({ id, reason: "pipeline_still_running" });
        this.logger.info("schedule_overlap_skipped", {
          scheduleId: id,
          ...this.runningPipelines.get(id),
        });
        continue;
      }

      // 5. Budget allows this priority?
      const budget = this.budgetProvider();
      const priority = schedule.entry.priority ?? "P2";
      if (
        !(budget.allowedPriorities as readonly string[]).includes(priority)
      ) {
        const reason = `budget_${budget.level}`;
        skipped.push({ id, reason });
        this.logger.info("schedule_budget_skipped", {
          scheduleId: id,
          budgetLevel: budget.level,
          priority,
        });

        // Update state with skip reason
        this.updateState(id, { lastSkipReason: reason });
        continue;
      }

      // 6. Fire
      try {
        await this.fireSchedule(schedule, now);
        fired.push(id);
        this.firedThisMinute.add(id);
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : String(err);
        skipped.push({ id, reason: `fire_error: ${errorMsg}` });
        this.logger.error("schedule_fire_failed", {
          scheduleId: id,
          error: errorMsg,
        });

        this.updateState(id, { lastSkipReason: `fire_error: ${errorMsg}` });
      }
    }

    return { timestamp: now.toISOString(), fired, skipped };
  }

  // ── Internal: Fire ────────────────────────────────────────────────────

  private async fireSchedule(
    schedule: ParsedSchedule,
    now: Date,
  ): Promise<void> {
    const { entry } = schedule;
    const pipelineId = entry.pipelineId;
    const priority = entry.priority as Priority | undefined;

    if (pipelineId.startsWith("goal:")) {
      // Goal-based schedule
      const goalType = pipelineId.slice(5);
      const category: GoalCategory = entry.goalCategory ?? "content";
      const description = this.getGoalDescription(goalType, now);

      const goal = await this.director.createGoal(
        description,
        category,
        priority,
      );
      const plan = this.director.decomposeGoal(goal);
      await this.director.planGoalTasks(plan, goal);

      this.runningPipelines.set(entry.id, {
        startedAt: now.toISOString(),
        pipelineId: goal.id,
      });

      this.logger.info("schedule_fired_goal", {
        scheduleId: entry.id,
        goalId: goal.id,
        goalType,
      });
    } else {
      // Template-based schedule
      const description = this.getPipelineDescription(pipelineId, now);
      const result = await this.director.startPipeline(
        pipelineId,
        description,
        priority,
      );

      this.runningPipelines.set(entry.id, {
        startedAt: now.toISOString(),
        pipelineId: result.definition.id,
      });

      this.logger.info("schedule_fired_pipeline", {
        scheduleId: entry.id,
        pipelineId: result.definition.id,
        taskCount: result.tasks.length,
      });
    }

    // Update persisted state
    const prevState = this.states.get(entry.id);
    const fireCount = (prevState?.fireCount ?? 0) + 1;
    const newState: ScheduleState = {
      scheduleId: entry.id,
      lastFiredAt: now.toISOString(),
      lastSkipReason: null,
      fireCount,
    };
    this.states.set(entry.id, newState);

    try {
      await this.workspace.writeScheduleState(entry.id, newState);
    } catch (err) {
      // Non-fatal — state persistence is best-effort
      this.logger.warn("schedule_state_persist_failed", {
        scheduleId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Internal: Catch-Up ────────────────────────────────────────────────

  private async catchUpMissed(): Promise<void> {
    const now = this.clock();

    // Collect schedules that need catch-up, sorted by priority (P0 first)
    const catchUpList: Array<{ schedule: ParsedSchedule; missedAt: Date }> =
      [];

    for (const [id, schedule] of this.schedules) {
      if (!schedule.enabled) continue;

      const state = this.states.get(id);
      const lastFired = state?.lastFiredAt
        ? new Date(state.lastFiredAt)
        : null;

      // Find the most recent cron match before now
      const previousMatch = previousCronMatch(
        schedule.cron,
        now,
        this.config.catchUpLookbackDays,
      );

      if (!previousMatch) continue;

      // If never fired, or last fired before the most recent match
      if (!lastFired || lastFired < previousMatch) {
        catchUpList.push({ schedule, missedAt: previousMatch });
      }
    }

    // Sort by priority (P0 → P3)
    const priorityOrder: Record<string, number> = {
      P0: 0,
      P1: 1,
      P2: 2,
      P3: 3,
    };
    catchUpList.sort((a, b) => {
      const pa = priorityOrder[a.schedule.entry.priority ?? "P2"] ?? 2;
      const pb = priorityOrder[b.schedule.entry.priority ?? "P2"] ?? 2;
      return pa - pb;
    });

    // Fire each catch-up (at most once per schedule)
    for (const { schedule, missedAt } of catchUpList) {
      const budget = this.budgetProvider();
      const priority = schedule.entry.priority ?? "P2";

      if (
        !(budget.allowedPriorities as readonly string[]).includes(priority)
      ) {
        this.logger.info("schedule_catchup_budget_skipped", {
          scheduleId: schedule.entry.id,
          budgetLevel: budget.level,
          priority,
          missedAt: missedAt.toISOString(),
        });
        continue;
      }

      try {
        await this.fireSchedule(schedule, missedAt);
        this.logger.info("schedule_catchup_fired", {
          scheduleId: schedule.entry.id,
          missedAt: missedAt.toISOString(),
        });
      } catch (err) {
        this.logger.error("schedule_catchup_fire_failed", {
          scheduleId: schedule.entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Internal: State ───────────────────────────────────────────────────

  private async restoreStates(): Promise<void> {
    try {
      const persisted = await this.workspace.listScheduleStates();
      for (const state of persisted) {
        this.states.set(state.scheduleId, state);
      }
    } catch (err) {
      this.logger.warn("schedule_state_restore_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private updateState(
    scheduleId: string,
    updates: Partial<ScheduleState>,
  ): void {
    const existing = this.states.get(scheduleId) ?? {
      scheduleId,
      lastFiredAt: null,
      lastSkipReason: null,
      fireCount: 0,
    };
    this.states.set(scheduleId, { ...existing, ...updates });
  }

  // ── Internal: Timer ───────────────────────────────────────────────────

  private startTickLoop(): void {
    const now = Date.now();
    const msUntilNextMinute =
      this.config.tickIntervalMs - (now % this.config.tickIntervalMs);

    // First tick aligned to minute boundary
    this.alignTimer = setTimeout(() => {
      this.alignTimer = null;
      this.guardedTick();

      // Then regular interval
      this.tickTimer = setInterval(
        () => this.guardedTick(),
        this.config.tickIntervalMs,
      );
    }, msUntilNextMinute);
  }

  private guardedTick(): void {
    if (!this.running) return;
    if (this.tickInProgress) {
      this.logger.warn("tick_overlap_skipped", {
        reason: "previous tick still running",
      });
      return;
    }

    this.tickInProgress = true;
    this.tick()
      .catch((err) => {
        this.logger.error("tick_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.tickInProgress = false;
      });
  }

  // ── Internal: Helpers ─────────────────────────────────────────────────

  private addScheduleInternal(entry: ScheduleEntry): void {
    try {
      const cron = parseCron(entry.cron);
      this.schedules.set(entry.id, {
        entry,
        cron,
        enabled: entry.enabled,
      });
    } catch (err) {
      if (err instanceof CronParseError) {
        this.logger.error("schedule_invalid_cron", {
          scheduleId: entry.id,
          cron: entry.cron,
          error: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  private getGoalDescription(goalType: string, now: Date): string {
    const dateStr = now.toISOString().slice(0, 10);
    const descriptions: Record<string, string> = {
      "social-content": `Generate social media content for ${dateStr}`,
      "director-review": `Review and assess previous day outputs for ${dateStr}`,
      "performance-review": `Monthly performance review and strategy assessment for ${dateStr}`,
    };
    return descriptions[goalType] ?? `Scheduled ${goalType} for ${dateStr}`;
  }

  private getPipelineDescription(templateName: string, now: Date): string {
    const dateStr = now.toISOString().slice(0, 10);
    return `Scheduled ${templateName} pipeline run for ${dateStr}`;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toMinuteKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}
