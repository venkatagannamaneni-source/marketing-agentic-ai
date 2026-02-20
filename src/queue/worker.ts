import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { AgentExecutor } from "../agents/executor.ts";
import type { BudgetState } from "../director/types.ts";
import type { ProcessorFn, QueueJobResult } from "./types.ts";
import { BudgetDeferralError, CascadePauseError, TaskExecutionError } from "./types.ts";
import { NULL_LOGGER } from "../observability/logger.ts";
import type { Logger } from "../observability/logger.ts";
import type { FailureTracker } from "./failure-tracker.ts";
import type { CompletionRouter } from "./completion-router.ts";

// ── Worker Processor Factory ────────────────────────────────────────────────
// Creates the function that BullMQ Worker calls for each job.

export interface WorkerProcessorDeps {
  readonly workspace: WorkspaceManager;
  readonly executor: AgentExecutor;
  readonly budgetProvider: () => BudgetState;
  readonly failureTracker: FailureTracker;
  readonly completionRouter: CompletionRouter;
  readonly logger?: Logger;
}

export function createWorkerProcessor(deps: WorkerProcessorDeps): ProcessorFn {
  const { workspace, executor, budgetProvider, failureTracker, completionRouter } = deps;
  const logger = (deps.logger ?? NULL_LOGGER).child({ module: "worker-processor" });

  return async (job): Promise<QueueJobResult> => {
    const { taskId, priority, pipelineId } = job.data;

    logger.debug("worker_job_started", { taskId, priority });

    // Step 1: Re-check budget at processing time
    const budget = budgetProvider();
    if (!budget.allowedPriorities.includes(priority)) {
      logger.info("worker_budget_deferred", { taskId, priority, budgetLevel: budget.level });
      throw new BudgetDeferralError(taskId, priority, budget.level);
    }

    // Step 2: Check for cascading failures
    if (failureTracker.shouldPause(pipelineId)) {
      logger.warn("worker_cascade_paused", { taskId, pipelineId });
      throw new CascadePauseError(taskId);
    }

    // Step 3: Read the full task from workspace
    const task = await workspace.readTask(taskId);

    // Step 4: Execute via AgentExecutor (passes budgetState for model selection)
    const result = await executor.execute(task, { budgetState: budget });

    // Step 5: Handle failure
    if (result.status === "failed") {
      // Budget exhaustion should not be retried by BullMQ
      if (result.error?.code === "BUDGET_EXHAUSTED") {
        logger.info("worker_budget_exhausted", { taskId, code: result.error.code });
        throw new BudgetDeferralError(taskId, priority, budget.level);
      }
      failureTracker.recordFailure(taskId, pipelineId);
      logger.error("worker_execution_failed", {
        taskId,
        error: result.error?.message,
      });
      throw new TaskExecutionError(
        result.error?.message ?? `Task ${taskId} execution failed`,
        result,
      );
    }

    // Step 6: Record success
    failureTracker.recordSuccess(taskId, pipelineId);

    logger.info("worker_execution_completed", {
      taskId,
      status: result.status,
      tokens: result.metadata.inputTokens + result.metadata.outputTokens,
      cost: result.metadata.estimatedCost,
    });

    // Step 7: Route completion
    const routingAction = await completionRouter.route(task, result);

    logger.debug("worker_routing_completed", {
      taskId,
      routingType: routingAction.type,
    });

    return { executionResult: result, routingAction };
  };
}
