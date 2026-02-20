import type { SystemEvent } from "../types/events.ts";

// ── Event Callback Type ────────────────────────────────────────────────────
// Defined locally to avoid circular imports with src/events/event-bus.ts.

type OnEventCallback = (event: SystemEvent) => void;

// ── Failure Tracker ─────────────────────────────────────────────────────────
// Tracks consecutive failures per pipeline to detect cascading failures.
// When the threshold is reached, signals that the worker should pause.

const GLOBAL_KEY = "__global__";

export class FailureTracker {
  private readonly consecutiveFailures = new Map<string, number>();
  private readonly onEvent?: OnEventCallback;

  constructor(
    private readonly cascadeThreshold: number = 3,
    onEvent?: OnEventCallback,
  ) {
    this.onEvent = onEvent;
  }

  /**
   * Record a task failure. Increments the consecutive failure count
   * for the task's pipeline (or global if no pipeline).
   */
  recordFailure(taskId: string, pipelineId: string | null): void {
    const key = pipelineId ?? GLOBAL_KEY;
    const current = this.consecutiveFailures.get(key) ?? 0;
    const newCount = current + 1;
    this.consecutiveFailures.set(key, newCount);

    // Emit agent_failure event
    this.onEvent?.({
      id: `agent-failure-${taskId}-${Date.now()}`,
      type: "agent_failure",
      timestamp: new Date().toISOString(),
      source: "failure-tracker",
      data: { taskId, pipelineId, consecutiveFailures: newCount },
    });

    // Emit pipeline_blocked when cascade threshold is exactly reached
    if (newCount === this.cascadeThreshold) {
      this.onEvent?.({
        id: `pipeline-blocked-${key}-${Date.now()}`,
        type: "pipeline_blocked",
        timestamp: new Date().toISOString(),
        source: "failure-tracker",
        data: {
          pipelineId,
          consecutiveFailures: newCount,
          threshold: this.cascadeThreshold,
        },
      });
    }
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
