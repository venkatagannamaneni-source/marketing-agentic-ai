import type { Task } from "../types/task.ts";
import type { BudgetState } from "../director/types.ts";

// ── Budget Gate ─────────────────────────────────────────────────────────────
// Checks if a task is allowed to execute given the current budget state.
// Uses BudgetState.allowedPriorities from the Director's escalation engine.

export type BudgetDecision = "allow" | "defer" | "block";

export class BudgetGate {
  /**
   * Check if a single task is allowed given current budget.
   * - "allow": task can proceed
   * - "defer": task priority not currently allowed; re-check later
   * - "block": budget exhausted; nothing executes
   */
  check(task: Task, budget: BudgetState): BudgetDecision {
    if (budget.level === "exhausted") {
      return "block";
    }

    if (budget.allowedPriorities.includes(task.priority)) {
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
}
