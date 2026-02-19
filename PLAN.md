# Task 6: Task Queue (BullMQ + Redis) — Implementation Plan

## Overview

Build a BullMQ + Redis backed priority task queue that connects the Director (task creator) to the Executor (task processor) in a self-contained orchestration loop. The queue handles priority ordering, concurrency limiting, retry with backoff, dead letter handling, budget-aware filtering, cascading failure detection, and Redis-down file-based fallback.

## File Structure

```
src/queue/
  types.ts                      # Queue interfaces, config, adapter abstractions
  priority-map.ts               # P0-P3 → BullMQ numeric priority mapping
  redis-connection.ts           # Redis connection factory + health checks
  task-queue.ts                 # Core TaskQueueManager class (self-contained loop)
  worker.ts                     # BullMQ Worker processor factory function
  completion-router.ts          # Post-execution routing based on task.next
  budget-gate.ts                # Budget-aware task filtering/deferral
  failure-tracker.ts            # Consecutive failure tracking + cascade detection
  fallback-queue.ts             # File-based FIFO fallback when Redis is down
  index.ts                      # Barrel exports
  __tests__/
    helpers.ts                  # MockQueueAdapter, MockWorkerAdapter, test fixtures
    priority-map.test.ts        # Priority mapping tests
    budget-gate.test.ts         # Budget filtering tests
    failure-tracker.test.ts     # Cascade detection tests
    fallback-queue.test.ts      # File-based fallback tests
    completion-router.test.ts   # Post-execution routing tests
    worker.test.ts              # Worker processor logic tests
    task-queue.test.ts          # Full TaskQueueManager tests
```

## Dependencies

```json
{
  "dependencies": {
    "bullmq": "^5.0.0",
    "ioredis": "^5.0.0"
  }
}
```

## Implementation Steps

### Step 1: `src/queue/types.ts` — Interfaces & Config

All type definitions. No external dependencies beyond existing project types.

**Key types:**

```typescript
// Redis connection configuration
interface RedisConfig {
  host: string; port: number; password?: string; db?: number;
  maxRetriesPerRequest: number | null; connectTimeout: number; lazyConnect: boolean;
}

// Queue-level configuration
interface TaskQueueConfig {
  redis: RedisConfig;
  queueName: string;                    // "marketing-tasks"
  maxParallelAgents: number;            // 3 (from SystemHealth.maxParallelAgents)
  retry: QueueRetryConfig;              // { maxAttempts: 3, initialDelayMs: 2000, backoffType: "exponential" }
  healthCheckIntervalMs: number;        // 30_000
  fallbackDir: string;                  // File-based fallback path
  stalledJobIntervalMs: number;         // 30_000
}

// BullMQ job payload — only IDs, NOT the full Task. Worker reads Task from workspace.
interface QueueJobData {
  taskId: string;
  skill: string;           // SkillName as string for JSON serialization
  priority: Priority;
  goalId: string | null;
  pipelineId: string | null;
  enqueuedAt: string;
}

// Worker returns this after processing
interface QueueJobResult {
  executionResult: ExecutionResult;
  routingAction: RoutingAction;
}

// Post-execution actions
type RoutingAction =
  | { type: "enqueue_tasks"; tasks: readonly Task[] }
  | { type: "complete"; taskId: string }
  | { type: "dead_letter"; taskId: string; reason: string }
  | { type: "deferred"; taskId: string; reason: string };

// Dead letter queue entry
interface DeadLetterEntry {
  taskId: string; skill: string; failedAt: string;
  attempts: number; lastError: string; originalPriority: Priority;
}

// Health snapshot
interface QueueHealth {
  redis: ComponentHealth;
  queue: ComponentHealth;
  worker: ComponentHealth;
  queueDepth: number;
  activeJobs: number;
  deadLetterCount: number;
}
```

**Testability abstractions** — These wrap BullMQ so tests inject mocks:

