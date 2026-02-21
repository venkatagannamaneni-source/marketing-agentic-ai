# Phase 2 Design — 24/7 Runtime Engine

**Status:** Implementation complete (Feb 21, 2026)
**Scope:** Weeks 5-8 of [PROJECT_PROPOSAL.md](../PROJECT_PROPOSAL.md)
**Pre-condition:** Phase 1 complete (938 tests, 8 modules, all mocked). Final: 1447 tests, 14 modules.

## What Phase 2 Delivers

Phase 1 built a library. Phase 2 makes it run. After Phase 2:

- `bun run start "Increase signup conversion by 20%"` executes a full goal lifecycle against real Claude API and Redis
- `bun run start --daemon` runs the 24/7 marketing team — cron-scheduled pipelines, webhook-triggered reactions, cost-tracked and observable
- Agents read past learnings before producing output, improving over time
- Humans get structured logs and cost reports, not silent black boxes

## What Phase 2 Does NOT Deliver

- PostgreSQL persistence (Phase 4)
- External integrations — GA4, CMS, email platforms (Phase 3)
- Web dashboard / REST API (Phase 5)
- Multi-tenancy (Phase 5)

---

## Pre-requisites: Must-Fix Blockers

### P0: Consolidate Dual Executor (CRITICAL)

Two incompatible `AgentExecutor` classes exist with different interfaces, result types, and Claude client contracts:

| | Legacy (`src/executor/agent-executor.ts`) | Modern (`src/agents/executor.ts`) |
|---|---|---|
| Method | `execute(task, {signal?, agentConfig?})` | `executeTask(task, budgetState?, signal?)` |
| Result type | `{status, outputPath, tokensUsed, error?}` | `{content, metadata, truncated, missingInputs, warnings}` |
| Claude interface | `client.complete(request)` | `client.createMessage(params)` |
| Consumers | Pipeline engine, Queue worker | MarketingDirector |
| Capabilities | Retry with backoff, error codes | Budget awareness, model selection, truncation retry |

The modern executor is the correct target — it has budget awareness, model selection, and richer return types that Phase 2 needs.

**Files to change:**
- `src/agents/executor.ts` — add `outputPath` to `ExecutionResult` so pipeline/queue consumers can read it
- `src/pipeline/pipeline-engine.ts` — switch import from `../executor/` to `../agents/executor`; adapt calls; map result types via adapter
- `src/queue/worker.ts` — switch import; adapt `executor.execute(task, {agentConfig})` to `executor.executeTask(task, budgetState, signal)`
- `src/queue/task-queue.ts` — update `AgentExecutor` import and `TaskQueueManagerDeps` type
- `src/pipeline/types.ts` — update `ExecutionResult` import or add adapter type
- `src/__tests__/e2e/helpers.ts` — rewire test bootstrap to use modern executor

**Approach:** Create an adapter layer in pipeline-engine and worker that maps modern `ExecutionResult` to the legacy shape for existing consumers (StepResult, QueueJobResult). This minimizes blast radius — existing tests keep passing while the underlying executor is swapped.

**Complexity:** M | **Risk:** High (touches pipeline + queue + all E2E tests)

### P1: Centralize Model IDs

`DEFAULT_MODEL_MAP` in `src/executor/types.ts:91-95` duplicates `MODEL_MAP` in `src/agents/claude-client.ts:64-68`. After P0, delete `DEFAULT_MODEL_MAP` from `executor/types.ts` and point all references to the single source in `src/agents/claude-client.ts`.

**Complexity:** S

---

## Work Stream 1: Entry Point + Real API

**Goal:** `bun run start "Increase signup conversion by 20%"` works end-to-end.

**Depends on:** P0 (executor consolidation)

### 1.1 Configuration System

**New file:** `src/config.ts`

```typescript
interface RuntimeConfig {
  readonly anthropicApiKey: string;
  readonly redis: { host: string; port: number; password?: string };
  readonly workspace: { rootDir: string };
  readonly projectRoot: string;
  readonly budget: { totalMonthly: number };
  readonly logging: { level: string; format: "json" | "pretty" };
  readonly maxParallelAgents: number;
}

function loadConfig(envOverrides?: Partial<RuntimeConfig>): RuntimeConfig;
```

