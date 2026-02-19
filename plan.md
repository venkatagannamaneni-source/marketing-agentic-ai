# Task 5: Parallel Execution — Implementation Plan

## Summary

Replace the sequential fallback in `executeParallelStepSequentially()` with true concurrent execution featuring:
- **Configurable concurrency limit** (default 3, via `PipelineEngineConfig`)
- **Active fail-fast cancellation** via child `AbortController`
- **Standalone concurrency utility** in `src/pipeline/concurrency.ts`

---

## Files to Create

### 1. `src/pipeline/concurrency.ts` — Reusable concurrency utility

A standalone `runWithConcurrency<T>()` function that:
- Accepts an array of async task functions `(() => Promise<T>)[]`
- Accepts `maxConcurrency: number` and optional `AbortSignal`
- Runs up to N tasks at a time using a semaphore/slot pattern
- On **first failure** (determined by a caller-provided `isFailed` predicate), aborts all in-flight tasks via a child `AbortController` and stops launching new ones
- Returns results in **input order** (not completion order) — preserves deterministic result ordering
- Creates a child `AbortController` internally that combines the parent signal with its own fail-fast abort

**Interface:**
```ts
interface ConcurrencyOptions<T> {
  tasks: ReadonlyArray<(signal: AbortSignal) => Promise<T>>;
  maxConcurrency: number;
  signal?: AbortSignal;
  isFailed: (result: T) => boolean;
}

interface ConcurrencyResult<T> {
  results: T[];                    // ordered by input index, only populated slots
  firstFailureIndex: number | null;
  aborted: boolean;                // true if parent signal caused the abort
}
```

**Implementation approach — slot-based semaphore:**
- Pre-allocate a results array of `tasks.length` slots (initially `undefined`)
- Create a child `AbortController` — if parent signal fires, child also aborts
- Maintain an index counter for the next task to launch
- Launch up to `maxConcurrency` tasks initially, each as a racing promise
- When any task settles: fill its slot in the results array
  - If the result passes `isFailed()`: signal the child `AbortController`, mark `firstFailureIndex`
  - If not failed and not aborted: launch the next pending task (if any)
- When all launched tasks have settled (or all remaining have been aborted): return
- Return only the results that were populated (filter out `undefined` for tasks never started)

**Edge cases:**
- `tasks.length === 0` → return `{ results: [], firstFailureIndex: null, aborted: false }`
- `maxConcurrency >= tasks.length` → all tasks launch immediately
- `maxConcurrency === 1` → degrades to sequential execution
- Parent signal already aborted → return immediately with `aborted: true`
- Task function throws (rather than returning failed result) → catch it, re-throw? No — the pipeline engine's executor never throws, but the utility should be robust. Wrap each task in try/catch and let the isFailed predicate handle the result. Actually, if the task throws, that's an unexpected error. The utility should catch it and store it so the caller can inspect. For our use case, executor.execute() never throws, so this is a safety net.

**Key design decision:** Each task function receives a `signal: AbortSignal` parameter. This is the child controller's signal, which fires on either parent abort OR fail-fast. The pipeline engine passes this to `executor.execute(task, { signal })`.

### 2. `src/pipeline/__tests__/concurrency.test.ts` — Unit tests for concurrency utility

Test the utility in isolation:
- **Happy path**: 5 tasks, concurrency=3, all succeed → results in input order, length 5
- **Concurrency enforcement**: 5 tasks with concurrency=2 — use an active-count tracker to prove max 2 run simultaneously
- **Fail-fast**: task index 2 of 5 fails → tasks not yet started are skipped, in-flight tasks receive abort signal
- **Fail-fast result shape**: `firstFailureIndex` is set, `results` contains completed + failed but not unattempted tasks
- **Parent abort**: abort signal fires mid-execution → `aborted: true`, in-flight tasks cancelled
- **Parent abort already fired**: signal pre-aborted → returns immediately with `aborted: true, results: []`
- **Concurrency=1**: degrades to strictly sequential — tasks run one at a time in order
- **Empty tasks array**: returns `{ results: [], firstFailureIndex: null, aborted: false }`
- **Single task**: runs it, returns single-element results
- **maxConcurrency > task count**: all tasks launch immediately, works fine
- **Multiple failures**: only the first triggers fail-fast — `firstFailureIndex` is the earliest failing index

### 3. `src/pipeline/__tests__/helpers.ts` — Add concurrency tracking helper

Add a `createConcurrencyTrackingClient()` helper:
```ts
function createConcurrencyTrackingClient(options?: {
  delayMs?: number;
  failAtCall?: number;
}): { client: MockClaudeClient; getMaxConcurrent: () => number; getConcurrentNow: () => number }
```

This creates a MockClaudeClient that:
- Introduces an artificial delay per call (configurable, default ~50ms)
- Tracks the peak concurrent call count via an increment/decrement counter
- Returns functions to query peak and current concurrency
- Optionally fails at a specific call number

This enables pipeline-engine-level tests to verify concurrency limits are respected.

---

## Files to Modify

### 4. `src/pipeline/types.ts` — Add `maxConcurrency` to config

Add one optional field to `PipelineEngineConfig`:
```ts
interface PipelineEngineConfig {
  // ... existing fields unchanged ...
  readonly maxConcurrency?: number;  // Default: 3. Max parallel agents per step.
}
```

