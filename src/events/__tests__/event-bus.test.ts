import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus } from "../event-bus.ts";
import type {
  EventMapping,
  EventBusDirector,
  EventBusQueueManager,
  EventBusLogger,
  EmitResult,
} from "../event-bus.ts";
import type { SystemEvent } from "../../types/events.ts";
import type { Task, Priority } from "../../types/task.ts";
import type { SkillName } from "../../types/agent.ts";

// ── Test Fixtures ───────────────────────────────────────────────────────────

let eventCounter = 0;

function createTestEvent(overrides?: Partial<SystemEvent>): SystemEvent {
  eventCounter++;
  return {
    id: `evt-test-${eventCounter}`,
    type: "traffic_drop",
    timestamp: new Date().toISOString(),
    source: "test",
    data: { percentageDrop: 25 },
    ...overrides,
  };
}

function createTestTask(overrides?: Partial<Task>): Task {
  const skill: SkillName = (overrides?.to ?? "copywriting") as SkillName;
  const id = overrides?.id ?? `${skill}-20260219-abc123`;
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    from: "event-bus",
    to: skill,
    priority: "P2" as Priority,
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: null,
    pipelineId: null,
    goal: "Test goal",
    inputs: [],
    requirements: "Test requirements",
    output: { path: `outputs/creative/${skill}/${id}.md`, format: "markdown" },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
    ...overrides,
  } as Task;
}

interface MockDirector extends EventBusDirector {
  calls: Array<{ template: string; goal: string; priority?: Priority }>;
  shouldThrow: boolean;
  error: Error;
}

function createMockDirector(): MockDirector {
  const mock: MockDirector = {
    calls: [],
    shouldThrow: false,
    error: new Error("Director error"),
    async startPipeline(template, goal, priority) {
      if (mock.shouldThrow) throw mock.error;
      mock.calls.push({ template, goal, priority });
      return {
        tasks: [createTestTask({ from: "event-bus" })],
        run: { id: `run-${mock.calls.length}` },
      };
    },
  };
  return mock;
}

interface MockQueueManager extends EventBusQueueManager {
  enqueuedBatches: Task[][];
  shouldThrow: boolean;
  error: Error;
}

function createMockQueueManager(): MockQueueManager {
  const mock: MockQueueManager = {
    enqueuedBatches: [],
    shouldThrow: false,
    error: new Error("Queue error"),
    async enqueueBatch(tasks) {
      if (mock.shouldThrow) throw mock.error;
      mock.enqueuedBatches.push([...tasks]);
    },
  };
  return mock;
}