- Reads from env vars: `ANTHROPIC_API_KEY`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `WORKSPACE_DIR`
- Uses Bun's built-in `.env` support
- Validates required fields, returns frozen config

### 1.2 Bootstrap / Composition Root

**New file:** `src/bootstrap.ts`

```typescript
interface Application {
  readonly config: RuntimeConfig;
  readonly workspace: FileSystemWorkspaceManager;
  readonly client: AnthropicClaudeClient;
  readonly director: MarketingDirector;
  readonly executor: AgentExecutor;
  readonly pipelineEngine: SequentialPipelineEngine;
  readonly queueManager: TaskQueueManager;
  readonly scheduler: Scheduler;
  readonly eventBus: EventBus;
  readonly logger: Logger;

  start(): Promise<void>;
  shutdown(): Promise<void>;
}

async function bootstrap(config: RuntimeConfig): Promise<Application>;
```

The composition root that wires all modules together with real implementations. Creates real `FileSystemWorkspaceManager`, real `AnthropicClaudeClient`, modern `AgentExecutor`, `MarketingDirector`, pipeline engine, BullMQ queue manager, scheduler, event bus, and logger. Sets up SIGTERM/SIGINT graceful shutdown.

### 1.3 CLI Entry Point

**New file:** `src/cli.ts` (wired via `package.json` scripts.start)

- `bun run start "goal string"` — single-goal mode (run to completion, print summary, exit)
- `bun run start --daemon` — 24/7 runtime (scheduler + event bus + queue worker)
- `bun run start --pipeline "Content Production"` — named pipeline template
- Flags: `--dry-run`, `--priority P0-P3`

### 1.4 Real BullMQ Adapters

**New file:** `src/queue/bullmq-adapter.ts`

```typescript
class BullMQQueueAdapter implements QueueAdapter { ... }
class BullMQWorkerAdapter implements WorkerAdapter { ... }
```

- Wraps real BullMQ `Queue` and `Worker` classes
- Implements `QueueAdapter` (from `src/queue/types.ts:123-140`) and `WorkerAdapter` (from `src/queue/types.ts:141-152`)
- Shares Redis connection via `RedisConnectionManager`
- Worker concurrency set from config

### 1.5 Goal Run Loop

**New file:** `src/runtime/run-goal.ts`

```typescript
async function runGoal(
  app: Application,
  goalDescription: string,
  options: { priority?: Priority; category?: GoalCategory; dryRun?: boolean }
): Promise<GoalResult>;
```

Orchestrates the full goal lifecycle: Director creates goal → decomposes into plan → materializes Phase 1 tasks → enqueues to BullMQ → worker processes → completion routing → Director reviews and advances → repeat until all phases done. Max iteration safety (default 50 cycles).

---

## Work Stream 2: Real Queue Infrastructure

**Goal:** Replace mock Redis/BullMQ with real infrastructure.

**Depends on:** WS1 (BullMQ adapters)

### 2.1 Docker Redis

**New file:** `docker-compose.yml`

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: [redis_data:/data]
    command: redis-server --appendonly yes
