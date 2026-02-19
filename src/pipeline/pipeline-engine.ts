import type {
  PipelineDefinition,
  PipelineRun,
  PipelineStep,
  PipelineStatus,
} from "../types/pipeline.ts";
import type { SkillName } from "../types/agent.ts";
import type { Task } from "../types/task.ts";
import type { ExecutionResult } from "../executor/types.ts";
import type { AgentExecutor } from "../executor/agent-executor.ts";
import type { PipelineFactory } from "../director/pipeline-factory.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type {
  PipelineEngineConfig,
  PipelineResult,
  StepResult,
} from "./types.ts";
import { PipelineError } from "./types.ts";

// ── Valid starting statuses ─────────────────────────────────────────────────

const STARTABLE_STATUSES = new Set<PipelineStatus>(["pending", "paused"]);

// ── Sequential Pipeline Engine ──────────────────────────────────────────────

export class SequentialPipelineEngine {
  constructor(
    private readonly factory: PipelineFactory,
    private readonly executor: AgentExecutor,
    private readonly workspace: WorkspaceManager,
  ) {}

  /**
   * Execute a pipeline definition step-by-step.
   * Never throws — always returns a PipelineResult.
   * Mutates `run` in place (status, currentStepIndex, completedAt, taskIds).
   */
  async execute(
    definition: PipelineDefinition,
    run: PipelineRun,
    config: PipelineEngineConfig,
  ): Promise<PipelineResult> {
    const startTime = Date.now();
    const stepResults: StepResult[] = [];

    // ── Validation ──────────────────────────────────────────────────────

    if (definition.steps.length === 0) {
      return this.buildPipelineResult(
        run,
        definition,
        stepResults,
        startTime,
        "failed",
        new PipelineError("Pipeline has no steps", "NO_STEPS", run.id),
      );
    }

    if (!STARTABLE_STATUSES.has(run.status)) {
      return this.buildPipelineResult(
        run,
        definition,
        stepResults,
        startTime,
        "failed",
        new PipelineError(
          `Pipeline run status "${run.status}" is not startable (must be pending or paused)`,
          "ALREADY_RUNNING",
          run.id,
        ),
      );
    }

    // ── Initialize ──────────────────────────────────────────────────────

    let inputPaths: readonly string[] = config.initialInputPaths ?? [];

    // If resuming from paused, advance past the review step
    if (run.status === "paused") {
      run.currentStepIndex += 1;
    }

    this.updateRunStatus(run, "running", config);

    // ── Step Loop ───────────────────────────────────────────────────────

    try {
      for (
        let stepIndex = run.currentStepIndex;
        stepIndex < definition.steps.length;
        stepIndex++
      ) {
        // Check cancellation before each step
        if (config.signal?.aborted) {
          this.updateRunStatus(run, "cancelled", config);
          return this.buildPipelineResult(
            run,
            definition,
            stepResults,
            startTime,
            "cancelled",
            new PipelineError(
              "Pipeline cancelled via abort signal",
              "ABORTED",
              run.id,
              stepIndex,
            ),
          );
        }

        const step = definition.steps[stepIndex]!;
        run.currentStepIndex = stepIndex;

        // Dispatch by step type
        const stepResult = await this.executeStep(
          step,
          stepIndex,
          definition.steps.length,
          run,
          config,
          inputPaths,
        );

        stepResults.push(stepResult);
        config.onStepComplete?.(stepResult);

        // Handle step outcome
        if (stepResult.status === "failed") {
          this.updateRunStatus(run, "failed", config);
          run.completedAt = new Date().toISOString();
          return this.buildPipelineResult(
            run,
            definition,
            stepResults,
            startTime,
            "failed",
            stepResult.error,
          );
        }

        if (stepResult.status === "paused") {
          this.updateRunStatus(run, "paused", config);
          return this.buildPipelineResult(
            run,
            definition,
            stepResults,
            startTime,
            "paused",
            new PipelineError(
              `Pipeline paused at review step ${stepIndex}`,
              "PAUSED_FOR_REVIEW",
              run.id,
              stepIndex,
            ),
          );
        }

        // Wire outputs to next step's inputs
        inputPaths = stepResult.outputPaths;
      }
    } catch (err: unknown) {
      // Catch-all: should never reach here but ensures we never throw
      this.updateRunStatus(run, "failed", config);
      run.completedAt = new Date().toISOString();
      const pipelineErr =
        err instanceof PipelineError
          ? err
          : new PipelineError(
              `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
              "UNKNOWN",
              run.id,
              undefined,
              err instanceof Error ? err : undefined,
            );
      return this.buildPipelineResult(
        run,
        definition,
        stepResults,
        startTime,
        "failed",
        pipelineErr,
      );
    }

    // ── All steps completed ─────────────────────────────────────────────

    this.updateRunStatus(run, "completed", config);
    run.completedAt = new Date().toISOString();
    return this.buildPipelineResult(
      run,
      definition,
      stepResults,
      startTime,
      "completed",
    );
  }

  // ── Step Dispatch ───────────────────────────────────────────────────────

  private async executeStep(
    step: PipelineStep,
    stepIndex: number,
    totalSteps: number,
    run: PipelineRun,
    config: PipelineEngineConfig,
    inputPaths: readonly string[],
  ): Promise<StepResult> {
    switch (step.type) {
      case "sequential":
        return this.executeSequentialStep(
          step,
          stepIndex,
          totalSteps,
          run,
          config,
          inputPaths,
        );
      case "parallel":
        return this.executeParallelStepSequentially(
          step,
          stepIndex,
          totalSteps,
          run,
          config,
          inputPaths,
        );
      case "review":
        return this.handleReviewStep(step, stepIndex);
    }
  }

  // ── Sequential Step ─────────────────────────────────────────────────────

  private async executeSequentialStep(
    step: { readonly type: "sequential"; readonly skill: SkillName },
    stepIndex: number,
    totalSteps: number,
    run: PipelineRun,
    config: PipelineEngineConfig,
    inputPaths: readonly string[],
  ): Promise<StepResult> {
    const stepStart = Date.now();

    // Create task via factory
    let tasks: readonly Task[];
    try {
      tasks = this.factory.createTasksForStep(
        step,
        stepIndex,
        totalSteps,
        run,
        config.goalDescription,
        config.priority,
        inputPaths,
      );
    } catch (err: unknown) {
      return {
        stepIndex,
        step,
        tasks: [],
        executionResults: [],
        outputPaths: [],
        status: "failed",
        durationMs: Date.now() - stepStart,
        error: new PipelineError(
          `Failed to create tasks for step ${stepIndex}: ${err instanceof Error ? err.message : String(err)}`,
          "TASK_CREATION_FAILED",
          run.id,
          stepIndex,
          err instanceof Error ? err : undefined,
        ),
      };
    }

    const task = tasks[0]!;

    // Record task ID on the run
    run.taskIds.push(task.id);

    // Persist task to workspace
    try {
      await this.workspace.writeTask(task);
    } catch (err: unknown) {
      return {
        stepIndex,
        step,
        tasks: [task],
        executionResults: [],
        outputPaths: [],
        status: "failed",
        durationMs: Date.now() - stepStart,
        error: new PipelineError(
          `Failed to persist task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          "WORKSPACE_ERROR",
          run.id,
          stepIndex,
          err instanceof Error ? err : undefined,
        ),
      };
    }