function createMockLogger(): EventBusLogger & {
  infos: Array<{ msg: string; data?: Record<string, unknown> }>;
  warns: Array<{ msg: string; data?: Record<string, unknown> }>;
  errors: Array<{ msg: string; data?: Record<string, unknown> }>;
} {
  const logger = {
    infos: [] as Array<{ msg: string; data?: Record<string, unknown> }>,
    warns: [] as Array<{ msg: string; data?: Record<string, unknown> }>,
    errors: [] as Array<{ msg: string; data?: Record<string, unknown> }>,
    info(msg: string, data?: Record<string, unknown>) {
      logger.infos.push({ msg, data });
    },
    warn(msg: string, data?: Record<string, unknown>) {
      logger.warns.push({ msg, data });
    },
    error(msg: string, data?: Record<string, unknown>) {
      logger.errors.push({ msg, data });
    },
  };
  return logger;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("EventBus", () => {
  let director: MockDirector;
  let queueManager: MockQueueManager;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    eventCounter = 0;
    director = createMockDirector();
    queueManager = createMockQueueManager();
    logger = createMockLogger();
  });

  describe("constructor", () => {
    it("creates with empty mappings", () => {
      const bus = new EventBus([], { director, queueManager });
      expect(bus.getMappings()).toHaveLength(0);
    });

    it("creates with provided mappings", () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      expect(bus.getMappings()).toHaveLength(1);
      expect(bus.getMappings()[0]!.eventType).toBe("traffic_drop");
    });

    it("does not share mapping array reference with caller", () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      mappings.push({ eventType: "conversion_drop", pipelineTemplate: "Conversion Sprint", priority: "P0" });
      expect(bus.getMappings()).toHaveLength(1);
    });
  });

  describe("emit", () => {
    it("triggers pipeline for matching event type", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager, logger });
      const event = createTestEvent({ type: "traffic_drop" });

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(1);
      expect(result.eventId).toBe(event.id);
      expect(result.eventType).toBe("traffic_drop");
    });

    it("calls director.startPipeline with correct template, goal, priority", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent({ type: "traffic_drop", data: { percentageDrop: 30 } });

      await bus.emit(event);

      expect(director.calls).toHaveLength(1);
      expect(director.calls[0]!.template).toBe("SEO Cycle");
      expect(director.calls[0]!.goal).toBe(`[Event: traffic_drop] ${JSON.stringify({ percentageDrop: 30 })}`);
      expect(director.calls[0]!.priority).toBe("P1");
    });

    it("calls queueManager.enqueueBatch with resulting tasks", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent();

      await bus.emit(event);

      expect(queueManager.enqueuedBatches).toHaveLength(1);
      expect(queueManager.enqueuedBatches[0]!.length).toBeGreaterThan(0);
      expect(queueManager.enqueuedBatches[0]![0]!.from).toBe("event-bus");
    });

    it("returns EmitResult with correct pipelineIds and count", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent();

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(1);
      expect(result.pipelineIds).toHaveLength(1);
      expect(result.pipelineIds[0]).toBe("run-1");
      expect(result.skippedReasons).toHaveLength(0);
    });

    it("skips when no mapping matches event type", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager, logger });
      const event = createTestEvent({ type: "competitor_launch" });

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(0);
      expect(result.pipelineIds).toHaveLength(0);
      expect(director.calls).toHaveLength(0);
    });

    it("triggers multiple mappings for same event type", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
        { eventType: "traffic_drop", pipelineTemplate: "Content Production", priority: "P2" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent();

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(2);
      expect(result.pipelineIds).toHaveLength(2);
      expect(director.calls).toHaveLength(2);
      expect(director.calls[0]!.template).toBe("SEO Cycle");
      expect(director.calls[1]!.template).toBe("Content Production");
    });

    it("evaluates condition — triggers when condition returns true", async () => {
      const mappings: EventMapping[] = [
        {
          eventType: "traffic_drop",
          pipelineTemplate: "SEO Cycle",
          priority: "P1",
          condition: (evt) => {
            const drop = evt.data.percentageDrop;
            return typeof drop === "number" && drop > 20;
          },
        },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent({ data: { percentageDrop: 30 } });

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(1);
    });

    it("evaluates condition — skips when condition returns false", async () => {
      const mappings: EventMapping[] = [
        {
          eventType: "traffic_drop",
          pipelineTemplate: "SEO Cycle",
          priority: "P1",
          condition: (evt) => {
            const drop = evt.data.percentageDrop;
            return typeof drop === "number" && drop > 20;
          },
        },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent({ data: { percentageDrop: 10 } });

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(0);
      expect(result.skippedReasons).toHaveLength(1);
      expect(result.skippedReasons[0]).toContain("Condition not met");
    });

    it("catches and logs condition errors — skips that mapping", async () => {
      const mappings: EventMapping[] = [
        {
          eventType: "traffic_drop",
          pipelineTemplate: "SEO Cycle",
          priority: "P1",
          condition: () => {
            throw new Error("Condition kaboom");
          },
        },
      ];
      const bus = new EventBus(mappings, { director, queueManager, logger });
      const event = createTestEvent();

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(0);
      expect(result.skippedReasons).toHaveLength(1);
      expect(result.skippedReasons[0]).toContain("Condition error");
      expect(result.skippedReasons[0]).toContain("Condition kaboom");
      expect(logger.warns).toHaveLength(1);
    });

    it("catches and logs director.startPipeline errors — continues to next mapping", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
        { eventType: "traffic_drop", pipelineTemplate: "Content Production", priority: "P2" },
      ];
      director.shouldThrow = true;
      director.error = new Error("Pipeline start failed");

      // Make director fail on first call only
      let callCount = 0;
      director.startPipeline = async (template, goal, priority) => {
        callCount++;
        if (callCount === 1) throw new Error("Pipeline start failed");
        return {
          tasks: [createTestTask({ from: "event-bus" })],
          run: { id: `run-${callCount}` },
        };
      };

      const bus = new EventBus(mappings, { director, queueManager, logger });
      const event = createTestEvent();

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(1);
      expect(result.skippedReasons).toHaveLength(1);
      expect(result.skippedReasons[0]).toContain("Pipeline start failed");
      expect(logger.errors).toHaveLength(1);
    });

    it("catches and logs queueManager.enqueueBatch errors — still counts as triggered", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      queueManager.shouldThrow = true;
      const bus = new EventBus(mappings, { director, queueManager, logger });
      const event = createTestEvent();

      const result = await bus.emit(event);

      // Pipeline was started (counted as triggered) even though enqueue failed
      expect(result.pipelinesTriggered).toBe(1);
      expect(result.pipelineIds).toHaveLength(1);
      expect(logger.errors).toHaveLength(1);
    });

    it("respects cooldown — skips event type within cooldown window", async () => {
      const mappings: EventMapping[] = [
        {
          eventType: "traffic_drop",
          pipelineTemplate: "SEO Cycle",
          priority: "P1",
          cooldownMs: 60_000, // 1 minute
        },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      // First emit should trigger
      const event1 = createTestEvent();
      const result1 = await bus.emit(event1);
      expect(result1.pipelinesTriggered).toBe(1);

      // Second emit within cooldown should skip
      const event2 = createTestEvent();
      const result2 = await bus.emit(event2);
      expect(result2.pipelinesTriggered).toBe(0);
      expect(result2.skippedReasons).toHaveLength(1);
      expect(result2.skippedReasons[0]).toContain("Cooldown active");
    });

    it("allows event type after cooldown window expires", async () => {
      const mappings: EventMapping[] = [
        {
          eventType: "traffic_drop",
          pipelineTemplate: "SEO Cycle",
          priority: "P1",
          cooldownMs: 10, // 10ms cooldown
        },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      const event1 = createTestEvent();
      const result1 = await bus.emit(event1);
      expect(result1.pipelinesTriggered).toBe(1);

      // Wait for cooldown to expire
      await new Promise((resolve) => setTimeout(resolve, 20));

      const event2 = createTestEvent();
      const result2 = await bus.emit(event2);
      expect(result2.pipelinesTriggered).toBe(1);
    });

    it("deduplicates by event ID — same ID triggers only once", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      const event = createTestEvent({ id: "same-event-id" });
      const result1 = await bus.emit(event);
      expect(result1.pipelinesTriggered).toBe(1);

      // Same ID again
      const result2 = await bus.emit(event);
      expect(result2.pipelinesTriggered).toBe(0);
      expect(result2.skippedReasons).toHaveLength(1);
      expect(result2.skippedReasons[0]).toContain("Duplicate event ID");
    });

    it("handles event with no data gracefully", async () => {
      const mappings: EventMapping[] = [
        { eventType: "competitor_launch", pipelineTemplate: "Competitive Response", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent({ type: "competitor_launch", data: {} });

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(1);
      expect(director.calls[0]!.goal).toContain("[Event: competitor_launch]");
    });

    it("works without logger (uses null logger)", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent();

      // Should not throw
      const result = await bus.emit(event);
      expect(result.pipelinesTriggered).toBe(1);
    });

    it("returns empty result for unknown event type", async () => {
      const bus = new EventBus([], { director, queueManager });
      const event = createTestEvent({ type: "manual_goal" });

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(0);
      expect(result.pipelineIds).toHaveLength(0);
      expect(result.skippedReasons).toHaveLength(0);
    });

    it("handles director returning empty tasks array", async () => {
      director.startPipeline = async () => ({
        tasks: [],
        run: { id: "run-empty" },
      });

      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      const event = createTestEvent();

      const result = await bus.emit(event);

      expect(result.pipelinesTriggered).toBe(1);
      expect(queueManager.enqueuedBatches).toHaveLength(0);
    });

    it("triggers all sibling mappings for same event type with cooldown in one emit", async () => {
      const mappings: EventMapping[] = [
        {
          eventType: "traffic_drop",
          pipelineTemplate: "SEO Cycle",
          priority: "P1",
          cooldownMs: 60_000,
        },
        {
          eventType: "traffic_drop",
          pipelineTemplate: "Content Production",
          priority: "P2",
          cooldownMs: 60_000,
        },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      const event = createTestEvent({ type: "traffic_drop" });
      const result = await bus.emit(event);

      // Both mappings should trigger in a single emit call
      expect(result.pipelinesTriggered).toBe(2);
      expect(result.pipelineIds).toHaveLength(2);
      expect(director.calls).toHaveLength(2);
      expect(director.calls[0]!.template).toBe("SEO Cycle");
      expect(director.calls[1]!.template).toBe("Content Production");

      // Second emit should be blocked by cooldown (both mappings)
      const event2 = createTestEvent({ type: "traffic_drop" });
      const result2 = await bus.emit(event2);
      expect(result2.pipelinesTriggered).toBe(0);
      expect(result2.skippedReasons).toHaveLength(1);
      expect(result2.skippedReasons[0]).toContain("Cooldown active");
    });

    it("cooldown is per event type, not per event ID", async () => {
      const mappings: EventMapping[] = [
        {
          eventType: "traffic_drop",
          pipelineTemplate: "SEO Cycle",
          priority: "P1",
          cooldownMs: 60_000,
        },
        {
          eventType: "competitor_launch",
          pipelineTemplate: "Competitive Response",
          priority: "P1",
          cooldownMs: 60_000,
        },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      // Trigger traffic_drop
      const event1 = createTestEvent({ type: "traffic_drop" });
      await bus.emit(event1);

      // competitor_launch should still work (different event type)
      const event2 = createTestEvent({ type: "competitor_launch" });
      const result2 = await bus.emit(event2);
      expect(result2.pipelinesTriggered).toBe(1);
    });

    it("all director.startPipeline failures still record event ID as processed", async () => {
      director.shouldThrow = true;
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager, logger });
      const event = createTestEvent({ id: "fail-event-id" });

      const result1 = await bus.emit(event);
      expect(result1.pipelinesTriggered).toBe(0);

      // Same event ID should be deduplicated even after failure
      const result2 = await bus.emit(event);
      expect(result2.pipelinesTriggered).toBe(0);
      expect(result2.skippedReasons[0]).toContain("Duplicate event ID");
    });
  });

  describe("addMapping", () => {
    it("adds new mapping", () => {
      const bus = new EventBus([], { director, queueManager });
      bus.addMapping({
        eventType: "traffic_drop",
        pipelineTemplate: "SEO Cycle",
        priority: "P1",
      });
      expect(bus.getMappings()).toHaveLength(1);
    });

    it("allows multiple mappings for same event type", () => {
      const bus = new EventBus([], { director, queueManager });
      bus.addMapping({
        eventType: "traffic_drop",
        pipelineTemplate: "SEO Cycle",
        priority: "P1",
      });
      bus.addMapping({
        eventType: "traffic_drop",
        pipelineTemplate: "Content Production",
        priority: "P2",
      });
      expect(bus.getMappings()).toHaveLength(2);
    });

    it("added mapping is effective for future emits", async () => {
      const bus = new EventBus([], { director, queueManager });
      bus.addMapping({
        eventType: "competitor_launch",
        pipelineTemplate: "Competitive Response",
        priority: "P1",
      });
      const event = createTestEvent({ type: "competitor_launch" });
      const result = await bus.emit(event);
      expect(result.pipelinesTriggered).toBe(1);
    });
  });

  describe("removeMappingByEvent", () => {
    it("removes all mappings for given event type", () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
        { eventType: "traffic_drop", pipelineTemplate: "Content Production", priority: "P2" },
        { eventType: "competitor_launch", pipelineTemplate: "Competitive Response", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      bus.removeMappingByEvent("traffic_drop");

      expect(bus.getMappings()).toHaveLength(1);
      expect(bus.getMappings()[0]!.eventType).toBe("competitor_launch");
    });

    it("is a no-op for event type with no mappings", () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      bus.removeMappingByEvent("competitor_launch");

      expect(bus.getMappings()).toHaveLength(1);
    });

    it("removed mapping no longer triggers on emit", async () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });
      bus.removeMappingByEvent("traffic_drop");

      const event = createTestEvent({ type: "traffic_drop" });
      const result = await bus.emit(event);
      expect(result.pipelinesTriggered).toBe(0);
    });
  });

  describe("clearCooldowns", () => {
    it("resets cooldown state so previously cooled-down events trigger again", async () => {
      const mappings: EventMapping[] = [
        {
          eventType: "traffic_drop",
          pipelineTemplate: "SEO Cycle",
          priority: "P1",
          cooldownMs: 60_000,
        },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      // First emit triggers
      const event1 = createTestEvent();
      await bus.emit(event1);
      expect(director.calls).toHaveLength(1);

      // Second emit is cooled down
      const event2 = createTestEvent();
      const result2 = await bus.emit(event2);
      expect(result2.pipelinesTriggered).toBe(0);

      // Clear cooldowns
      bus.clearCooldowns();

      // Third emit triggers again
      const event3 = createTestEvent();
      const result3 = await bus.emit(event3);
      expect(result3.pipelinesTriggered).toBe(1);
      expect(director.calls).toHaveLength(2);
    });

    it("also clears processed event IDs", async () => {
      const bus = new EventBus(
        [{ eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" }],
        { director, queueManager },
      );

      const event = createTestEvent({ id: "reusable-id" });
      await bus.emit(event);

      // Should be deduplicated
      const result1 = await bus.emit(event);
      expect(result1.pipelinesTriggered).toBe(0);

      bus.clearCooldowns();

      // After clearing, same ID should work again
      const result2 = await bus.emit(event);
      expect(result2.pipelinesTriggered).toBe(1);
    });
  });

  describe("getMappings", () => {
    it("returns current mappings", () => {
      const mappings: EventMapping[] = [
        { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1" },
        { eventType: "competitor_launch", pipelineTemplate: "Competitive Response", priority: "P1" },
      ];
      const bus = new EventBus(mappings, { director, queueManager });

      const result = bus.getMappings();
      expect(result).toHaveLength(2);
      expect(result[0]!.eventType).toBe("traffic_drop");
      expect(result[1]!.eventType).toBe("competitor_launch");
    });
  });
});