```

### 2.2 Enhanced Health Checks

**Modify:** `src/queue/task-queue.ts` `getHealth()` method

- Report real BullMQ metrics (waiting, active, completed, failed counts)
- Track worker latency (time from enqueue to processing start)
- Track processing time distribution

---

## Work Stream 3: Scheduler

**Goal:** Cron-based recurring pipeline triggers.

**Depends on:** WS1 (bootstrap), WS2 (real queue)

### 3.1 Scheduler Engine

**New file:** `src/scheduler/scheduler.ts`

```typescript
class Scheduler {
  constructor(config, director, queueManager, logger) {}
  start(): void;                          // Register all cron jobs
  stop(): void;                           // Unregister all
  addSchedule(entry: ScheduleEntry): void;
  removeSchedule(id: string): void;
  getNextFiring(id: string): Date | null;
  getActiveSchedules(): readonly ScheduleEntry[];
}
```

Uses a lightweight cron parser (not BullMQ repeatable jobs) because the scheduler needs decision logic: skip if pipeline already running, check budget before firing, log why it skipped.

Each cron tick: evaluate condition → create goal via Director → enqueue tasks.

### 3.2 Default Schedules

**New file:** `src/scheduler/default-schedules.ts`

| ID | Cron | Pipeline |
|----|------|----------|
| `daily-social` | `0 6 * * *` | Social Content |
| `daily-review` | `0 9 * * *` | Director Morning Review |
| `weekly-content` | `0 0 * * 1` | Content Production |
| `weekly-seo` | `0 0 * * 3` | SEO Audit Cycle |
| `monthly-cro` | `0 0 1 * *` | Conversion Sprint |
| `monthly-review` | `0 0 15 * *` | Performance Review |

### 3.3 Schedule Persistence

**Modify:** `src/workspace/workspace-manager.ts` — add `writeSchedule()`, `readSchedules()`
**Modify:** `src/types/workspace.ts` — add `schedules` to `WORKSPACE_DIRS`

---

## Work Stream 4: Event Bus

**Goal:** External events trigger reactive pipelines.

**Depends on:** WS1 (bootstrap), WS2 (real queue)

### 4.1 Event Bus Core

**New file:** `src/events/event-bus.ts`

```typescript
interface EventMapping {
  readonly eventType: EventType;
  readonly pipelineTemplate: string;
  readonly priority: Priority;
  readonly condition?: (event: SystemEvent) => boolean;
  readonly cooldownMs?: number;
}

class EventBus {
  constructor(mappings, director, queueManager, logger) {}
  emit(event: SystemEvent): Promise<void>;
  addMapping(mapping: EventMapping): void;
  removeMappingByEvent(eventType: EventType): void;
}
```

Uses existing `EventType` and `SystemEvent` types from `src/types/events.ts`.

### 4.2 Default Event Mappings

**New file:** `src/events/default-mappings.ts`

| Event | Pipeline | Priority | Condition |
|-------|----------|----------|-----------|
| `traffic_drop` | SEO Cycle | P1 | Drop > 20% |
| `conversion_drop` | Conversion Sprint | P0 | Drop > 10% |
| `competitor_launch` | Competitive Response | P1 | — |
| `new_feature_shipped` | Page Launch | P1 | — |
| `new_blog_post` | Content Production | P2 | — |

### 4.3 Webhook HTTP Receiver

**New file:** `src/events/webhook-server.ts`

- Uses `Bun.serve()` — zero external dependencies
- `POST /webhook` endpoint, parses `SystemEvent` JSON body
- Bearer token auth (simple for Phase 2; full auth deferred to Phase 5)
- `GET /health` endpoint for uptime monitoring

### 4.4 Internal Event Emitters

**Modify:** `src/queue/budget-gate.ts` — emit `budget_warning` / `budget_critical` events when thresholds crossed
**Modify:** `src/queue/failure-tracker.ts` — emit `pipeline_blocked` events on cascading failure detection

---

## Work Stream 5: Observability

**Goal:** Structured logging, cost tracking, execution metrics.

**Depends on:** Nothing (can start immediately in parallel)

### 5.1 Structured Logger

**New file:** `src/observability/logger.ts`

- Wraps `pino` for structured JSON logging
- `createLogger(config)` returns pino instance
- Child loggers per module: `logger.child({ module: "executor", taskId })`
- Replace all silent `catch {}` blocks across codebase with `logger.error()` calls

**Key integration points:**
- `src/queue/task-queue.ts` — enqueue, dequeue, failure
- `src/queue/worker.ts` — job start, completion, failure
- `src/director/director.ts` — goal creation, decomposition, review decisions
- `src/pipeline/pipeline-engine.ts` — step start/complete/fail
- `src/agents/executor.ts` — execution start, API call timing, completion
- `src/agents/claude-client.ts` — retry attempts, rate limits

### 5.2 Cost Tracker

**New file:** `src/observability/cost-tracker.ts`

```typescript
class CostTracker {
  record(entry: CostEntry): void;
  getTotalSpent(): number;
  getDailyReport(): string;               // Markdown report
  flush(): Promise<void>;                  // Write to metrics/{date}-budget.md
  toBudgetState(config): BudgetState;      // Replaces hardcoded budgetProvider
}
```

Accumulates real API costs from executor metadata. The `toBudgetState()` method replaces the current pattern where `budgetProvider` is a closure returning hardcoded state.

### 5.3 Execution Metrics

**New file:** `src/observability/metrics.ts`

- `MetricsCollector`: counts tasks/pipelines/goals, tracks durations, token usage, per-skill stats
- `writeReport()` persists to `metrics/{date}-report.md`

### 5.4 Health Monitor

**New file:** `src/observability/health-monitor.ts`

- Implements existing `SystemHealth` type from `src/types/health.ts`
- Aggregates queue health + budget state + system metrics
- Reports `DegradationLevel` (full → limited → minimal → offline)

---

## Work Stream 6: Memory System

**Goal:** Agents learn from past outcomes.

**Depends on:** Nothing (can start in parallel)

### 6.1 Learnings in Agent Prompts

**Modify:** `src/agents/prompt-builder.ts`

The infrastructure already exists — `workspace.appendLearning()` and `workspace.readLearnings()` are implemented, and the ReviewEngine + TaskQueueManager already write learnings on task completion/failure. What is **missing**: agents don't READ learnings before execution.

In `buildAgentPrompt()`:
1. Read `memory/learnings.md` from workspace
2. Filter learnings by current skill name (match `agent` field)
3. Append as `## Past Learnings` section in system prompt
4. Respect token limits — truncate oldest learnings first
5. Add `learningsIncluded: number` to `BuiltPrompt` return type

