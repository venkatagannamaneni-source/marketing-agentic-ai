// ── Concurrent Execution with Fail-Fast ─────────────────────────────────────

/**
 * Options for `runWithConcurrency()`.
 *
 * Each task function receives an `AbortSignal` that fires on either:
 *   1. Parent signal abort (caller cancellation)
 *   2. Fail-fast abort (another task returned a failed result)
 */
export interface ConcurrencyOptions<T> {
  /** Async task functions to execute. Each receives a signal for cancellation. */
  readonly tasks: ReadonlyArray<(signal: AbortSignal) => Promise<T>>;
  /** Maximum number of tasks running simultaneously. Must be >= 1. */
  readonly maxConcurrency: number;
  /** Parent abort signal — aborts all tasks when triggered. */
  readonly signal?: AbortSignal;
  /** Predicate that returns true if a result indicates failure. */
  readonly isFailed: (result: T) => boolean;
}

export interface ConcurrencyResult<T> {
  /** Results in input order. Only includes slots for tasks that were started. */
  readonly results: readonly T[];
  /** Index of the first task whose result matched `isFailed`. Null if none failed. */
  readonly firstFailureIndex: number | null;
  /** True if the parent signal (not fail-fast) caused the abort. */
  readonly aborted: boolean;
}

/**
 * Execute async tasks with bounded concurrency and fail-fast semantics.
 *
 * - Launches up to `maxConcurrency` tasks at a time
 * - On first failure (per `isFailed` predicate): aborts all in-flight tasks
 *   via a child `AbortController` and stops launching new ones
 * - Results are returned in **input order** (not completion order)
 * - Never throws — always returns a `ConcurrencyResult`
 */
export async function runWithConcurrency<T>(
  options: ConcurrencyOptions<T>,
): Promise<ConcurrencyResult<T>> {
  const { tasks, maxConcurrency, signal, isFailed } = options;

  // ── Edge cases ───────────────────────────────────────────────────────

  if (tasks.length === 0) {
    return { results: [], firstFailureIndex: null, aborted: false };
  }

  if (signal?.aborted) {
    return { results: [], firstFailureIndex: null, aborted: true };
  }

  const effectiveConcurrency = Math.max(1, Math.min(maxConcurrency, tasks.length));

  // ── Child abort controller ───────────────────────────────────────────
  // Fires on: parent signal abort OR fail-fast from any task

  const childController = new AbortController();
  const childSignal = childController.signal;

  // Forward parent abort to child
  const onParentAbort = () => childController.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });

  // ── State ────────────────────────────────────────────────────────────

  const resultSlots: (T | undefined)[] = new Array(tasks.length).fill(undefined);
  let nextIndex = 0;                   // next task to launch
  let settledCount = 0;                // how many launched tasks have settled
  let launchedCount = 0;               // total tasks launched
  let firstFailureIndex: number | null = null;
  let parentAborted = false;

  // ── Execution ────────────────────────────────────────────────────────

  return new Promise<ConcurrencyResult<T>>((resolve) => {
    const tryResolve = () => {
      if (settledCount < launchedCount) return; // still waiting on in-flight tasks

      // Cleanup parent listener
      signal?.removeEventListener("abort", onParentAbort);

      // Collect only populated slots (tasks that were started)
      const results: T[] = [];
      for (let i = 0; i < tasks.length; i++) {
        if (resultSlots[i] !== undefined) {
          results.push(resultSlots[i] as T);
        }
      }

      resolve({ results, firstFailureIndex, aborted: parentAborted });
    };

    const launchTask = (index: number) => {
      launchedCount++;
      const taskFn = tasks[index]!;

      taskFn(childSignal).then(
        (result) => {
          settledCount++;
          resultSlots[index] = result;

          if (isFailed(result) && firstFailureIndex === null) {
            firstFailureIndex = index;
            childController.abort();
            // Don't launch more — fall through to tryResolve
          } else if (!childSignal.aborted) {
            // Launch next task if available
            launchNext();
          }

          tryResolve();
        },
        (_error: unknown) => {
          // Task function threw — this shouldn't happen with our executor
          // (which never throws), but handle it as a safety net.
          // We can't call isFailed() since we have no result.
          // Treat thrown errors as failures to be safe.
          settledCount++;

          if (firstFailureIndex === null) {
            firstFailureIndex = index;
            childController.abort();
          }

          tryResolve();
        },
      );
    };

    const launchNext = () => {
      // Check if parent signal was the cause of abort
      if (signal?.aborted) {
        parentAborted = true;
      }

      while (nextIndex < tasks.length && !childSignal.aborted) {
        const idx = nextIndex++;
        launchTask(idx);
        // Only launch up to concurrency limit
        if (launchedCount - settledCount >= effectiveConcurrency) break;
      }

      // If nothing was launched and nothing in-flight, resolve
      if (launchedCount === 0) {
        tryResolve();
      }
    };

    // Detect parent abort during execution
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          parentAborted = true;
          tryResolve();
        },
        { once: true },
      );
    }

    // Kick off initial batch
    launchNext();
  });
}
