import type { Task, Priority } from "../types/task.ts";
import type { ComponentHealth } from "../types/health.ts";
import type { ExecutionResult } from "../agents/executor.ts";

// ── Redis Configuration ─────────────────────────────────────────────────────

export interface RedisConfig {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db?: number;
  readonly maxRetriesPerRequest: number | null;
  readonly connectTimeout: number;
  readonly lazyConnect: boolean;
}

export const DEFAULT_REDIS_CONFIG: RedisConfig = {
  host: "localhost",
  port: 6379,
  maxRetriesPerRequest: 3,
  connectTimeout: 5_000,
  lazyConnect: true,
};

// ── Queue Retry Configuration ───────────────────────────────────────────────

export interface QueueRetryConfig {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly backoffType: "exponential";
}

export const DEFAULT_QUEUE_RETRY: QueueRetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 2_000,
  backoffType: "exponential",
};

// ── Task Queue Configuration ────────────────────────────────────────────────

export interface TaskQueueConfig {
  readonly redis: RedisConfig;
  readonly queueName: string;
  readonly maxParallelAgents: number;
  readonly retry: QueueRetryConfig;
  readonly healthCheckIntervalMs: number;
  readonly fallbackDir: string;
  readonly stalledJobIntervalMs: number;
}

export const DEFAULT_TASK_QUEUE_CONFIG: TaskQueueConfig = {
  redis: DEFAULT_REDIS_CONFIG,
  queueName: "marketing-tasks",
  maxParallelAgents: 3,
  retry: DEFAULT_QUEUE_RETRY,
  healthCheckIntervalMs: 30_000,
  fallbackDir: ".workspace/queue-fallback",
  stalledJobIntervalMs: 30_000,
};

// ── Queue Job Data ──────────────────────────────────────────────────────────
// Serialized into BullMQ job payload. Only IDs — worker reads full Task from workspace.

export interface QueueJobData {
  readonly taskId: string;
  readonly skill: string;
  readonly priority: Priority;
  readonly goalId: string | null;
  readonly pipelineId: string | null;
  readonly enqueuedAt: string;
}

// ── Routing Actions ─────────────────────────────────────────────────────────
// What to do after a task completes execution.

export type RoutingAction =
  | { readonly type: "enqueue_tasks"; readonly tasks: readonly Task[] }
  | { readonly type: "complete"; readonly taskId: string }
  | { readonly type: "dead_letter"; readonly taskId: string; readonly reason: string }
  | { readonly type: "deferred"; readonly taskId: string; readonly reason: string };

// ── Queue Job Result ────────────────────────────────────────────────────────
// What the worker returns after processing a job.

export interface QueueJobResult {
  readonly executionResult: ExecutionResult;
  readonly routingAction: RoutingAction;
}

// ── Dead Letter Entry ───────────────────────────────────────────────────────

export interface DeadLetterEntry {
  readonly taskId: string;
  readonly skill: string;
  readonly failedAt: string;
  readonly attempts: number;
  readonly lastError: string;
  readonly originalPriority: Priority;
}

// ── Queue Health ────────────────────────────────────────────────────────────

export interface QueueHealth {
  readonly redis: ComponentHealth;
  readonly queue: ComponentHealth;
  readonly worker: ComponentHealth;
  readonly queueDepth: number;
  readonly activeJobs: number;
  readonly deadLetterCount: number;
}

// ── Queue Add Options ───────────────────────────────────────────────────────

export interface QueueAddOptions {
  readonly priority: number;
  readonly attempts: number;
  readonly backoff: { readonly type: "exponential"; readonly delay: number };
  readonly jobId: string;
  readonly removeOnComplete: { readonly count: number };
  readonly removeOnFail: false;
}

// ── Queue Adapter (wraps BullMQ Queue for testability) ──────────────────────

export interface FailedJob {
  readonly id: string;
  readonly data: QueueJobData;
  readonly failedReason: string;
  readonly attemptsMade: number;
  retry(): Promise<void>;
}

export interface QueueAdapter {
  add(name: string, data: QueueJobData, opts: QueueAddOptions): Promise<{ id: string }>;
  getJobCounts(): Promise<Record<string, number>>;
  getJob(jobId: string): Promise<{ data: QueueJobData; attemptsMade: number } | null>;
  getFailed(start?: number, end?: number): Promise<FailedJob[]>;
  obliterate(opts?: { force: boolean }): Promise<void>;
  close(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

// ── Worker Adapter (wraps BullMQ Worker for testability) ────────────────────

export interface WorkerAdapter {
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  isRunning(): boolean;
}

// ── Processor Function ──────────────────────────────────────────────────────
// The function BullMQ Worker calls for each job.

export interface JobHandle {
  readonly data: QueueJobData;
  readonly id: string;
  readonly attemptsMade: number;
}

export type ProcessorFn = (job: JobHandle) => Promise<QueueJobResult>;

// ── Queue Errors ────────────────────────────────────────────────────────────

export class BudgetDeferralError extends Error {
  override readonly name = "BudgetDeferralError";

  constructor(
    public readonly taskId: string,
    public readonly priority: Priority,
    public readonly budgetLevel: string,
  ) {
    super(`Task ${taskId} (${priority}) deferred: budget at ${budgetLevel}`);
  }
}

export class CascadePauseError extends Error {
  override readonly name = "CascadePauseError";

  constructor(public readonly taskId: string) {
    super(`Task ${taskId} blocked: cascading failure detected, pipeline paused`);
  }
}

export class TaskExecutionError extends Error {
  override readonly name = "TaskExecutionError";

  constructor(
    message: string,
    public readonly executionResult: ExecutionResult,
  ) {
    super(message);
  }
}
