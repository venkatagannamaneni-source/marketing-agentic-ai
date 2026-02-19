# Architecture Review — Phase 1 Codebase

**Reviewer:** Claude (Architecture Review)
**Date:** 2026-02-19
**Scope:** All 7 modules in `src/`, 784 tests, 26 agent skills, project design

---

## 1. Design Principles the Current System Is Built On

After reading every significant file, these are the principles driving the architecture:

| Principle | How It's Applied |
|-----------|-----------------|
| **Dependency injection everywhere** | `ClaudeClient`, `QueueAdapter`, `WorkerAdapter`, `WorkspaceManager` — all abstract interfaces. Concrete implementations swapped for mocks in tests. |
| **Never throw from top-level orchestration** | Pipeline engine and executor always return result objects (not exceptions). Errors are data, not control flow. |
| **File-based state as source of truth** | All tasks, outputs, reviews, and learnings persist as markdown files with YAML frontmatter. No in-memory-only state. |
| **Template-first decomposition** | Director tries to match a pre-built pipeline template before falling back to custom goal decomposition. Predictable behavior over creative routing. |
| **Graceful degradation by design** | Budget tiers (normal → warning → throttle → critical → exhausted), Redis fallback queue, cascade failure detection, stale lock cleanup. |
| **Separation of structural vs semantic validation** | Review engine does fast pattern checks first; Claude Opus semantic review is layered on top (opt-in). |
| **Immutable types, mutable state tracking** | Most interfaces use `readonly`. Task status and PipelineRun are the intentional exceptions — mutated in-place during execution. |

---

## 2. What's Working Well

### 2.1 Type System (Strong Foundation)
The `types/` module is clean and well-designed. The `as const` arrays with derived union types (`SquadName`, `SkillName`, `Priority`, etc.) give compile-time safety with zero runtime overhead. The `SKILL_SQUAD_MAP` record is exhaustive — adding a new skill without mapping it is a compile error.

### 2.2 Workspace Manager (Production-Quality)
`FileSystemWorkspaceManager` is the most production-ready module:
- Path traversal protection (`resolveSafe()`)
- File locking via atomic `mkdir` (cross-process safe)
- Stale lock cleanup (60s threshold)
- TOCTOU-safe `updateTaskStatus` (read+write under single lock)
- Clean separation of serialization (`markdown.ts`) from I/O (`workspace-manager.ts`)

### 2.3 Pipeline Engine (Well-Architected)
`SequentialPipelineEngine` handles sequential, parallel, and review steps cleanly. The `runWithConcurrency()` utility is properly built with fail-fast semantics, child abort controllers, and result ordering. Never throws — always returns `PipelineResult`.

### 2.4 Queue Module (Thoughtful Resilience)
The BullMQ adapter layer is well-designed:
- Budget gate checked at both enqueue time and processing time (double-check pattern)
- Fallback queue bridges Redis outages
- Failure tracker detects cascading failures per-pipeline
- Completion router closes the Director → Queue → Executor → Director loop

### 2.5 Test Coverage
784 tests with 2,115 assertions is thorough for a Phase 1 foundation. The E2E tests prove two full orchestration paths (pipeline and queue), and the `bootstrapE2E()` helper is well-structured for wiring all 7 modules together.

---

## 3. Issues and Technical Debt

### 3.1 CRITICAL: Dual Executor Problem

**The single biggest architectural issue in the codebase.**

There are **two separate `AgentExecutor` classes** with **two separate `ClaudeClient` interfaces**:

| | `src/agents/` (Task 7) | `src/executor/` (Tasks 1-6) |
|---|---|---|
| **Executor class** | `AgentExecutor` in `executor.ts` | `AgentExecutor` in `agent-executor.ts` |
| **Client interface** | `ClaudeClient.createMessage(ClaudeMessageParams)` | `ClaudeClient.complete(ClaudeRequest)` |
| **Error class** | `ExecutionError(msg, code, retryable)` | `ExecutionError(msg, code, taskId, cause)` |
| **Result type** | `ExecutionResult` (with `metadata.estimatedCost`) | `ExecutionResult` (with `tokensUsed`, `status`, `error`) |
| **Retry logic** | In client (`callWithRetry`) | In executor (`executeWithRetries`) |
| **Used by** | `MarketingDirector.executeAndReviewTask()` | `SequentialPipelineEngine`, `TaskQueueManager`, `CompletionRouter` |