    // Execute via AgentExecutor
    const result = await this.executor.execute(task, {
      signal: config.signal,
    });

    if (result.status === "failed") {
      return {
        stepIndex,
        step,
        tasks: [task],
        executionResults: [result],
        outputPaths: [],
        status: "failed",
        durationMs: Date.now() - stepStart,
        error: new PipelineError(
          `Step ${stepIndex} failed: agent "${step.skill}" execution failed — ${result.error?.message ?? "unknown reason"}`,
          "STEP_FAILED",
          run.id,
          stepIndex,
          result.error,
        ),
      };
    }

    return {
      stepIndex,
      step,
      tasks: [task],
      executionResults: [result],
      outputPaths: this.collectOutputPaths([result]),
      status: "completed",
      durationMs: Date.now() - stepStart,
    };
  }

  // ── Parallel Step (Sequential Fallback) ─────────────────────────────────

  private async executeParallelStepSequentially(
    step: {
      readonly type: "parallel";
      readonly skills: readonly SkillName[];
    },
    stepIndex: number,
    totalSteps: number,
    run: PipelineRun,
    config: PipelineEngineConfig,
    inputPaths: readonly string[],
  ): Promise<StepResult> {
    const stepStart = Date.now();

    // Create all tasks for the parallel step
    let tasks: readonly Task[];
    try {
      tasks = this.factory.createTasksForStep(
        step,
        stepIndex,
        totalSteps,
        run,
        config.goalDescription,
        config.priority,
        inputPaths,
      );
    } catch (err: unknown) {
      return {
        stepIndex,
        step,
        tasks: [],
        executionResults: [],
        outputPaths: [],
        status: "failed",
        durationMs: Date.now() - stepStart,
        error: new PipelineError(
          `Failed to create tasks for parallel step ${stepIndex}: ${err instanceof Error ? err.message : String(err)}`,
          "TASK_CREATION_FAILED",
          run.id,
          stepIndex,
          err instanceof Error ? err : undefined,
        ),
      };
    }

    const executionResults: ExecutionResult[] = [];
    const allOutputPaths: string[] = [];

    // Execute tasks one at a time (Task 5 adds real parallelism)
    for (const task of tasks) {
      // Check cancellation between sub-tasks
      if (config.signal?.aborted) {
        return {
          stepIndex,
          step,
          tasks: [...tasks],
          executionResults,
          outputPaths: allOutputPaths,
          status: "failed",
          durationMs: Date.now() - stepStart,
          error: new PipelineError(
            "Pipeline cancelled during parallel step execution",
            "ABORTED",
            run.id,
            stepIndex,
          ),
        };
      }

      // Record and persist
      run.taskIds.push(task.id);

      try {
        await this.workspace.writeTask(task);
      } catch (err: unknown) {
        return {
          stepIndex,
          step,
          tasks: [...tasks],
          executionResults,
          outputPaths: allOutputPaths,
          status: "failed",
          durationMs: Date.now() - stepStart,
          error: new PipelineError(
            `Failed to persist task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
            "WORKSPACE_ERROR",
            run.id,
            stepIndex,
            err instanceof Error ? err : undefined,
          ),
        };
      }

      // Execute
      const result = await this.executor.execute(task, {
        signal: config.signal,
      });
      executionResults.push(result);

      if (result.status === "failed") {
        return {
          stepIndex,
          step,
          tasks: [...tasks],
          executionResults,
          outputPaths: allOutputPaths,
          status: "failed",
          durationMs: Date.now() - stepStart,
          error: new PipelineError(
            `Parallel step ${stepIndex} failed: agent "${task.to}" execution failed — ${result.error?.message ?? "unknown reason"}`,
            "STEP_FAILED",
            run.id,
            stepIndex,
            result.error,
          ),
        };
      }

      if (result.outputPath) {
        allOutputPaths.push(result.outputPath);
      }
    }

    return {
      stepIndex,
      step,
      tasks: [...tasks],
      executionResults,
      outputPaths: allOutputPaths,
      status: "completed",
      durationMs: Date.now() - stepStart,
    };
  }

  // ── Review Step ─────────────────────────────────────────────────────────

  private handleReviewStep(
    step: {
      readonly type: "review";
      readonly reviewer: SkillName | "director";
    },
    stepIndex: number,
  ): StepResult {
    return {
      stepIndex,
      step,
      tasks: [],
      executionResults: [],
      outputPaths: [],
      status: "paused",
      durationMs: 0,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private updateRunStatus(
    run: PipelineRun,
    status: PipelineStatus,
    config: PipelineEngineConfig,
  ): void {
    run.status = status;
    config.onStatusChange?.(run);
  }

  private collectOutputPaths(results: readonly ExecutionResult[]): string[] {
    return results
      .filter((r) => r.outputPath !== null)
      .map((r) => r.outputPath!);
  }

  private aggregateTokens(stepResults: readonly StepResult[]): {
    input: number;
    output: number;
    total: number;
  } {
    let input = 0;
    let output = 0;
    for (const step of stepResults) {
      for (const result of step.executionResults) {
        input += result.tokensUsed.input;
        output += result.tokensUsed.output;
      }
    }
    return { input, output, total: input + output };
  }

  private buildPipelineResult(
    run: PipelineRun,
    definition: PipelineDefinition,
    stepResults: readonly StepResult[],
    startTime: number,
    status: PipelineResult["status"],
    error?: PipelineError,
  ): PipelineResult {
    return {
      pipelineRunId: run.id,
      pipelineId: definition.id,
      status,
      stepResults,
      totalDurationMs: Date.now() - startTime,
      totalTokensUsed: this.aggregateTokens(stepResults),
      run,
      ...(error ? { error } : {}),
    };
  }
}