No changes to `StepResult`, `PipelineResult`, `PipelineError`, or `PipelineErrorCode`.

### 5. `src/pipeline/pipeline-engine.ts` — Replace sequential fallback with real parallelism

**Changes:**
1. Import `runWithConcurrency` from `./concurrency.ts`
2. Add `DEFAULT_MAX_CONCURRENCY = 3` constant
3. Rename `executeParallelStepSequentially` → `executeParallelStep`
4. Rewrite the method body:

**New `executeParallelStep()` logic:**
```
a. Create tasks via factory.createTasksForStep() — same as before
b. Record ALL task IDs on run.taskIds upfront — before any execution starts
   (This is different from the current code which interleaves recording with execution.
    Moving it upfront eliminates race conditions on run.taskIds.)
c. Persist ALL tasks to workspace sequentially — before any execution starts
   (Same rationale: workspace writes must complete before execution begins.
    Sequential persistence is fine — it's cheap I/O, not API calls.)
d. Build task execution closures: one per task
   Each closure: (signal: AbortSignal) => executor.execute(task, { signal })
e. Call runWithConcurrency() with:
   - task closures from (d)
   - maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
   - signal: config.signal (parent cancellation)
   - isFailed: (result) => result.status === "failed"
f. Process ConcurrencyResult:
   - If aborted (parent signal): return StepResult with status "failed" and ABORTED error
   - If firstFailureIndex !== null: return StepResult with status "failed",
     include all results (completed and the failed one), error references the failed task
   - Otherwise: collect output paths from all results, return status "completed"
```

**What stays the same:**
- Task creation via factory
- Error handling for factory failures and workspace write failures
- StepResult shape and contents
- Output path collection logic

**What changes:**
- Task IDs recorded and tasks persisted BEFORE execution (batch upfront instead of interleaved)
- Execution is concurrent via `runWithConcurrency()` instead of a sequential `for` loop
- Cancellation between sub-tasks is now handled by the concurrency utility's abort signal, not a manual check in the loop
- The comment "Execute tasks one at a time (Task 5 adds real parallelism)" is removed

### 6. `src/pipeline/__tests__/pipeline-engine.test.ts` — Update and extend parallel tests

**Update existing tests:**
- Rename describe block from "parallel step fallback" to "parallel step execution"
- The "fails fast on first parallel sub-task failure" test:
  - With true parallelism, the `callCount === 3` trick may not work the same way
  - Rewrite to use a client that fails on a specific skill name rather than call count
  - Assert: `result.status === "failed"`, `result.error?.code === "STEP_FAILED"`
  - Assert: `executionResults.length < tasks.length` (some tasks were cancelled/never started)
- Other existing tests: assertions on final state should still pass (same number of results, same output paths)

**Add new tests:**
- **Concurrency limit respected**: 4 parallel skills, maxConcurrency=2, verify peak concurrent calls = 2
- **Active cancellation on failure**: when one task fails, verify remaining in-flight tasks' abort signals fire (check that they return ABORTED or were never started)
- **maxConcurrency=1 behaves sequentially**: with concurrency=1, tasks execute strictly in order
- **maxConcurrency > task count**: no issue, all tasks launch immediately
- **Default concurrency used when not specified**: omit maxConcurrency from config, verify pipeline completes
- **Results maintain task order**: execution results correspond to tasks by index, regardless of completion order
- **All parallel task IDs recorded before execution**: verify run.taskIds has all IDs even if execution fails immediately

---

## Execution Order

1. **Create `src/pipeline/concurrency.ts`** — standalone utility, no deps on engine
2. **Create `src/pipeline/__tests__/concurrency.test.ts`** — verify utility in isolation
3. **Add `maxConcurrency` to `PipelineEngineConfig`** in `src/pipeline/types.ts`
4. **Update `src/pipeline/__tests__/helpers.ts`** — add concurrency tracking helper
5. **Update `src/pipeline/pipeline-engine.ts`** — replace sequential fallback with `runWithConcurrency()`
6. **Update `src/pipeline/__tests__/pipeline-engine.test.ts`** — update + add tests
7. **Run `bunx tsc --noEmit` + `bun test`** — full verification

---

## Contracts Preserved

- `StepResult` interface unchanged — `tasks`, `executionResults`, `outputPaths` all populated correctly
- `PipelineResult` interface unchanged
- `PipelineRun.taskIds` still records all task IDs (now batch-upfront)
- All existing passing tests continue to pass (assertions may need minor adjustment for non-deterministic ordering in fail-fast tests)
- `onStepComplete` and `onStatusChange` callbacks still fire correctly
- `completedAt` ordering fixes from review are preserved
- Callback safety (try/catch) is preserved
- Output wiring (step N outputs → step N+1 inputs) still works
- Sequential steps are completely unaffected

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Race condition on `run.taskIds.push()` | All task IDs recorded BEFORE concurrent execution starts |
| Workspace write contention | Tasks persisted sequentially before execution; outputs have unique paths per task |
| Non-deterministic result ordering | `runWithConcurrency()` returns results in input order by design |
| MockClaudeClient not thread-safe | Bun/JS is single-threaded; async concurrency is cooperative, no data races |
| Existing fail-fast test breaks | Rewrite to use skill-name-based failure trigger instead of call-count-based |
| Concurrency=1 regression | Explicit test that concurrency=1 behaves identically to old sequential fallback |