**Impact:** The E2E test helper (`bootstrapE2E`) creates **two different mock clients** and has to cast types at the boundaries. The `index.ts` barrel export uses aliases (`AgentClaudeClient`, `ModularAgentExecutor`, `LegacyAnthropicClaudeClient`) to avoid naming collisions. This split will multiply bugs as the codebase grows.

**Recommendation:** Consolidate to **one executor** with one `ClaudeClient` interface. The `src/agents/` version is more modern (budget-aware, model-selecting), but the `src/executor/` version has better retry logic (cancellable, with abort signals). Merge the best of both.

### 3.2 HIGH: Director Does Its Own Serialization

`director.ts` has its own `serializeGoal()` / `deserializeGoal()` and `serializeGoalPlan()` functions that duplicate the frontmatter pattern from `workspace/markdown.ts` — but with a **different parser** (custom regex vs. the shared `parseFrontmatter()`). The director also creates a `goals/` directory that's not part of the standard `WORKSPACE_DIRS`:

```typescript
// director.ts:196 — creating directory outside workspace conventions
await mkdir(resolve(this.workspace.paths.root, "goals"), { recursive: true });
```

**Impact:** Goals bypass workspace validation, locking, and path safety. If a goal file is corrupted, it'll throw a raw `Error` instead of a `WorkspaceError`. The `WorkspaceManager` interface has no `writeGoal` / `readGoal` methods, so the director reaches into the filesystem directly.

**Recommendation:** Add `goals/` to `WORKSPACE_DIRS`. Add `writeGoal()`, `readGoal()`, `listGoals()` to `WorkspaceManager`. Reuse `parseFrontmatter()` for goal files.

### 3.3 HIGH: Review Engine Code Duplication

`ReviewEngine` has two nearly identical methods:
- `evaluateTask()` — structural only (sync-ish)
- `evaluateTaskSemantic()` — structural + Claude Opus

Both methods contain the same 20+ lines of structural validation logic (empty check, short check, structure check, verdict determination, revision request building, escalation check, learning generation). The `buildDecisionFromFindings()` private method was added to reduce this, but the structural checks themselves are still duplicated between the two entry points.

**Recommendation:** Extract structural validation into a single `runStructuralChecks(task, output)` method. Both `evaluateTask` and `evaluateTaskSemantic` should call it.

### 3.4 MEDIUM: `listTasks()` Reads Every File Sequentially

```typescript
// workspace-manager.ts:227-243
async listTasks(filter?: TaskFilter): Promise<Task[]> {
  const files = await this.listFiles("tasks");
  const tasks: Task[] = [];
  for (const file of files) {
    const content = await this.readFile(`tasks/${file}`);
    // ...deserialize, filter...
  }
  return tasks;
}
```

This reads **every task file from disk, deserializes it, then filters in memory**. At scale (hundreds of goals, thousands of tasks), this becomes a bottleneck. The `advanceGoal()` method compounds this by calling `listTasks()` with no filter and then filtering by `goalId` in application code:

```typescript
// director.ts:451
const allTasks = await this.workspace.listTasks();
const goalTasks = allTasks.filter((t) => t.goalId === goalId);
```

**Recommendation:** For Phase 2, add an index (a simple JSON file mapping goalId → taskIds) or migrate task state to SQLite/PostgreSQL. For now, add a `goalId` field to `TaskFilter` and implement filename-based filtering in the workspace.

### 3.5 MEDIUM: Hardcoded Model IDs

```typescript
// agents/claude-client.ts:57-61
export const MODEL_MAP: Record<ModelTier, string> = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-20250514",
};
```

Model IDs are hardcoded in two places (`agents/claude-client.ts` and `executor/types.ts`). When Claude 5 ships, you'll need to update multiple files.

**Recommendation:** Single source of truth in `types/agent.ts` or a config file. Ideally, model IDs come from environment variables or a config object at startup.

### 3.6 MEDIUM: No Task State Machine

Task status can be set to any valid status at any time:

```typescript
// workspace-manager.ts:246
async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>
```

There's no validation that `pending → in_progress` is valid but `completed → pending` is not. The 11 task statuses (`pending`, `assigned`, `in_progress`, `completed`, `in_review`, `revision`, `approved`, `failed`, `blocked`, `cancelled`, `deferred`) have implicit transition rules that are scattered across the director, executor, pipeline, and queue modules.

