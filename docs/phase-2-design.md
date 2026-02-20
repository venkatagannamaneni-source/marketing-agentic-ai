# Phase 2 Design — 24/7 Runtime Engine

**Status:** Design complete, implementation not started
**Scope:** Weeks 5-8 of [PROJECT_PROPOSAL.md](../PROJECT_PROPOSAL.md)
**Pre-condition:** Phase 1 complete (938 tests, 8 modules, all mocked)

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

## Implementation Order

```
Week 1: P0 (executor consolidation) + WS5.1 (logger) + WS6.1 (learnings in prompts)
         |-- P0 is the critical path blocker
         |-- WS5.1 and WS6.1 are independent, can parallelize
         +-- Run full test suite after P0

Week 2: WS1.1-1.4 (config, bootstrap, CLI, BullMQ adapters) + WS5.2 (cost tracker)
         |-- WS1 is sequential: config -> adapters -> bootstrap -> CLI
         +-- WS5.2 can parallelize alongside WS1

Week 3: WS1.5 (run loop) + WS3 (scheduler) + WS4 (event bus)
         |-- All three depend on WS1 bootstrap being done
         +-- All three are independent of each other, parallelize

Week 4: WS2 (Docker Redis) + integration tests + WS5.3-5.4 (metrics, health)
         |-- Real Redis needed for integration testing
         +-- Full-stack E2E test validates Phase 2 complete
```

### Parallelization Map

| Track A (Critical Path) | Track B (Independent) |
|---|---|
| P0: Executor consolidation | WS5.1: Structured logger |
| WS1.1: Config system | WS6.1: Learnings in prompts |
| WS1.4: BullMQ adapters | WS5.2: Cost tracker |
| WS1.3: Bootstrap | WS6.2: Director learnings |
| WS1.2: CLI entry point | WS3: Scheduler |
| WS1.5: Goal run loop | WS4: Event bus |
| Integration tests | WS5.3-5.4: Metrics + health |

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