### 6.2 Director Reads Learnings Before Planning

**Modify:** `src/director/director.ts`

In `createGoal()` and `decomposeGoal()`: read learnings matching goal category. Include relevant learnings in decomposition context so the Director avoids repeating failed strategies.

### 6.3 Learning Enrichment (optional)

**Modify:** `src/types/workspace.ts` — extend `LearningEntry` with `tags: string[]`, `confidence: number`
**Modify:** `src/workspace/markdown.ts` — update serialization to include new fields

---

## New Files Summary

| File | Stream | Purpose |
|------|--------|---------|
| `src/config.ts` | WS1 | Runtime configuration from env |
| `src/bootstrap.ts` | WS1 | Application composition root |
| `src/cli.ts` | WS1 | CLI entry point |
| `src/runtime/run-goal.ts` | WS1 | Single-goal execution loop |
| `src/queue/bullmq-adapter.ts` | WS2 | Real BullMQ Queue/Worker adapters |
| `docker-compose.yml` | WS2 | Redis for local development |
| `src/scheduler/scheduler.ts` | WS3 | Cron-based pipeline scheduler |
| `src/scheduler/default-schedules.ts` | WS3 | Pre-built schedule definitions |
| `src/scheduler/index.ts` | WS3 | Barrel export |
| `src/events/event-bus.ts` | WS4 | Event processing + pipeline triggering |
| `src/events/default-mappings.ts` | WS4 | Default event-to-pipeline mappings |
| `src/events/webhook-server.ts` | WS4 | HTTP webhook receiver |
| `src/events/index.ts` | WS4 | Barrel export |
| `src/observability/logger.ts` | WS5 | Structured pino logger |
| `src/observability/cost-tracker.ts` | WS5 | API cost accumulation |
| `src/observability/metrics.ts` | WS5 | Execution metrics collection |
| `src/observability/health-monitor.ts` | WS5 | System health aggregation |
| `src/observability/index.ts` | WS5 | Barrel export |

## Key Files to Modify

| File | Stream | Change |
|------|--------|--------|
| `src/agents/executor.ts` | P0 | Add `outputPath` to ExecutionResult |
| `src/pipeline/pipeline-engine.ts` | P0 | Switch to modern executor |
| `src/queue/worker.ts` | P0 | Switch to modern executor |
| `src/queue/task-queue.ts` | P0 | Update executor import + deps type |
| `src/pipeline/types.ts` | P0 | Update ExecutionResult reference |
| `src/__tests__/e2e/helpers.ts` | P0 | Rewire test bootstrap |
| `src/executor/types.ts` | P1 | Deprecate DEFAULT_MODEL_MAP |
| `src/agents/prompt-builder.ts` | WS6 | Include learnings in prompt |
| `src/director/director.ts` | WS6 | Read learnings before planning |
| `src/queue/budget-gate.ts` | WS4 | Emit budget events |
| `src/queue/failure-tracker.ts` | WS4 | Emit failure events |
| `src/types/workspace.ts` | WS3/6 | Add schedules dir, extend LearningEntry |
| `src/workspace/workspace-manager.ts` | WS3 | Schedule persistence methods |
| `src/index.ts` | All | Export new modules |
| `package.json` | WS1/5 | Add pino + start script |