**Recommendation:** Define a `VALID_TRANSITIONS` map and enforce it in `updateTaskStatus()`. This prevents bugs where a task gets accidentally moved backward.

### 3.7 MEDIUM: Timestamp Strings Instead of Dates

Every timestamp in the system is `string` (`new Date().toISOString()`):

```typescript
interface Task {
  readonly createdAt: string;  // "2026-02-19T12:34:56.789Z"
  readonly updatedAt: string;
}
```

This means sorting by time, computing durations, or checking deadlines requires parsing strings everywhere. No typed distinction between an ISO timestamp and any other string.

**Recommendation:** Keep ISO strings for serialization, but consider a branded type (`type ISOTimestamp = string & { __brand: 'ISOTimestamp' }`) with a factory function that validates format. Alternatively, defer this until the DB migration (PostgreSQL will handle timestamps natively).

### 3.8 LOW: Markdown as a Data Format Has Limits

The frontmatter-based markdown serialization is clever for human-readability, but:
- The `metadata` field uses `JSON.stringify()` embedded in YAML, which breaks if metadata contains colons
- Complex nested data (arrays of objects) can't be represented in the simple `key: value` frontmatter format
- Deserialization relies on regex parsing of markdown body sections (`extractSection`, `extractFindings`), which is fragile if Claude outputs markdown with similar headings

**Impact:** Low for Phase 1 (mocked outputs). Higher risk when real Claude outputs contain headings like `## Findings` that collide with the review format parser.

**Recommendation:** Accept for now. When moving to production, serialize structured data as JSON or use a proper DB. Keep markdown only for human-facing outputs.

### 3.9 LOW: No Observability Hooks

There's no logging, metrics, or tracing anywhere. The `onStatusChange` and `onStepComplete` callbacks in `PipelineEngineConfig` exist but are optional and unused outside tests.

**Recommendation:** Add a structured logger interface (`Logger { info, warn, error }`) that every module accepts. Default to no-op. Wire a real logger in Phase 2.

---

## 4. Flexibility Assessment — Can This Accommodate Future Changes?

### Easy to Change (Well-Isolated)

| Change | Why It's Easy |
|--------|--------------|
| **Add a new skill / agent** | Add directory to `.agents/skills/`, add name to `SKILL_NAMES`, add squad mapping. Everything else discovers it. |
| **Add a new squad** | Add to `SQUAD_NAMES`, update `SKILL_SQUAD_MAP`, add routing rules. Types enforce exhaustiveness. |
| **Change pipeline templates** | Modify `PIPELINE_TEMPLATES` array in `registry.ts`. Templates are data, not code. |
| **Change budget thresholds** | Modify `DEFAULT_DIRECTOR_CONFIG.budget`. Pure config. |
| **Change routing rules** | Modify `ROUTING_RULES` in `squad-router.ts`. Static data. |
| **Swap workspace backend** | Implement `WorkspaceManager` interface for PostgreSQL. Zero changes to consumers. |
| **Swap queue backend** | Implement `QueueAdapter` / `WorkerAdapter` for a different queue. Zero changes to `TaskQueueManager`. |

### Moderately Difficult to Change (Some Refactoring Needed)

| Change | Why It's Harder |
|--------|----------------|
| **Add a new task status** | Must add to `TASK_STATUSES`, update the implicit state machine in 4+ modules (executor, director, pipeline, queue), update serialization. |
| **Change the task format** | `serializeTask` / `deserializeTask` plus every test that creates tasks. The markdown format touches ~15 files. |
| **Real Claude API integration** | Must resolve the dual executor problem first. Two different `ClaudeClient` interfaces = two different integration paths. |
| **Multi-tenant isolation** | Workspace paths are a single root directory. Need per-tenant workspace roots and queue namespacing. |

### Hard to Change (Architectural)

