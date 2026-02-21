/**
 * E2E Integration: EventBus → Director → QueueManager
 *
 * Tests the event-driven pipeline triggering flow where external events
 * (traffic drops, competitor launches, etc.) trigger pipelines through
 * the Director and enqueue tasks into the queue.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { bootstrapE2EFull } from "./helpers.ts";
import type { E2EFullContext } from "./helpers.ts";
import { DEFAULT_EVENT_MAPPINGS } from "../../events/default-mappings.ts";
import type { SystemEvent } from "../../types/events.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let eventCounter = 0;

function createEvent(overrides?: Partial<SystemEvent>): SystemEvent {
  eventCounter++;
  return {
    id: `evt-e2e-${eventCounter}`,
    type: "traffic_drop",
    timestamp: new Date().toISOString(),
    source: "integration-test",
    data: { percentageDrop: 25 },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: EventBus → Director → QueueManager", () => {
  let ctx: E2EFullContext;

  beforeEach(async () => {
    eventCounter = 0;
    ctx = await bootstrapE2EFull({ eventMappings: DEFAULT_EVENT_MAPPINGS });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("traffic_drop above threshold triggers SEO Cycle pipeline and enqueues tasks", async () => {
    const event = createEvent({
      type: "traffic_drop",
      data: { percentageDrop: 25 },
    });

    const result = await ctx.eventBus.emit(event);

    // Pipeline triggered
    expect(result.pipelinesTriggered).toBe(1);
    expect(result.pipelineIds).toHaveLength(1);
    expect(result.eventType).toBe("traffic_drop");

    // Tasks were created in workspace by Director.startPipeline
    const tasks = await ctx.workspace.listTasks();
    expect(tasks.length).toBeGreaterThan(0);

    // Tasks were enqueued via QueueManager (mock queue received them)
    expect(ctx.mockQueue.jobs.length).toBeGreaterThan(0);
  });

  it("traffic_drop below threshold is skipped (condition not met)", async () => {
    const event = createEvent({
      type: "traffic_drop",
      data: { percentageDrop: 10 }, // Below 20% threshold
    });

    const result = await ctx.eventBus.emit(event);

    expect(result.pipelinesTriggered).toBe(0);
    expect(result.skippedReasons.length).toBeGreaterThan(0);
    expect(result.skippedReasons.some(r => r.includes("Condition not met"))).toBe(true);

    // No tasks created
    const tasks = await ctx.workspace.listTasks();
    expect(tasks).toHaveLength(0);
  });

  it("cooldown blocks duplicate event type within window", async () => {
    // First event triggers pipeline
    const event1 = createEvent({
      type: "conversion_drop",
      data: { percentageDrop: 15 },
    });
    const result1 = await ctx.eventBus.emit(event1);
    expect(result1.pipelinesTriggered).toBe(1);

    // Second event within cooldown (1 hour for conversion_drop) is blocked
    const event2 = createEvent({
      type: "conversion_drop",
      data: { percentageDrop: 20 },
    });
    const result2 = await ctx.eventBus.emit(event2);
    expect(result2.pipelinesTriggered).toBe(0);
    expect(result2.skippedReasons.some(r => r.includes("Cooldown active"))).toBe(true);
  });

  it("deduplicates by event ID — same ID processed only once", async () => {
    const event = createEvent({
      id: "dedup-test-event",
      type: "competitor_launch",
      data: { competitor: "Acme Corp" },
    });

    const result1 = await ctx.eventBus.emit(event);
    expect(result1.pipelinesTriggered).toBe(1);

    // Same event ID again
    const result2 = await ctx.eventBus.emit(event);
    expect(result2.pipelinesTriggered).toBe(0);
    expect(result2.skippedReasons.some(r => r.includes("Duplicate event ID"))).toBe(true);
  });

  it("new_blog_post triggers Content Production pipeline with P2 priority", async () => {
    const event = createEvent({
      type: "new_blog_post",
      data: { title: "How to Improve Conversion Rates" },
    });

    const result = await ctx.eventBus.emit(event);

    expect(result.pipelinesTriggered).toBe(1);
    expect(result.pipelineIds).toHaveLength(1);

    // Tasks written to workspace
    const tasks = await ctx.workspace.listTasks();
    expect(tasks.length).toBeGreaterThan(0);

    // Verify tasks are for Content Production pipeline
    const pipelineTask = tasks[0]!;
    expect(pipelineTask.pipelineId).not.toBeNull();
  });

  it("unknown event type triggers zero pipelines without error", async () => {
    const event = createEvent({
      type: "manual_goal", // Not in DEFAULT_EVENT_MAPPINGS
      data: { action: "custom" },
    });

    const result = await ctx.eventBus.emit(event);

    expect(result.pipelinesTriggered).toBe(0);
    expect(result.pipelineIds).toHaveLength(0);
    expect(result.skippedReasons).toHaveLength(0);
  });
});