---

## Parallel Session Execution Plan

**Total: 9 sessions across 4 rounds. Max 3 sessions running in parallel.**

Each session runs as its own Claude Code instance on a dedicated feature branch. Sessions within a round have **zero file overlap** — no merge conflicts.

### Dependency Graph

```
ROUND 1 (3 parallel)          ROUND 2 (3 parallel)       ROUND 3 (2 parallel)    ROUND 4 (1)
+--------------+              +------------------+        +------------------+    +-----------+
| A: P0 + P1   |------------>| D: WS1 + WS2     |------->| G: Integration   |--->| I: Smoke  |
| Executor     |              | Entry point +    |        | Wiring + Logging |    | test +    |
| consolidation|              | Real queue infra |        | + Barrel exports |    | docs      |
+--------------+              +------------------+        +------------------+    +-----------+
                                                                  ^
+--------------+              +------------------+               |
| B: WS5 core  |------------>| E: WS3           |---------------+
| Observability|              | Scheduler        |
| (new files)  |              +------------------+
+--------------+
                              +------------------+
+--------------+              | F: WS4           |---------------+
| C: WS6       |------------>| Event bus +      |
| Memory system|              | Webhook          |
+--------------+              +------------------+
```

---

### ROUND 1 — Foundation (3 parallel sessions, no dependencies)

#### Session A: Executor Consolidation (P0 + P1)

| | |
|---|---|
| **Branch** | `feat/p0-executor-consolidation` |
| **Scope** | Migrate pipeline + queue from legacy to modern executor; deprecate `DEFAULT_MODEL_MAP` |

**Files owned (exclusive):**
- `src/agents/executor.ts` — add `outputPath` to `ExecutionResult`
- `src/pipeline/pipeline-engine.ts` — switch to modern executor + adapt calls
- `src/pipeline/types.ts` — update `ExecutionResult` import
- `src/queue/worker.ts` — switch to modern executor
- `src/queue/task-queue.ts` — update `TaskQueueManagerDeps` type
- `src/executor/types.ts` — deprecate `DEFAULT_MODEL_MAP`
- `src/__tests__/e2e/helpers.ts` — rewire bootstrap
- `src/agents/claude-client.ts` — ensure `MODEL_MAP` exported

**Verification:** `bun test` (938+ pass) + `bunx tsc --noEmit`

#### Session B: Observability Core (WS5 — new files only)

