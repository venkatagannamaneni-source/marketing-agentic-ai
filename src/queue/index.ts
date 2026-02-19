// ── Types ────────────────────────────────────────────────────────────────────
export type {
  RedisConfig,
  TaskQueueConfig,
  QueueRetryConfig,
  QueueJobData,
  QueueJobResult,
  RoutingAction,
  DeadLetterEntry,
  QueueHealth,
  QueueAddOptions,
  QueueAdapter,
  FailedJob,
  WorkerAdapter,
  JobHandle,
  ProcessorFn,
} from "./types.ts";

export {
  DEFAULT_REDIS_CONFIG,
  DEFAULT_QUEUE_RETRY,
  DEFAULT_TASK_QUEUE_CONFIG,
  BudgetDeferralError,
  CascadePauseError,
  TaskExecutionError,
} from "./types.ts";

// ── Priority Mapping ─────────────────────────────────────────────────────────
export {
  PRIORITY_MAP,
  taskPriorityToQueuePriority,
  queuePriorityToTaskPriority,
} from "./priority-map.ts";

// ── Budget Gate ──────────────────────────────────────────────────────────────
export { BudgetGate, type BudgetDecision } from "./budget-gate.ts";

// ── Failure Tracker ──────────────────────────────────────────────────────────
export { FailureTracker } from "./failure-tracker.ts";

// ── Fallback Queue ───────────────────────────────────────────────────────────
export { FallbackQueue } from "./fallback-queue.ts";

// ── Redis Connection ─────────────────────────────────────────────────────────
export {
  createRedisConnection,
  createRedisConnectionFromClient,
  type RedisClient,
  type RedisConnectionManager,
} from "./redis-connection.ts";

// ── Completion Router ────────────────────────────────────────────────────────
export { CompletionRouter } from "./completion-router.ts";

// ── Worker ───────────────────────────────────────────────────────────────────
export {
  createWorkerProcessor,
  type WorkerProcessorDeps,
} from "./worker.ts";

// ── Task Queue Manager ──────────────────────────────────────────────────────
export {
  TaskQueueManager,
  type TaskQueueManagerDeps,
  type EnqueueResult,
} from "./task-queue.ts";
