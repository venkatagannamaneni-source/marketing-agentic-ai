import type { PipelineStep, PipelineRun } from "../types/pipeline.ts";
import type { Task, Priority } from "../types/task.ts";
import type { ExecutionResult } from "../executor/types.ts";

// ── Pipeline Error ──────────────────────────────────────────────────────────

export type PipelineErrorCode =
  | "STEP_FAILED"
  | "NO_STEPS"
  | "INVALID_STEP_INDEX"
  | "TASK_CREATION_FAILED"
  | "WORKSPACE_ERROR"
  | "ABORTED"
  | "ALREADY_RUNNING"
  | "PAUSED_FOR_REVIEW"
  | "UNKNOWN";

export class PipelineError extends Error {
  override readonly name = "PipelineError";

  constructor(
    message: string,
    public readonly code: PipelineErrorCode,
    public readonly pipelineRunId: string,
    public readonly stepIndex?: number,
    public override readonly cause?: Error,
  ) {
    super(message);
  }
}

// ── Step Result ─────────────────────────────────────────────────────────────

export interface StepResult {
  readonly stepIndex: number;
  readonly step: PipelineStep;
  readonly tasks: readonly Task[];
  readonly executionResults: readonly ExecutionResult[];
  readonly outputPaths: readonly string[];
  readonly status: "completed" | "failed" | "paused";
  readonly durationMs: number;
  readonly error?: PipelineError;
}

// ── Pipeline Result ─────────────────────────────────────────────────────────

export interface PipelineResult {
  readonly pipelineRunId: string;
  readonly pipelineId: string;
  readonly status: "completed" | "failed" | "paused" | "cancelled";
  readonly stepResults: readonly StepResult[];
  readonly totalDurationMs: number;
  readonly totalTokensUsed: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly error?: PipelineError;
  readonly run: PipelineRun;
}

// ── Pipeline Engine Config ──────────────────────────────────────────────────

export interface PipelineEngineConfig {
  readonly goalDescription: string;
  readonly priority: Priority;
  readonly signal?: AbortSignal;
  readonly initialInputPaths?: readonly string[];
  readonly onStepComplete?: (stepResult: StepResult) => void;
  readonly onStatusChange?: (run: PipelineRun) => void;
}
