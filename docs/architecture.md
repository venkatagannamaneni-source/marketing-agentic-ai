# Architecture — Module Map

## Source Layout

```
src/
├── types/            # Shared type definitions (agent, task, pipeline, review, events, health, workspace)
├── workspace/        # File-based workspace manager (read/write tasks, outputs, reviews, learnings, schedules)
├── agents/           # Agent registry, skill loader, Claude client, model selector, prompt builder, executor
├── executor/         # Legacy executor (deprecated — kept for reference)
├── director/         # Marketing Director: goal decomposition, squad routing, review engine, escalation
├── pipeline/         # Sequential + parallel pipeline engine with concurrency control
├── queue/            # BullMQ adapter, budget gate, failure tracker, completion router, fallback queue
├── events/           # Event bus, default event mappings, webhook HTTP receiver
├── scheduler/        # Cron-based scheduler, default schedules, budget-gated firing
├── observability/    # Structured logger (pino), cost tracker, metrics collector, health monitor
├── runtime/          # Goal run loop (poll-based phase advancement)
├── config.ts         # Runtime configuration from env vars with validation
├── bootstrap.ts      # Application composition root (wires all 14 modules)
├── cli.ts            # CLI entry point (goal, pipeline, daemon modes)
├── __tests__/        # Top-level tests (config, bootstrap, CLI, runtime)
├── __tests__/e2e/    # End-to-end integration tests (11 suites)
└── index.ts          # Barrel export (all public API)
```

## Module Responsibilities

### types/
All TypeScript types and constants. No runtime logic. Defines: `Task`, `Review`, `Pipeline`, `AgentMeta`, `SystemEvent`, `ScheduleEntry`, `SystemHealth`, `WorkspaceConfig`.

### workspace/
`FileSystemWorkspaceManager` — CRUD for the shared file workspace. Handles: task serialization (markdown frontmatter), file locking, ID generation, validation, schedule state persistence. Directories: `context/`, `tasks/`, `outputs/`, `reviews/`, `metrics/`, `memory/`, `goals/`, `schedules/`.

### agents/
Registry of 26 skills loaded from `.agents/skills/`. `loadSkillMeta()` reads SKILL.md headers. `AGENT_DEPENDENCY_GRAPH` defines skill-to-skill edges. `PIPELINE_TEMPLATES` provides 8 pre-built pipeline definitions. `AnthropicClaudeClient` wraps the Claude API. `AgentExecutor` (unified) runs: load skill, build prompt (with learnings), call Claude, parse output, write to workspace. `MODEL_MAP` is the single source of truth for model IDs and costs.

### executor/
Legacy executor from Phase 1 Tasks 1-6. Deprecated after P0 consolidation — kept for reference. The modern unified executor lives in `agents/executor.ts`.

### director/
`MarketingDirector` — the supervisor agent. `GoalDecomposer` breaks goals into phased task lists. `routeGoal()` + `selectSkills()` map goals to squads/skills. `PipelineFactory` converts task lists into pipeline definitions. `ReviewEngine` evaluates outputs (structural checks). `EscalationEngine` handles budget overruns, repeated failures, quality issues. `HumanReviewManager` tracks escalations requiring human input.

### pipeline/
`SequentialPipelineEngine` — runs pipeline steps in order or parallel (configurable concurrency). Handles: step execution, output passing between steps, failure modes (fail-fast or continue), run tracking.

### queue/
`TaskQueueManager` — BullMQ-based priority queue (P0-P3 mapped to 1-4). `BudgetGate` — checks spend limits before execution. `FailureTracker` — counts failures, triggers cascade pause after threshold. `CompletionRouter` — routes finished tasks to next step or review. `FallbackQueue` — file-based queue when Redis unavailable. `BullMQQueueAdapter` + `BullMQWorkerAdapter` — real BullMQ implementations.

### events/
`EventBus` processes external events (traffic drops, competitor launches, etc.) and triggers pipelines through the Director. `DEFAULT_EVENT_MAPPINGS` defines 5 event-to-pipeline rules with conditions, cooldowns, and deduplication. `createWebhookServer()` provides an HTTP receiver using `Bun.serve()` with bearer token auth and health endpoint.

### scheduler/
`Scheduler` runs cron-based recurring pipeline triggers with 6 default schedules (daily social, daily review, weekly content, weekly SEO, monthly CRO, monthly performance). `parseCron()` and `cronMatches()` provide deterministic cron evaluation. Budget gating prevents low-priority schedules from firing during budget pressure. Overlap protection prevents re-fire while a pipeline is still running. State persisted to workspace for catch-up on restart.

### observability/
`createLogger()` wraps pino for structured JSON/pretty logging with child logger support. `CostTracker` accumulates API costs and drives `BudgetState` transitions (normal → warning → throttle → critical → exhausted). `MetricsCollector` tracks execution counts, durations, token usage per skill. `HealthMonitor` aggregates component health into `SystemHealth` with degradation levels.

### runtime/
`runGoal()` orchestrates the full goal lifecycle: create goal → decompose → materialize tasks → enqueue → poll for completion → advance phases → return result. Budget checking and max-iteration safety (50 cycles). `inferCategory()` maps natural language goals to `GoalCategory`. Supports dry-run mode for plan-only execution.

### config.ts
`loadConfig()` reads from env vars (`ANTHROPIC_API_KEY`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `WORKSPACE_DIR`, `BUDGET_MONTHLY`, `LOG_LEVEL`, `LOG_FORMAT`, `MAX_PARALLEL_AGENTS`), validates required fields, and returns a frozen `RuntimeConfig`. `ConfigError` provides field-specific validation errors.

### bootstrap.ts
The composition root. `bootstrap(config)` wires all 14 modules in dependency order: logger → workspace → Claude client → executor → cost tracker → director → pipeline engine → Redis → BullMQ queue/worker → event bus → scheduler. Returns an `Application` object with `start()` and `shutdown()` lifecycle methods. Registers SIGTERM/SIGINT handlers with dedup guard.

### cli.ts
`parseArgs()` handles three modes: single goal (`bun run start "goal"`), named pipeline (`--pipeline "Template"`), daemon (`--daemon`). Flags: `--priority P0-P3`, `--dry-run`, `--help`. Wires config → bootstrap → mode-specific execution.

## Key Interfaces

- `WorkspaceManager` — abstract interface for workspace operations
- `ClaudeClient` — abstract interface for Claude API calls (has mock + real implementations)
- `QueueAdapter` / `WorkerAdapter` — abstract BullMQ interfaces (allows mock Redis)
- `Application` — the composed application with all modules and `start()`/`shutdown()` lifecycle
- `RuntimeConfig` — frozen configuration from env vars
- `Logger` — structured logging interface (pino wrapper + BufferLogger for tests)
- `CostTracker` — cost accumulation and budget state derivation
- `EventMapping` — maps event types to pipeline templates with conditions and cooldowns
- `GoalResult` — result of a full goal run (status, tasks, cost, phases, duration)

## Dependency Flow

```
types (no deps)
  ↓
workspace (depends on: types)
  ↓
agents (depends on: types, workspace, skill files on disk)
  ↓
director (depends on: types, workspace, agents)
pipeline (depends on: types, agents)
  ↓
queue (depends on: types, agents, pipeline)
  ↓
events (depends on: types, director, queue)
scheduler (depends on: types, director, workspace, observability)
observability (depends on: types)
  ↓
config (no source deps — reads env)
  ↓
bootstrap (depends on: ALL modules above)
  ↓
runtime (depends on: bootstrap, director, queue, observability)
  ↓
cli (depends on: config, bootstrap, runtime)
```
