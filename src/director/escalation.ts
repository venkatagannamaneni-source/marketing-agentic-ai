import type { Task, Priority } from "../types/task.ts";
import type { ModelTier } from "../types/agent.ts";
import type {
  BudgetState,
  BudgetLevel,
  Escalation,
  DirectorConfig,
} from "./types.ts";

// ── Escalation Engine ────────────────────────────────────────────────────────

export class EscalationEngine {
  constructor(private readonly config: DirectorConfig) {}

  /**
   * Compute budget state from the current spent amount.
   * Determines the budget level, allowed priorities, and model overrides.
   */
  computeBudgetState(spent: number): BudgetState {
    const totalBudget = this.config.budget.totalMonthly;
    const percentUsed = totalBudget > 0 ? (spent / totalBudget) * 100 : 0;

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

  /**
   * Check if a task should execute given the current budget state.
   */
  shouldExecuteTask(task: Task, budgetState: BudgetState): boolean {
    return (budgetState.allowedPriorities as readonly string[]).includes(
      task.priority,
    );
  }

  /**
   * Check if a budget escalation is needed.
   * Returns null for normal budget levels.
   */
  checkBudgetEscalation(budgetState: BudgetState): Escalation | null {
    if (budgetState.level === "normal") return null;

    const severity: "warning" | "critical" =
      budgetState.level === "critical" || budgetState.level === "exhausted"
        ? "critical"
        : "warning";

    return {
      reason: "budget_threshold",
      severity,
      message:
        `Budget at ${budgetState.percentUsed.toFixed(1)}% (${budgetState.level}). ` +
        `Allowed priorities: ${
          budgetState.allowedPriorities.length > 0
            ? budgetState.allowedPriorities.join(", ")
            : "NONE"
        }.`,
      context: {
        spent: budgetState.spent,
        total: budgetState.totalBudget,
        level: budgetState.level,
      },
    };
  }

  /**
   * Check if a task has exceeded the maximum revision count.
   */
  checkRevisionEscalation(task: Task): Escalation | null {
    if (task.revisionCount < this.config.maxRevisionsPerTask) return null;

    return {
      reason: "agent_loop_detected",
      severity: "warning",
      message:
        `Task ${task.id} has been revised ${task.revisionCount} times ` +
        `(max: ${this.config.maxRevisionsPerTask}). Requires human decision.`,
      context: {
        taskId: task.id,
        skill: task.to,
        revisionCount: task.revisionCount,
      },
    };
  }

  /**
   * Check if cascading pipeline failures warrant escalation.
   */
  checkCascadingFailure(
    failedTaskCount: number,
    pipelineId: string,
  ): Escalation | null {
    if (failedTaskCount < 3) return null;

    return {
      reason: "cascading_failure",
      severity: "critical",
      message:
        `Pipeline ${pipelineId} has ${failedTaskCount} consecutive failures. ` +
        `System may need human intervention.`,
      context: { pipelineId, failedTaskCount },
    };
  }
}