| Change | Why It's Hard |
|--------|--------------|
| **Switch from file workspace to DB** | The workspace is the backbone. `WorkspaceManager` interface helps, but consumers also directly read/write paths (director's `goals/` directory, output paths embedded in task metadata). Full migration needed. |
| **Event-driven architecture** | Currently pull-based (queue dequeues). Adding a pub/sub event bus requires threading event emitters through every module. |
| **Streaming / real-time output** | Claude API calls are synchronous (request → response). Streaming would require rethinking the executor and how outputs are written. |

---

## 5. Recommendations (Prioritized)

### Must-Do Before Phase 2

| # | What | Why | Effort |
|---|------|-----|--------|
| 1 | **Consolidate the two executors** into a single `AgentExecutor` with one `ClaudeClient` interface | Blocks real API integration. Every consumer needs one interface. | 2-3 days |
| 2 | **Move goals into WorkspaceManager** | Goals bypass workspace safety (locking, validation, path protection). Will cause bugs. | 1 day |
| 3 | **Add a task state machine** | Prevents invalid state transitions that will be hard to debug in a 24/7 system. | 0.5 days |

### Should-Do During Phase 2

| # | What | Why | Effort |
|---|------|-----|--------|
| 4 | **Add structured logging interface** | Can't debug a running system without logs. Every module should accept a `Logger`. | 1 day |
| 5 | **Add `goalId` to `TaskFilter`** | `advanceGoal()` currently reads ALL tasks. Will be O(n) at scale. | 0.5 days |
| 6 | **Centralize model ID configuration** | Hardcoded in two places. Should be one config source. | 0.5 days |
| 7 | **Extract structural review checks** | Reduces duplication in `ReviewEngine`, easier to extend validation rules. | 0.5 days |

### Should-Do Before Production (Phase 3+)

| # | What | Why | Effort |
|---|------|-----|--------|
| 8 | **Replace file workspace with DB for tasks** | File I/O doesn't scale. Keep file workspace for outputs (large text), move task/review/goal metadata to PostgreSQL. | 1-2 weeks |
| 9 | **Add integration test with real Claude API** | 784 tests and zero real API calls. Need at least one test that proves the full flow works. | 1 day |
| 10 | **Define output schemas per skill** | Review engine currently checks for "has headings" and "has 3 lines". Real quality validation needs per-skill output schemas. | 1 week |

---

## 6. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Dual executor causes bugs when wiring real API | **High** | **High** | Consolidate before Phase 2 |
| File workspace bottleneck at scale | Medium | High | Plan DB migration, add indexes |
| Claude outputs fail structural review (false rejects) | **High** | Medium | Build per-skill validation, not generic checks |
| Budget tracking drift (estimated cost vs actual) | Medium | Medium | Reconcile with real API billing data |
| Task state corruption (no state machine) | Medium | High | Add transition validation |
| Stale locks from crashes | Low | Medium | Already has 60s stale cleanup — good |

---

## 7. Summary for Decision-Making

**In plain language, here's where things stand:**

### What you have
A well-tested TypeScript library (784 tests) that models a marketing team of 26 AI agents. It can decompose goals, route them to the right agents, run pipelines with concurrency control, track failures, manage budgets, and review outputs. All on paper — with mock data, no real AI calls.

### The one thing blocking progress
There are **two separate executor systems** that do the same job but with incompatible interfaces. This happened because the modules were built in sequence (executor first, then a newer "agents" module later). Everything that matters — pipeline engine, queue, completion router — uses the old one. The director uses the new one. They can't talk to each other without adapter glue. **Fix this first.**

### What's genuinely good
- The type system will catch bugs as you change things (exhaustive checks, readonly types, union types)
- The workspace manager is production-quality (path safety, locking, validation)
- The dependency injection design means you can swap mock Redis for real Redis, mock Claude for real Claude, and mock filesystem for a database — without rewriting business logic
- The pipeline and queue modules are well-thought-out for resilience (fallback queue, cascade detection, budget gating)

### What's not yet tested in reality
- Zero real Claude API calls have been made. The mock always returns "APPROVE." Real Claude will produce unpredictable outputs that may fail structural validation
- The review engine checks for "has headings" and "has 3+ lines" — this will approve garbage and reject good outputs. Per-skill validation schemas are needed
- File I/O for task listing (reads every file, deserializes, then filters) will slow down once you have hundreds of tasks

### The three decisions you need to make

1. **Consolidate executors now or later?** — Now is cheaper (2-3 days). Later means everything built on top inherits the split.

2. **File workspace or database for Phase 2?** — Files work for dev/demo. If you want 24/7 runtime with hundreds of tasks, plan the DB migration. The `WorkspaceManager` interface makes this doable without rewriting consumers.

3. **When to make the first real Claude API call?** — The mock-only approach got you to 784 tests, but every day without a real integration test is a day you might be building on wrong assumptions about output format, token usage, and cost.