| | |
|---|---|
| **Branch** | `feat/observability-core` |
| **Scope** | Create observability module. New files only — do NOT integrate logging into existing modules (conflicts with Session A's files) |

**Files owned (exclusive):**
- `src/observability/logger.ts` — NEW (pino wrapper)
- `src/observability/cost-tracker.ts` — NEW (cost accumulation)
- `src/observability/metrics.ts` — NEW (execution metrics)
- `src/observability/health-monitor.ts` — NEW (system health)
- `src/observability/index.ts` — NEW (barrel export)
- `package.json` — add pino + pino-pretty

#### Session C: Memory System (WS6)

| | |
|---|---|
| **Branch** | `feat/memory-system` |
| **Scope** | Agents read past learnings before execution; Director reads learnings before goal decomposition |

**Files owned (exclusive):**
- `src/agents/prompt-builder.ts` — include learnings in prompt
- `src/director/director.ts` — read learnings before planning
- `src/types/workspace.ts` — extend `LearningEntry`
- `src/workspace/markdown.ts` — update serialization

**Verification:** `bun test` (938+ pass) + `bunx tsc --noEmit`

#### Round 1 Merge Order
1. Session A (P0) first — most foundational
2. Session C (WS6) second — extends types that Session B doesn't touch
3. Session B (WS5 core) last — adds pino to package.json

**Blocker for Round 2:** All 3 branches merged. P0 is the critical gate.

---

### ROUND 2 — Runtime Features (3 parallel sessions, depends on Round 1)

#### Session D: Entry Point + Real Queue (WS1 + WS2)

| | |
|---|---|
| **Branch** | `feat/runtime-entry-point` |
| **Scope** | Config, bootstrap, CLI, BullMQ adapters, goal run loop, Docker Redis, health checks |

**Files owned (exclusive):**
- `src/config.ts` — NEW (runtime configuration)
- `src/bootstrap.ts` — NEW (composition root)
- `src/cli.ts` — NEW (CLI entry point)
- `src/runtime/run-goal.ts` — NEW (goal execution loop)
- `src/queue/bullmq-adapter.ts` — NEW (real BullMQ adapters)
- `src/queue/task-queue.ts` — enhanced `getHealth()`
- `docker-compose.yml` — NEW (Redis)

#### Session E: Scheduler (WS3)

| | |
|---|---|
| **Branch** | `feat/scheduler` |
| **Scope** | Cron scheduler engine, default schedules, schedule persistence |

**Files owned (exclusive):**
- `src/scheduler/scheduler.ts` — NEW (cron engine)
- `src/scheduler/default-schedules.ts` — NEW (schedule definitions)
- `src/scheduler/index.ts` — NEW (barrel)
- `src/types/workspace.ts` — add `schedules` to `WORKSPACE_DIRS` only (do NOT touch `LearningEntry`)
- `src/workspace/workspace-manager.ts` — add schedule persistence

#### Session F: Event Bus (WS4)

| | |
|---|---|
| **Branch** | `feat/event-bus` |
| **Scope** | Event bus core, default mappings, webhook HTTP receiver, internal emitters |

**Files owned (exclusive):**
- `src/events/event-bus.ts` — NEW (event processing)
- `src/events/default-mappings.ts` — NEW (event mappings)
- `src/events/webhook-server.ts` — NEW (webhook receiver)
- `src/events/index.ts` — NEW (barrel)
- `src/queue/budget-gate.ts` — add event emission
- `src/queue/failure-tracker.ts` — add event emission

#### Round 2 Merge Order
1. Session D first — bootstrap needed by wiring in Round 3
2. Session E second
3. Session F third

**Blocker for Round 3:** All 3 branches merged.

---

### ROUND 3 — Integration (2 parallel sessions, depends on Round 2)

#### Session G: Wiring + Logging Integration + Barrel Exports

| | |
|---|---|
| **Branch** | `feat/integration-wiring` |
| **Scope** | Wire scheduler + event bus into bootstrap; integrate pino logger into all modules; update src/index.ts with all new exports |

**Files owned:**
- `src/bootstrap.ts` — wire scheduler + event bus
- `src/index.ts` — add ALL new barrel exports
- `src/queue/task-queue.ts` — add logger
- `src/queue/worker.ts` — add logger
- `src/director/director.ts` — add logger
- `src/pipeline/pipeline-engine.ts` — add logger
- `src/agents/executor.ts` — add logger
- `src/agents/claude-client.ts` — add logger
- `package.json` — add `start` script

#### Session H: Integration Tests

| | |
|---|---|
| **Branch** | `feat/integration-tests` |
| **Scope** | Full-stack E2E tests (all new files, no conflicts with Session G) |

**Files owned (exclusive — all new):**
- `src/__tests__/integration/setup.ts` — infra detection
- `src/__tests__/integration/real-redis.test.ts`
- `src/__tests__/integration/full-stack.test.ts`
- `src/__tests__/integration/scheduler.test.ts`
- `src/__tests__/integration/event-bus.test.ts`

#### Round 3 Merge Order
1. Session G first — wiring must exist before integration tests validate it
2. Session H second

---

### ROUND 4 — Validation (1 session, depends on Round 3)

#### Session I: Smoke Test + Docs Update

| | |
|---|---|
| **Branch** | `feat/phase2-validation` |
| **Scope** | End-to-end smoke test, create phase-2-status.md, update CLAUDE.md |

---

### Summary Table

| Round | Sessions | Parallel? | Branch Names | Blockers |
|-------|----------|-----------|--------------|----------|
| **1** | A, B, C | 3 parallel | `feat/p0-executor-consolidation`, `feat/observability-core`, `feat/memory-system` | None |
| **2** | D, E, F | 3 parallel | `feat/runtime-entry-point`, `feat/scheduler`, `feat/event-bus` | Round 1 merged |
| **3** | G, H | 2 parallel | `feat/integration-wiring`, `feat/integration-tests` | Round 2 merged |
| **4** | I | 1 session | `feat/phase2-validation` | Round 3 merged |

**Total: 9 sessions, 4 rounds, max 3 concurrent sessions**

---

### File Ownership Matrix (Conflict-Free Guarantee)

No cell has two letters in the same round. Files used across rounds are safe because rounds are sequential.

| Existing File | R1:A | R1:B | R1:C | R2:D | R2:E | R2:F | R3:G | R3:H |
|---------------|------|------|------|------|------|------|------|------|
| `src/agents/executor.ts` | **A** | | | | | | G | |
| `src/agents/claude-client.ts` | **A** | | | | | | G | |
| `src/agents/prompt-builder.ts` | | | **C** | | | | | |
| `src/pipeline/pipeline-engine.ts` | **A** | | | | | | G | |
| `src/pipeline/types.ts` | **A** | | | | | | | |
| `src/queue/worker.ts` | **A** | | | | | | G | |
| `src/queue/task-queue.ts` | **A** | | | **D** | | | G | |
| `src/queue/budget-gate.ts` | | | | | | **F** | | |
| `src/queue/failure-tracker.ts` | | | | | | **F** | | |
| `src/director/director.ts` | | | **C** | | | | G | |
| `src/executor/types.ts` | **A** | | | | | | | |
| `src/types/workspace.ts` | | | **C** | | **E** | | | |
| `src/workspace/markdown.ts` | | | **C** | | | | | |
| `src/workspace/workspace-manager.ts` | | | | | **E** | | | |
| `src/__tests__/e2e/helpers.ts` | **A** | | | | | | | |
| `src/index.ts` | | | | | | | **G** | |
| `package.json` | | **B** | | | | | **G** | |

---

### Merge Strategy

**Between rounds:**
1. Each session creates PR from feature branch to main
2. CI gate: `bun test` + `bunx tsc --noEmit`
3. Squash-merge in the order specified per round
4. Next round branches from updated main

**Within a round:** No coordination needed — file ownership is exclusive.

**Handling `src/types/workspace.ts` (R1:C then R2:E):** Session C extends `LearningEntry` and merges first. Session E branches from main AFTER Round 1, so it sees the updated type and only adds `schedules` to `WORKSPACE_DIRS`.

---

## New Dependencies

```json
{
  "dependencies": {
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "pino-pretty": "^11.0.0"
  }
}
```

No new queue/scheduler deps — `bullmq` and `ioredis` already in package.json. `Bun.serve()` handles HTTP for the webhook receiver.

---

## Verification Criteria

1. `bun test` — all 938+ existing tests pass after every change
2. `bunx tsc --noEmit` — type-check passes
3. `docker compose up -d && bun run start "Create a content strategy"` — full goal lifecycle with real Claude API + Redis
4. `bun run start --daemon` — scheduler fires, webhook endpoint responds, health endpoint works
5. New integration tests in `src/__tests__/integration/` validate real infrastructure paths

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Executor consolidation breaks 938 tests | High | Adapter layer maps modern → legacy result shape; run tests after each file change |
| Real Claude API costs during integration testing | Medium | Force haiku model + per-test budget cap (pattern established in `src/__tests__/e2e/real-api.test.ts`) |
| BullMQ + Bun runtime compatibility | Medium | Already in package.json v5.69.3; verify early in Week 1 |
| Redis connection instability in production | Medium | `FallbackQueue` already implemented; integration test covers kill/restart |
| Memory system increases prompt beyond context window | Low | Token counting and truncation already in modern executor; learnings truncated first |