```typescript
interface QueueAdapter {
  add(name: string, data: QueueJobData, opts: QueueAddOptions): Promise<{ id: string }>;
  getJobCounts(): Promise<Record<string, number>>;
  getJob(jobId: string): Promise<{ data: QueueJobData; attemptsMade: number } | null>;
  getFailed(start?: number, end?: number): Promise<Array<{ id: string; data: QueueJobData; failedReason: string; attemptsMade: number }>>;
  obliterate(opts?: { force: boolean }): Promise<void>;
  close(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

interface WorkerAdapter {
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  isRunning(): boolean;
}

// The function BullMQ Worker calls for each job
type ProcessorFn = (job: { data: QueueJobData; id: string; attemptsMade: number }) => Promise<QueueJobResult>;
```

### Step 2: `src/queue/priority-map.ts` — Priority Mapping

BullMQ uses numeric priority where **lower = higher priority**.

```typescript
const PRIORITY_MAP: Record<Priority, number> = {
  P0: 1,   // critical
  P1: 5,   // high
  P2: 10,  // medium
  P3: 20,  // low
};

function taskPriorityToQueuePriority(priority: Priority): number
function queuePriorityToTaskPriority(numericPriority: number): Priority
```

**Tests**: Verify ordering invariant `P0 < P1 < P2 < P3`, roundtrip conversion.

### Step 3: `src/queue/budget-gate.ts` — Budget-Aware Filtering

Pure logic, no external deps. Checks if a task is allowed given current budget.

```typescript
class BudgetGate {
  check(task: Task, budget: BudgetState): "allow" | "defer" | "block"
  filterBatch(tasks: readonly Task[], budget: BudgetState): { allowed: Task[]; deferred: Task[] }
}
```

Rules (from existing `BudgetState.allowedPriorities`):
- `normal`: all priorities allowed
- `warning` (80%): P0, P1, P2 allowed; P3 deferred
- `throttle` (90%): P0, P1 allowed; P2, P3 deferred
- `critical` (95%): P0 only; rest deferred + cheaper models
- `exhausted` (100%): all blocked

Budget is checked at **two points**: enqueue time and processing time (double-check).

**Tests**: All budget levels × all priorities, filterBatch splitting.

### Step 4: `src/queue/failure-tracker.ts` — Cascade Detection

Tracks consecutive failures per pipeline. Triggers pause when threshold reached.

```typescript
class FailureTracker {
  constructor(cascadeThreshold = 3)
  recordFailure(taskId: string, pipelineId: string | null): void
  recordSuccess(taskId: string, pipelineId: string | null): void
  shouldPause(pipelineId?: string | null): boolean
  getFailureCounts(): ReadonlyMap<string, number>
  reset(pipelineId?: string | null): void
}
```

Design: `Map<string, number>` keyed by `pipelineId ?? "__global__"`. Success resets counter to 0. `shouldPause()` returns true when any counter >= threshold (3).

**Tests**: Consecutive failures, per-pipeline isolation, success resets, threshold boundary.

### Step 5: `src/queue/fallback-queue.ts` — File-Based FIFO Fallback

When Redis is unavailable, tasks buffer to local filesystem.

```typescript
class FallbackQueue {
  constructor(dir: string)
  async enqueue(jobData: QueueJobData): Promise<void>
  async drain(): Promise<QueueJobData[]>
  async peek(): Promise<number>
  async isEmpty(): Promise<boolean>
}
```

Implementation:
- File format: `{priority_numeric}-{timestamp}-{taskId}.json` — natural sort gives priority order
- `enqueue()`: write JSON file with filename encoding priority
- `drain()`: read all files sorted by name, parse, delete, return in order
- Used when BullMQ `add()` throws Redis connection error

**Tests**: Enqueue/drain ordering, priority sort, peek count, empty check, concurrent writes.

### Step 6: `src/queue/redis-connection.ts` — Connection Manager

```typescript
interface RedisClient {
  status: string;
  ping(): Promise<string>;
  quit(): Promise<string>;
  disconnect(): void;
}

interface RedisConnectionManager {
  getClient(): RedisClient;
  checkHealth(): Promise<ComponentHealth>;
  close(): Promise<void>;
  isConnected(): boolean;
}

function createRedisConnection(config: RedisConfig): RedisConnectionManager
function createRedisConnectionFromClient(client: RedisClient): RedisConnectionManager // for testing
```

