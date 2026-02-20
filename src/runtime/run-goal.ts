import type { Application } from "../bootstrap.ts";
import type { GoalCategory } from "../types/goal.ts";
import type { Priority } from "../types/task.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface GoalRunOptions {
  readonly priority?: Priority;
  readonly category?: GoalCategory;
  readonly dryRun?: boolean;
}

export type GoalResultStatus =
  | "completed"
  | "failed"
  | "budget_exhausted"
  | "max_iterations";

export interface GoalResult {
  readonly goalId: string;
  readonly status: GoalResultStatus;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  readonly totalCost: number;
  readonly phases: number;
  readonly durationMs: number;
  readonly error?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 50;
const POLL_INTERVAL_MS = 2_000;

// ── Category Inference ───────────────────────────────────────────────────────

export function inferCategory(description: string): GoalCategory {
  const lower = description.toLowerCase();

  if (/\b(content|blog|article|copy|write)\b/.test(lower)) return "content";
  if (/\b(conver[ts]?|signup|cro|optimiz|landing|page)\b/.test(lower))
    return "optimization";
  if (
    /\b(churn|retain|onboard|activation|email.?sequence|referral)\b/.test(
      lower,
    )
  )
    return "retention";
  if (/\b(competitor|alternative|vs\b|competitive)/.test(lower))
    return "competitive";
  if (/\b(analytics|track|measur|seo.?audit|a\/?b.?test)\b/.test(lower))
    return "measurement";

  return "strategic";
}

// ── Sleep Helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Goal Run Loop ────────────────────────────────────────────────────────────

/**
 * Orchestrate a single goal's full lifecycle:
 * Director creates goal → decomposes into plan → materializes tasks →
 * enqueues to BullMQ → worker processes → Director reviews and advances →
 * repeat until all phases complete.
 *
 * Returns a GoalResult summarizing the outcome.
 */
export async function runGoal(
  app: Application,
  goalDescription: string,
  options: GoalRunOptions = {},
): Promise<GoalResult> {
  const startTime = Date.now();

  // 1. Determine category
  const category = options.category ?? inferCategory(goalDescription);
  const priority = options.priority ?? "P2";

  app.logger.info("Creating goal", { description: goalDescription, category, priority });

  // 2. Create goal
  const goal = await app.director.createGoal(
    goalDescription,
    category,
    priority,
  );
  app.logger.info("Goal created", { goalId: goal.id });

  // 3. Decompose goal into plan
  const plan = app.director.decomposeGoal(goal);
  if (plan.phases.length === 0) {
    app.logger.info("Goal decomposed into 0 phases — nothing to do", {
      goalId: goal.id,
    });
    return {
      goalId: goal.id,
      status: "completed",
      tasksCompleted: 0,
      tasksFailed: 0,
      totalCost: app.costTracker.getTotalSpent(),
      phases: 0,
      durationMs: Date.now() - startTime,
    };
  }
  app.logger.info("Goal decomposed", {
    goalId: goal.id,
    phases: plan.phases.length,
    estimatedTasks: plan.estimatedTaskCount,
  });

  // 4. Materialize Phase 1 tasks
  const initialTasks = await app.director.planGoalTasks(plan, goal);
  if (initialTasks.length === 0) {
    app.logger.info("No tasks materialized for Phase 1", {
      goalId: goal.id,
    });
    return {
      goalId: goal.id,
      status: "completed",
      tasksCompleted: 0,
      tasksFailed: 0,
      totalCost: app.costTracker.getTotalSpent(),
      phases: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // 5. Dry run: log plan and return
  if (options.dryRun) {
    app.logger.info("Dry run — would enqueue tasks", {
      goalId: goal.id,
      taskCount: initialTasks.length,
      skills: initialTasks.map((t) => t.to),
    });
    return {
      goalId: goal.id,
      status: "completed",
      tasksCompleted: 0,
      tasksFailed: 0,
      totalCost: 0,
      phases: plan.phases.length,
      durationMs: Date.now() - startTime,
    };
  }

  // 6. Enqueue Phase 1 tasks
  await app.queueManager.enqueueBatch(initialTasks);
  app.logger.info("Phase 1 tasks enqueued", {
    goalId: goal.id,
    taskCount: initialTasks.length,
  });

  // 7. Poll loop
  let iteration = 0;
  let tasksCompleted = 0;
  let tasksFailed = 0;
  let phasesCompleted = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Wait for processing
    await sleep(POLL_INTERVAL_MS);

    // Check budget
    const budget = app.costTracker.toBudgetState();
    if (budget.level === "exhausted") {
      app.logger.warn("Budget exhausted — aborting goal", {
        goalId: goal.id,
        spent: budget.spent,
        totalBudget: budget.totalBudget,
      });
      return {
        goalId: goal.id,
        status: "budget_exhausted",
        tasksCompleted,
        tasksFailed,
        totalCost: app.costTracker.getTotalSpent(),
        phases: phasesCompleted,
        durationMs: Date.now() - startTime,
        error: `Budget exhausted at $${budget.spent.toFixed(2)} of $${budget.totalBudget.toFixed(2)}`,
      };
    }

    // Read all tasks for this goal
    const allTasks = await app.workspace.listTasks();
    const goalTasks = allTasks.filter((t) => t.goalId === goal.id);

    // Count by status category
    const completed = goalTasks.filter(
      (t) => t.status === "approved" || t.status === "completed",
    );
    const failed = goalTasks.filter((t) => t.status === "failed");
    const active = goalTasks.filter(
      (t) =>
        t.status === "pending" ||
        t.status === "assigned" ||
        t.status === "in_progress" ||
        t.status === "revision",
    );

    tasksCompleted = completed.length;
    tasksFailed = failed.length;

    // If there are active tasks, keep waiting
    if (active.length > 0) {
      app.logger.debug("Waiting for active tasks", {
        goalId: goal.id,
        iteration,
        active: active.length,
        completed: tasksCompleted,
        failed: tasksFailed,
      });
      continue;
    }

    // All current tasks are terminal — try to advance goal
    const advanceResult = await app.director.advanceGoal(goal.id);

    if (advanceResult === "complete") {
      phasesCompleted = plan.phases.length;
      app.logger.info("Goal complete — all phases done", {
        goalId: goal.id,
      });
      break;
    }

    // advanceResult is a Task[] for the next phase
    phasesCompleted++;
    await app.queueManager.enqueueBatch(advanceResult);
    app.logger.info("Advanced to next phase", {
      goalId: goal.id,
      phase: phasesCompleted + 1,
      newTasks: advanceResult.length,
    });
  }

  // 8. Determine final status
  let status: GoalResultStatus;
  if (iteration >= MAX_ITERATIONS) {
    status = "max_iterations";
  } else if (tasksFailed > 0 && tasksCompleted === 0) {
    status = "failed";
  } else {
    status = "completed";
  }

  return {
    goalId: goal.id,
    status,
    tasksCompleted,
    tasksFailed,
    totalCost: app.costTracker.getTotalSpent(),
    phases: phasesCompleted,
    durationMs: Date.now() - startTime,
    error:
      status === "max_iterations"
        ? `Goal did not complete within ${MAX_ITERATIONS} iterations`
        : undefined,
  };
}
