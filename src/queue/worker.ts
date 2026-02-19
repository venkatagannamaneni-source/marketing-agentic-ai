import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { AgentExecutor } from "../executor/agent-executor.ts";
import type { BudgetState } from "../director/types.ts";
import type { ProcessorFn, QueueJobResult } from "./types.ts";
import { BudgetDeferralError, CascadePauseError, TaskExecutionError } from "./types.ts";
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
}

export function createWorkerProcessor(deps: WorkerProcessorDeps): ProcessorFn {
  const { workspace, executor, budgetProvider, failureTracker, completionRouter } = deps;

  return async (job): Promise<QueueJobResult> => {
    const { taskId, priority, pipelineId } = job.data;

    // Step 1: Re-check budget at processing time
    const budget = budgetProvider();
    if (!budget.allowedPriorities.includes(priority)) {
      throw new BudgetDeferralError(taskId, priority, budget.level);
    }

    // Step 2: Check for cascading failures
    if (failureTracker.shouldPause(pipelineId)) {
      throw new CascadePauseError(taskId);
    }

    // Step 3: Read the full task from workspace
    const task = await workspace.readTask(taskId);

    // Step 4: Determine agent config (model override from budget)
    const agentConfig = budget.modelOverride
      ? {
          skill: task.to,
          modelTier: budget.modelOverride,
          timeoutMs: 120_000,
          maxRetries: 2,
        }
      : undefined;

    // Step 5: Execute via AgentExecutor
    const result = await executor.execute(task, { agentConfig });

    // Step 6: Handle failure
    if (result.status === "failed") {
      failureTracker.recordFailure(taskId, pipelineId);
      throw new TaskExecutionError(
        result.error?.message ?? `Task ${taskId} execution failed`,
        result,
      );
    }

    // Step 7: Record success
    failureTracker.recordSuccess(taskId, pipelineId);

    // Step 8: Route completion
    const routingAction = await completionRouter.route(task, result);

    return { executionResult: result, routingAction };
  };
}