Implementation:
- Creates `IORedis` instance from config
- `checkHealth()` sends PING, returns `ComponentHealth` with status healthy/degraded/offline
- Listens to `connect`, `error`, `close` events to track connection state

**Tests**: Mock RedisClient, verify health check returns correct ComponentHealth states.

### Step 7: `src/queue/completion-router.ts` — Post-Execution Routing

The core orchestration logic that closes the Director → Queue → Executor → Director loop.

```typescript
class CompletionRouter {
  constructor(workspace: WorkspaceManager, director: MarketingDirector)

  async route(task: Task, result: ExecutionResult): Promise<RoutingAction>
}
```

Routes based on `task.next`:

| `task.next.type` | Action |
|---|---|
| `"agent"` | Create follow-up task for `task.next.skill` with this task's output as input. Return `{ type: "enqueue_tasks", tasks: [followUpTask] }` |
| `"director_review"` | Call `director.reviewCompletedTask(taskId)`. Map `DirectorDecision.action` to RoutingAction (see below) |
| `"pipeline_continue"` | Call `director.advanceGoal(goalId)` to get next phase tasks. Return `{ type: "enqueue_tasks", tasks }` or `{ type: "complete" }` |
| `"complete"` | Return `{ type: "complete", taskId }` |

**Director review decision mapping:**

| `DirectorDecision.action` | RoutingAction |
|---|---|
| `approve` / `goal_complete` | `{ type: "complete" }` |
| `pipeline_next` | `{ type: "enqueue_tasks", tasks: decision.nextTasks }` |
| `revise` | `{ type: "enqueue_tasks", tasks: decision.nextTasks }` (revision tasks) |
| `reject_reassign` | `{ type: "enqueue_tasks", tasks: decision.nextTasks }` |
| `escalate_human` | `{ type: "dead_letter", reason: "escalated_to_human" }` |
| `goal_iterate` | Call `director.advanceGoal(goalId)` → enqueue next phase or complete |

**Tests**: Each `task.next` type, each director decision action. Uses real WorkspaceManager (temp dir) + real MarketingDirector.

### Step 8: `src/queue/worker.ts` — Worker Processor Factory

Creates the function that BullMQ Worker calls for each job.

```typescript
function createWorkerProcessor(deps: {
  workspace: WorkspaceManager;
  executor: AgentExecutor;
  budgetProvider: () => BudgetState;
  failureTracker: FailureTracker;
  completionRouter: CompletionRouter;
}): ProcessorFn
```

Processing flow per job:
1. **Budget re-check**: Call `budgetProvider()`, check if `job.data.priority` is still allowed. If not, throw `BudgetDeferralError` (BullMQ retries later).
2. **Cascade check**: If `failureTracker.shouldPause()`, throw `CascadePauseError`.
3. **Read task**: `workspace.readTask(job.data.taskId)`.
4. **Execute**: `executor.execute(task, { agentConfig })` where `agentConfig` applies model override from budget state if applicable.
5. **On failure**: `failureTracker.recordFailure()`, throw error (BullMQ handles retry with exponential backoff: 2s, 4s, 8s).
6. **On success**: `failureTracker.recordSuccess()`, call `completionRouter.route(task, result)`.
7. **Return**: `{ executionResult, routingAction }`.

**Two-layer retry design:**
- **Layer 1** (AgentExecutor internal): Retries transient API errors (rate limits, timeouts) within a single execution attempt.
- **Layer 2** (BullMQ): Retries the whole task on broader failures (workspace errors, budget changes, infrastructure issues). 3 attempts with exponential backoff.

**Tests**: Successful execution, failed execution (thrown for BullMQ retry), budget deferral, cascade pause, model override.

### Step 9: `src/queue/task-queue.ts` — Self-Contained TaskQueueManager

The central class that owns the full orchestration loop.

