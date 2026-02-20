import type { Task } from "../types/task.ts";
import type { BudgetState } from "../director/types.ts";
import type { SystemEvent } from "../types/events.ts";

// ── Event Callback Type ────────────────────────────────────────────────────
// Defined locally to avoid circular imports with src/events/event-bus.ts.

type OnEventCallback = (event: SystemEvent) => void;

// ── Budget Gate ─────────────────────────────────────────────────────────────
// Checks if a task is allowed to execute given the current budget state.
// Uses BudgetState.allowedPriorities from the Director's escalation engine.

export type BudgetDecision = "allow" | "defer" | "block";

export class BudgetGate {
  private readonly onEvent?: OnEventCallback;

  constructor(onEvent?: OnEventCallback) {
    this.onEvent = onEvent;
  }

  /**
   * Check if a single task is allowed given current budget.
   * - "allow": task can proceed
   * - "defer": task priority not currently allowed; re-check later
   * - "block": budget exhausted; nothing executes
   */
  check(task: Task, budget: BudgetState): BudgetDecision {
    if (budget.level === "exhausted") {
      this.emitBudgetEvent("budget_critical", budget);
      return "block";
    }

    if (budget.allowedPriorities.includes(task.priority)) {
      if (budget.level === "warning" || budget.level === "critical") {
        this.emitBudgetEvent("budget_warning", budget);
      }
      return "allow";
    }

    return "defer";
  }

  /**
   * Filter a batch of tasks into allowed and deferred sets.
   */
  filterBatch(
    tasks: readonly Task[],
    budget: BudgetState,
  ): { readonly allowed: Task[]; readonly deferred: Task[] } {
    const allowed: Task[] = [];
    const deferred: Task[] = [];

    for (const task of tasks) {
      const decision = this.check(task, budget);
      if (decision === "allow") {
        allowed.push(task);
      } else {
        deferred.push(task);
      }
    }

    return { allowed, deferred };
  }

  /**
   * Emit a budget-related system event via the optional callback.
   */
  private emitBudgetEvent(
    type: "budget_warning" | "budget_critical",
    budget: BudgetState,
  ): void {
    this.onEvent?.({
      id: `budget-${type}-${Date.now()}`,
      type,
      timestamp: new Date().toISOString(),
      source: "budget-gate",
      data: {
        level: budget.level,
        percentUsed: budget.percentUsed,
        spent: budget.spent,
        totalBudget: budget.totalBudget,
      },
    });
  }
}
