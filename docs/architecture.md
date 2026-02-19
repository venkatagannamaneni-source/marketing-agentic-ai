# Architecture — Module Map

## Source Layout

```
src/
├── types/          # Shared type definitions (agent, task, pipeline, review, events, health, workspace)
├── workspace/      # File-based workspace manager (read/write tasks, outputs, reviews, learnings)
├── agents/         # Agent registry, skill loader, Claude client, model selector, prompt builder
├── executor/       # Agent executor: loads skill → builds prompt → calls Claude → writes output
├── director/       # Marketing Director: goal decomposition, squad routing, review engine, escalation
├── pipeline/       # Sequential + parallel pipeline engine with concurrency control
├── queue/          # BullMQ adapter: budget gate, failure tracker, completion router, fallback queue
├── __tests__/e2e/  # 6 end-to-end integration test suites
└── index.ts        # Barrel export (all public API)
```

## Module Responsibilities

### types/
All TypeScript types and constants. No runtime logic. Defines: `Task`, `Review`, `Pipeline`, `AgentMeta`, `SystemEvent`, `SystemHealth`, `WorkspaceConfig`.

### workspace/
`FileSystemWorkspaceManager` — CRUD for the shared file workspace. Handles: task serialization (markdown frontmatter), file locking, ID generation, validation. Directories: `context/`, `tasks/`, `outputs/`, `reviews/`, `metrics/`, `memory/`.

### agents/
Registry of 26 skills loaded from `.agents/skills/`. `loadSkillMeta()` reads SKILL.md headers. `AGENT_DEPENDENCY_GRAPH` defines skill→skill edges. `PIPELINE_TEMPLATES` provides 8 pre-built pipeline definitions. `AnthropicClaudeClient` wraps the Claude API. `AgentExecutor` (modular) runs: load skill → build prompt → call Claude → parse output.

### executor/
Legacy executor (Tasks 1-6). `AgentExecutor` — loads skill content, builds prompt with upstream outputs, calls Claude, retries on failure, writes results. `MockClaudeClient` for testing.

### director/
`MarketingDirector` — the supervisor agent. `GoalDecomposer` breaks goals into phased task lists. `routeGoal()` + `selectSkills()` map goals to squads/skills. `PipelineFactory` converts task lists into pipeline definitions. `ReviewEngine` evaluates outputs (structural checks). `EscalationEngine` handles budget overruns, repeated failures, quality issues.

### pipeline/
`SequentialPipelineEngine` — runs pipeline steps in order or parallel (configurable concurrency). Handles: step execution, output passing between steps, failure modes (fail-fast or continue), run tracking.

### queue/
`TaskQueueManager` — BullMQ-based priority queue (P0-P3 mapped to 1-4). `BudgetGate` — checks spend limits before execution. `FailureTracker` — counts failures, triggers cascade pause after threshold. `CompletionRouter` — routes finished tasks to next step or review. `FallbackQueue` — in-memory queue when Redis unavailable.

## Key Interfaces

- `WorkspaceManager` — abstract interface for workspace operations
- `ClaudeClient` — abstract interface for Claude API calls (has mock + real implementations)
- `QueueAdapter` / `WorkerAdapter` — abstract BullMQ interfaces (allows mock Redis)
- `ProcessorFn` — worker processor function signature

## Dependency Flow

```
types (no deps)
  ↓
workspace (depends on: types)
  ↓
agents (depends on: types, workspace, skill files on disk)
executor (depends on: types, workspace)
  ↓
director (depends on: types, workspace, agents)
pipeline (depends on: types, executor)
  ↓
queue (depends on: types, executor, pipeline)
```