```typescript
class TaskQueueManager {
  constructor(deps: {
    config: TaskQueueConfig;
    workspace: WorkspaceManager;
    director: MarketingDirector;
    executor: AgentExecutor;
    budgetProvider: () => BudgetState;
    queue: QueueAdapter;
    worker: WorkerAdapter;
    redis: RedisConnectionManager;
  })

  // ── Enqueue ──────────────────────────────────────────────
  async enqueue(task: Task): Promise<"enqueued" | "deferred" | "fallback">
  async enqueueBatch(tasks: readonly Task[]): Promise<void>

  // ── Lifecycle ────────────────────────────────────────────
  async start(): Promise<void>   // Start worker, start health check timer
  async stop(): Promise<void>    // Graceful shutdown
  async pause(): Promise<void>   // Pause processing
  async resume(): Promise<void>  // Resume processing

  // ── Health ───────────────────────────────────────────────
  async getHealth(): Promise<QueueHealth>

  // ── Dead Letter Queue ────────────────────────────────────
  async getDeadLetterEntries(): Promise<readonly DeadLetterEntry[]>
  async retryDeadLetter(taskId: string): Promise<void>
}
```

**Self-contained orchestration loop:**

The TaskQueueManager wires worker event handlers internally:

```
worker.on("completed") → inspect routingAction from QueueJobResult
  → if enqueue_tasks: this.enqueueBatch(action.tasks)
  → if complete: no-op (task already approved/completed in workspace)
  → if dead_letter: already in BullMQ's failed set
  → if deferred: task status already set to "deferred"

worker.on("failed") → after BullMQ exhausts all 3 retries
  → workspace.updateTaskStatus(taskId, "failed")
  → failureTracker.recordFailure()
  → if shouldPause(): worker.pause() + emit warning
  → workspace.appendLearning({ outcome: "failure", ... })
```

**Enqueue flow:**
1. Check budget via `BudgetGate.check(task, budget)`
2. If `"defer"`: set task status to `"deferred"` in workspace, return `"deferred"`
3. If `"block"`: same but return `"deferred"`
4. If `"allow"`: try `queue.add()` with priority mapping and retry config
5. If `queue.add()` throws Redis error: `fallbackQueue.enqueue()`, return `"fallback"`

**Health check timer** (every 30s):
1. Ping Redis via `redis.checkHealth()`
2. Read queue depth via `queue.getJobCounts()`
3. If Redis was down and recovers: drain fallback queue into BullMQ
4. Build `QueueHealth` object

**Tests**: Enqueue with correct priority, batch enqueue, budget deferral, fallback on Redis error, health check, lifecycle (start/stop/pause/resume), dead letter inspection/retry.

### Step 10: `src/queue/index.ts` — Barrel Exports

Export all public types, classes, constants, and factory functions.

### Step 11: Update `src/index.ts`

Add `// ── Queue` section exporting the public API from `src/queue/index.ts`, following the existing pattern.

### Step 12: Tests

All tests use `bun:test`. No real Redis required.

**Test helpers** (`__tests__/helpers.ts`):
- `MockQueueAdapter`: In-memory job store, tracks adds/pauses/resumes
- `MockWorkerAdapter`: Event emitter with manual `emit()` for simulating completions/failures
- `MockRedisClient`: Configurable ping success/failure
- `createTestTask()`: Factory for test Task objects with sensible defaults
- `createTestBudgetState()`: Factory for different budget levels

**Test files and coverage:**

| File | What it tests |
|---|---|
| `priority-map.test.ts` | Mapping invariants, roundtrip conversion |
| `budget-gate.test.ts` | All budget levels × priorities, batch filtering |
| `failure-tracker.test.ts` | Consecutive failures, per-pipeline isolation, threshold, reset |
| `fallback-queue.test.ts` | File I/O, priority ordering, drain, peek, concurrent writes |
| `completion-router.test.ts` | All 4 task.next types, all director decision actions |
| `worker.test.ts` | Processor: success, failure, budget deferral, cascade pause, model override |
| `task-queue.test.ts` | Full manager: enqueue, batch, deferral, fallback, health, lifecycle, DLQ |

