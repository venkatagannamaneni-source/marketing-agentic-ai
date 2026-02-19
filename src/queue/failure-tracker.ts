// ── Failure Tracker ─────────────────────────────────────────────────────────
// Tracks consecutive failures per pipeline to detect cascading failures.
// When the threshold is reached, signals that the worker should pause.

const GLOBAL_KEY = "__global__";

export class FailureTracker {
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(private readonly cascadeThreshold: number = 3) {}

  /**
   * Record a task failure. Increments the consecutive failure count
   * for the task's pipeline (or global if no pipeline).
   */
  recordFailure(taskId: string, pipelineId: string | null): void {
    const key = pipelineId ?? GLOBAL_KEY;
    const current = this.consecutiveFailures.get(key) ?? 0;
    this.consecutiveFailures.set(key, current + 1);
  }

  /**
   * Record a task success. Resets the consecutive failure count
   * for the task's pipeline (or global).
   */
  recordSuccess(taskId: string, pipelineId: string | null): void {
    const key = pipelineId ?? GLOBAL_KEY;
    this.consecutiveFailures.set(key, 0);
  }

  /**
   * Check if processing should pause.
   * - With pipelineId: checks only that pipeline
   * - Without: checks if ANY pipeline has cascading failures
   */
  shouldPause(pipelineId?: string | null): boolean {
    if (pipelineId !== undefined) {
      const key = pipelineId ?? GLOBAL_KEY;
      return (this.consecutiveFailures.get(key) ?? 0) >= this.cascadeThreshold;
    }

    for (const count of this.consecutiveFailures.values()) {
      if (count >= this.cascadeThreshold) return true;
    }
    return false;
  }

  /**
   * Get the current failure counts for all tracked pipelines.
   */
  getFailureCounts(): ReadonlyMap<string, number> {
    return this.consecutiveFailures;
  }

  /**
   * Reset failure counts.
   * - With pipelineId: resets only that pipeline
   * - Without: resets all
   */
  reset(pipelineId?: string | null): void {
    if (pipelineId !== undefined) {
      const key = pipelineId ?? GLOBAL_KEY;
      this.consecutiveFailures.delete(key);
    } else {
      this.consecutiveFailures.clear();
    }
  }
}
