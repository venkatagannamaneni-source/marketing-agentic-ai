import { describe, it, expect, beforeEach } from "bun:test";
import { FailureTracker } from "../failure-tracker.ts";
import type { SystemEvent } from "../../types/events.ts";

describe("FailureTracker", () => {
  let tracker: FailureTracker;

  beforeEach(() => {
    tracker = new FailureTracker(3);
  });

  describe("recordFailure / shouldPause", () => {
    it("does not trigger pause below threshold", () => {
      tracker.recordFailure("task-1", null);
      tracker.recordFailure("task-2", null);
      expect(tracker.shouldPause()).toBe(false);
    });

    it("triggers pause at threshold", () => {
      tracker.recordFailure("task-1", null);
      tracker.recordFailure("task-2", null);
      tracker.recordFailure("task-3", null);
      expect(tracker.shouldPause()).toBe(true);
    });

    it("triggers pause above threshold", () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordFailure(`task-${i}`, null);
      }
      expect(tracker.shouldPause()).toBe(true);
    });
  });

  describe("per-pipeline isolation", () => {
    it("tracks failures per pipeline independently", () => {
      tracker.recordFailure("t1", "pipeline-a");
      tracker.recordFailure("t2", "pipeline-a");
      tracker.recordFailure("t3", "pipeline-b");

      expect(tracker.shouldPause("pipeline-a")).toBe(false);
      expect(tracker.shouldPause("pipeline-b")).toBe(false);
    });

    it("triggers pause only for the affected pipeline", () => {
      tracker.recordFailure("t1", "pipeline-a");
      tracker.recordFailure("t2", "pipeline-a");
      tracker.recordFailure("t3", "pipeline-a");

      expect(tracker.shouldPause("pipeline-a")).toBe(true);
      expect(tracker.shouldPause("pipeline-b")).toBe(false);
    });

    it("shouldPause without argument checks all pipelines", () => {
      tracker.recordFailure("t1", "pipeline-a");
      tracker.recordFailure("t2", "pipeline-a");
      expect(tracker.shouldPause()).toBe(false);

      tracker.recordFailure("t3", "pipeline-a");
      expect(tracker.shouldPause()).toBe(true);
    });

    it("null pipelineId uses global bucket", () => {
      tracker.recordFailure("t1", null);
      tracker.recordFailure("t2", null);
      tracker.recordFailure("t3", null);

      expect(tracker.shouldPause(null)).toBe(true);
      expect(tracker.shouldPause("pipeline-a")).toBe(false);
    });
  });

  describe("recordSuccess", () => {
    it("resets the consecutive failure count", () => {
      tracker.recordFailure("t1", null);
      tracker.recordFailure("t2", null);
      tracker.recordSuccess("t3", null);

      expect(tracker.shouldPause(null)).toBe(false);

      // Need 3 more consecutive failures to trigger
      tracker.recordFailure("t4", null);
      tracker.recordFailure("t5", null);
      expect(tracker.shouldPause()).toBe(false);

      tracker.recordFailure("t6", null);
      expect(tracker.shouldPause()).toBe(true);
    });

    it("only resets the specific pipeline", () => {
      tracker.recordFailure("t1", "pipeline-a");
      tracker.recordFailure("t2", "pipeline-a");
      tracker.recordFailure("t3", "pipeline-b");
      tracker.recordFailure("t4", "pipeline-b");

      tracker.recordSuccess("t5", "pipeline-a");

      const counts = tracker.getFailureCounts();
      expect(counts.get("pipeline-a")).toBe(0);
      expect(counts.get("pipeline-b")).toBe(2);
    });
  });

  describe("reset", () => {
    it("resets a specific pipeline", () => {
      tracker.recordFailure("t1", "pipeline-a");
      tracker.recordFailure("t2", "pipeline-a");
      tracker.recordFailure("t3", "pipeline-a");

      tracker.reset("pipeline-a");
      expect(tracker.shouldPause("pipeline-a")).toBe(false);
    });

    it("resets all when called without argument", () => {
      tracker.recordFailure("t1", "pipeline-a");
      tracker.recordFailure("t2", "pipeline-a");
      tracker.recordFailure("t3", "pipeline-a");
      tracker.recordFailure("t4", "pipeline-b");
      tracker.recordFailure("t5", "pipeline-b");
      tracker.recordFailure("t6", "pipeline-b");

      tracker.reset();
      expect(tracker.shouldPause()).toBe(false);
      expect(tracker.getFailureCounts().size).toBe(0);
    });
  });

  describe("getFailureCounts", () => {
    it("returns all tracked pipelines", () => {
      tracker.recordFailure("t1", "pipeline-a");
      tracker.recordFailure("t2", "pipeline-b");
      tracker.recordFailure("t3", null);

      const counts = tracker.getFailureCounts();
      expect(counts.size).toBe(3);
      expect(counts.get("pipeline-a")).toBe(1);
      expect(counts.get("pipeline-b")).toBe(1);
      expect(counts.get("__global__")).toBe(1);
    });
  });

  describe("custom threshold", () => {
    it("respects custom cascade threshold", () => {
      const custom = new FailureTracker(1);
      custom.recordFailure("t1", null);
      expect(custom.shouldPause()).toBe(true);
    });
  });

  describe("event emission", () => {
    it("emits agent_failure on each recordFailure call", () => {
      const events: SystemEvent[] = [];
      const trackerWithEvents = new FailureTracker(3, (e) => events.push(e));

      trackerWithEvents.recordFailure("task-1", "pipe-a");

      const agentFailures = events.filter((e) => e.type === "agent_failure");
      expect(agentFailures).toHaveLength(1);
      expect(agentFailures[0]!.source).toBe("failure-tracker");
      expect(agentFailures[0]!.data.taskId).toBe("task-1");
      expect(agentFailures[0]!.data.pipelineId).toBe("pipe-a");
      expect(agentFailures[0]!.data.consecutiveFailures).toBe(1);
    });

    it("emits pipeline_blocked when cascade threshold reached", () => {
      const events: SystemEvent[] = [];
      const trackerWithEvents = new FailureTracker(3, (e) => events.push(e));

      trackerWithEvents.recordFailure("t1", "pipe-a");
      trackerWithEvents.recordFailure("t2", "pipe-a");
      trackerWithEvents.recordFailure("t3", "pipe-a");

      const blocked = events.filter((e) => e.type === "pipeline_blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0]!.data.pipelineId).toBe("pipe-a");
      expect(blocked[0]!.data.consecutiveFailures).toBe(3);
      expect(blocked[0]!.data.threshold).toBe(3);
    });

    it("does not emit pipeline_blocked below threshold", () => {
      const events: SystemEvent[] = [];
      const trackerWithEvents = new FailureTracker(3, (e) => events.push(e));

      trackerWithEvents.recordFailure("t1", "pipe-a");
      trackerWithEvents.recordFailure("t2", "pipe-a");

      const blocked = events.filter((e) => e.type === "pipeline_blocked");
      expect(blocked).toHaveLength(0);
    });

    it("does not emit pipeline_blocked above threshold (only at exact threshold)", () => {
      const events: SystemEvent[] = [];
      const trackerWithEvents = new FailureTracker(3, (e) => events.push(e));

      trackerWithEvents.recordFailure("t1", "pipe-a");
      trackerWithEvents.recordFailure("t2", "pipe-a");
      trackerWithEvents.recordFailure("t3", "pipe-a");
      trackerWithEvents.recordFailure("t4", "pipe-a");

      const blocked = events.filter((e) => e.type === "pipeline_blocked");
      expect(blocked).toHaveLength(1); // Only at exact threshold, not again at 4
    });

    it("does not emit when no onEvent callback provided", () => {
      const trackerNoCallback = new FailureTracker(3);

      // Should not throw
      trackerNoCallback.recordFailure("t1", null);
      trackerNoCallback.recordFailure("t2", null);
      trackerNoCallback.recordFailure("t3", null);
    });

    it("emitted agent_failure events have correct shape", () => {
      const events: SystemEvent[] = [];
      const trackerWithEvents = new FailureTracker(3, (e) => events.push(e));

      trackerWithEvents.recordFailure("task-42", "pipe-x");

      const event = events[0]!;
      expect(typeof event.id).toBe("string");
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.type).toBe("agent_failure");
      expect(typeof event.timestamp).toBe("string");
      expect(event.source).toBe("failure-tracker");
      expect(event.data.taskId).toBe("task-42");
      expect(event.data.pipelineId).toBe("pipe-x");
    });

    it("emits agent_failure for null pipelineId", () => {
      const events: SystemEvent[] = [];
      const trackerWithEvents = new FailureTracker(3, (e) => events.push(e));

      trackerWithEvents.recordFailure("task-1", null);

      const event = events[0]!;
      expect(event.type).toBe("agent_failure");
      expect(event.data.pipelineId).toBeNull();
    });

    it("emits pipeline_blocked with null pipelineId when global threshold reached", () => {
      const events: SystemEvent[] = [];
      const trackerWithEvents = new FailureTracker(2, (e) => events.push(e));

      trackerWithEvents.recordFailure("t1", null);
      trackerWithEvents.recordFailure("t2", null);

      const blocked = events.filter((e) => e.type === "pipeline_blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0]!.data.pipelineId).toBeNull();
    });

    it("produces unique event IDs across multiple calls in the same tick", () => {
      const events: SystemEvent[] = [];
      const trackerWithEvents = new FailureTracker(5, (e) => events.push(e));

      trackerWithEvents.recordFailure("t1", "pipe-a");
      trackerWithEvents.recordFailure("t2", "pipe-a");
      trackerWithEvents.recordFailure("t3", "pipe-a");

      expect(events).toHaveLength(3);
      const ids = new Set(events.map((e) => e.id));
      expect(ids.size).toBe(3);
    });
  });
});