## Full Orchestration Loop

```
Director.planGoalTasks() / startPipeline() / advanceGoal()
  │
  ▼
TaskQueueManager.enqueueBatch(tasks)
  │
  ├─ BudgetGate.check() per task
  │   ├─ "allow" → queue.add() with PRIORITY_MAP[task.priority]
  │   ├─ "defer" → workspace.updateTaskStatus("deferred")
  │   └─ Redis error → fallbackQueue.enqueue()
  │
  ▼
BullMQ Worker dequeues (priority order, max 3 concurrent)
  │
  ├─ Budget re-check (in case budget changed)
  ├─ Cascade failure check
  ├─ workspace.readTask(taskId)
  ├─ executor.execute(task)
  │   ├─ Success → failureTracker.recordSuccess()
  │   │            completionRouter.route(task, result)
  │   │
  │   └─ Failure → failureTracker.recordFailure()
  │                throw → BullMQ retries (2s, 4s, 8s backoff)
  │
  ▼
CompletionRouter.route(task, result)
  │
  ├─ task.next = "agent"           → create follow-up task, enqueue
  ├─ task.next = "director_review" → director.reviewCompletedTask()
  │   ├─ approve/goal_complete     → complete
  │   ├─ pipeline_next/revise      → enqueue next tasks
  │   ├─ escalate_human            → dead letter
  │   └─ goal_iterate              → director.advanceGoal() → enqueue
  ├─ task.next = "pipeline_continue" → director.advanceGoal() → enqueue
  └─ task.next = "complete"        → done
  │
  ▼
TaskQueueManager.onJobCompleted()
  │
  └─ if enqueue_tasks → this.enqueueBatch(action.tasks)  ← LOOP CONTINUES
```

## Implementation Order

| # | File | Dependencies | Tests |
|---|---|---|---|
| 1 | `types.ts` | existing types only | N/A (types) |
| 2 | `priority-map.ts` | `types/task.ts` | `priority-map.test.ts` |
| 3 | `budget-gate.ts` | `types/task.ts`, `director/types.ts` | `budget-gate.test.ts` |
| 4 | `failure-tracker.ts` | none | `failure-tracker.test.ts` |
| 5 | `fallback-queue.ts` | `types.ts` | `fallback-queue.test.ts` |
| 6 | `redis-connection.ts` | `types.ts`, ioredis | (covered in task-queue tests) |
| 7 | `completion-router.ts` | workspace, director | `completion-router.test.ts` |
| 8 | `worker.ts` | executor, budget-gate, failure-tracker, completion-router | `worker.test.ts` |
| 9 | `task-queue.ts` | everything above | `task-queue.test.ts` |
| 10 | `index.ts` + update `src/index.ts` | all | N/A (barrel) |
| 11 | `__tests__/helpers.ts` | `types.ts` | used by all test files |

## Key Design Decisions

1. **Job payload stores `taskId` only** — Worker reads full Task from workspace at processing time. Avoids staleness and keeps payloads small.

2. **Dependency injection** — `QueueAdapter` and `WorkerAdapter` interfaces wrap BullMQ. Constructor receives these as parameters. Tests inject mocks. No real Redis needed for any test.

3. **`budgetProvider: () => BudgetState`** — Callback, not static value. Budget changes over time as tokens are consumed. Re-checked at both enqueue and processing time.

4. **Two-layer retry** — AgentExecutor retries transient API blips internally (rate limits, timeouts). BullMQ retries the whole task for broader failures (3 attempts, 2s/4s/8s exponential backoff). After BullMQ exhausts retries → dead letter queue.

5. **Self-contained loop** — TaskQueueManager wires worker `completed`/`failed` events internally. Completion routing + re-enqueueing happens automatically. Caller only needs `start()`, `stop()`, and `enqueue()`.

6. **Fallback queue** — When Redis is down, `FallbackQueue` buffers tasks to local JSON files. Health check timer detects Redis recovery and drains fallback into BullMQ automatically.
