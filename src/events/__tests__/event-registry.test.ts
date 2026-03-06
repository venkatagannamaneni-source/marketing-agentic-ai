import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import {
  EventRegistry,
  EventRegistryError,
  type EventRegistryData,
  type EventCondition,
} from "../event-registry.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

const EVENTS_YAML_PATH = resolve(
  import.meta.dir,
  "../../../.agents/events.yaml",
);

function validRegistryData(): EventRegistryData {
  return {
    mappings: [
      {
        eventType: "traffic_drop",
        pipelineTemplate: "SEO Cycle",
        priority: "P1",
        cooldownMs: 3_600_000,
        condition: {
          field: "percentageDrop",
          operator: "gt",
          value: 20,
        },
        description: "Trigger SEO cycle on traffic drop",
      },
      {
        eventType: "competitor_launch",
        pipelineTemplate: "Competitive Response",
        priority: "P1",
        cooldownMs: 86_400_000,
        description: "Respond to competitor launch",
      },
    ],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("EventRegistry", () => {
  describe("fromYaml", () => {
    it("loads events.yaml successfully", async () => {
      const registry = await EventRegistry.fromYaml(EVENTS_YAML_PATH);
      expect(registry.mappings.length).toBe(7);
    });

    it("throws EventRegistryError for missing file", async () => {
      await expect(
        EventRegistry.fromYaml("/nonexistent/events.yaml"),
      ).rejects.toThrow(EventRegistryError);
    });

    it("error includes 'not found' message for missing file", async () => {
      try {
        await EventRegistry.fromYaml("/nonexistent/events.yaml");
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EventRegistryError);
        const regErr = err as EventRegistryError;
        expect(regErr.errors.some((e) => e.includes("not found"))).toBe(true);
      }
    });
  });

  describe("fromData", () => {
    it("creates registry from in-memory data", () => {
      const registry = EventRegistry.fromData(validRegistryData());
      expect(registry.mappings.length).toBe(2);
    });

    it("mappings are frozen / readonly", () => {
      const registry = EventRegistry.fromData(validRegistryData());
      expect(Object.isFrozen(registry.mappings)).toBe(true);
    });
  });

  describe("getMappingsForEvent", () => {
    it("returns matching mappings for a known event type", () => {
      const registry = EventRegistry.fromData(validRegistryData());
      const results = registry.getMappingsForEvent("traffic_drop");
      expect(results.length).toBe(1);
      expect(results[0]!.pipelineTemplate).toBe("SEO Cycle");
    });

    it("returns empty array for unknown event type", () => {
      const registry = EventRegistry.fromData(validRegistryData());
      const results = registry.getMappingsForEvent("unknown_event");
      expect(results.length).toBe(0);
    });

    it("returns multiple mappings when event type has multiple entries", () => {
      const data: EventRegistryData = {
        mappings: [
          {
            eventType: "traffic_drop",
            pipelineTemplate: "SEO Cycle",
            priority: "P1",
            cooldownMs: 3_600_000,
          },
          {
            eventType: "traffic_drop",
            pipelineTemplate: "Conversion Sprint",
            priority: "P0",
            cooldownMs: 1_800_000,
          },
        ],
      };
      const registry = EventRegistry.fromData(data);
      const results = registry.getMappingsForEvent("traffic_drop");
      expect(results.length).toBe(2);
    });
  });

  describe("evaluateCondition", () => {
    const registry = EventRegistry.fromData(validRegistryData());

    describe("gt operator", () => {
      const condition: EventCondition = {
        field: "percentageDrop",
        operator: "gt",
        value: 20,
      };

      it("returns true when field value > threshold", () => {
        expect(registry.evaluateCondition(condition, { percentageDrop: 21 })).toBe(true);
      });

      it("returns false when field value = threshold", () => {
        expect(registry.evaluateCondition(condition, { percentageDrop: 20 })).toBe(false);
      });

      it("returns false when field value < threshold", () => {
        expect(registry.evaluateCondition(condition, { percentageDrop: 19 })).toBe(false);
      });

      it("returns false for non-numeric field value", () => {
        expect(registry.evaluateCondition(condition, { percentageDrop: "high" })).toBe(false);
      });

      it("returns false for missing field", () => {
        expect(registry.evaluateCondition(condition, {})).toBe(false);
      });
    });

    describe("gte operator", () => {
      const condition: EventCondition = { field: "score", operator: "gte", value: 50 };

      it("returns true when field value >= threshold", () => {
        expect(registry.evaluateCondition(condition, { score: 50 })).toBe(true);
        expect(registry.evaluateCondition(condition, { score: 51 })).toBe(true);
      });

      it("returns false when field value < threshold", () => {
        expect(registry.evaluateCondition(condition, { score: 49 })).toBe(false);
      });
    });

    describe("lt operator", () => {
      const condition: EventCondition = { field: "count", operator: "lt", value: 10 };

      it("returns true when field value < threshold", () => {
        expect(registry.evaluateCondition(condition, { count: 9 })).toBe(true);
      });

      it("returns false when field value >= threshold", () => {
        expect(registry.evaluateCondition(condition, { count: 10 })).toBe(false);
      });
    });

    describe("lte operator", () => {
      const condition: EventCondition = { field: "count", operator: "lte", value: 10 };

      it("returns true when field value <= threshold", () => {
        expect(registry.evaluateCondition(condition, { count: 10 })).toBe(true);
        expect(registry.evaluateCondition(condition, { count: 9 })).toBe(true);
      });

      it("returns false when field value > threshold", () => {
        expect(registry.evaluateCondition(condition, { count: 11 })).toBe(false);
      });
    });

    describe("eq operator", () => {
      const condition: EventCondition = { field: "status", operator: "eq", value: "active" };

      it("returns true when field value equals target", () => {
        expect(registry.evaluateCondition(condition, { status: "active" })).toBe(true);
      });

      it("returns false when field value differs", () => {
        expect(registry.evaluateCondition(condition, { status: "inactive" })).toBe(false);
      });
    });

    describe("neq operator", () => {
      const condition: EventCondition = { field: "status", operator: "neq", value: "active" };

      it("returns true when field value differs", () => {
        expect(registry.evaluateCondition(condition, { status: "inactive" })).toBe(true);
      });

      it("returns false when field value equals target", () => {
        expect(registry.evaluateCondition(condition, { status: "active" })).toBe(false);
      });
    });

    describe("exists operator", () => {
      const condition: EventCondition = { field: "metadata", operator: "exists" };

      it("returns true when field exists", () => {
        expect(registry.evaluateCondition(condition, { metadata: "value" })).toBe(true);
      });

      it("returns false when field is undefined", () => {
        expect(registry.evaluateCondition(condition, {})).toBe(false);
      });

      it("returns false when field is null", () => {
        expect(registry.evaluateCondition(condition, { metadata: null })).toBe(false);
      });
    });

    describe("contains operator", () => {
      it("returns true when string contains substring", () => {
        const condition: EventCondition = { field: "message", operator: "contains", value: "error" };
        expect(
          registry.evaluateCondition(condition, { message: "fatal error occurred" }),
        ).toBe(true);
      });

      it("returns false when string does not contain substring", () => {
        const condition: EventCondition = { field: "message", operator: "contains", value: "error" };
        expect(
          registry.evaluateCondition(condition, { message: "all good" }),
        ).toBe(false);
      });

      it("returns true when array contains value", () => {
        const condition: EventCondition = { field: "tags", operator: "contains", value: "urgent" };
        expect(
          registry.evaluateCondition(condition, { tags: ["urgent", "marketing"] }),
        ).toBe(true);
      });
    });
  });

  describe("toEventMappings", () => {
    it("converts to runtime EventMapping array", () => {
      const registry = EventRegistry.fromData(validRegistryData());
      const mappings = registry.toEventMappings();
      expect(mappings.length).toBe(2);
    });

    it("preserves eventType, pipelineTemplate, priority, cooldownMs", () => {
      const registry = EventRegistry.fromData(validRegistryData());
      const mappings = registry.toEventMappings();
      const first = mappings[0]!;
      expect(first.eventType).toBe("traffic_drop");
      expect(first.pipelineTemplate).toBe("SEO Cycle");
      expect(first.priority).toBe("P1");
      expect(first.cooldownMs).toBe(3_600_000);
    });

    it("generates working condition function from declarative condition", () => {
      const registry = EventRegistry.fromData(validRegistryData());
      const mappings = registry.toEventMappings();
      const trafficDrop = mappings[0]!;

      expect(trafficDrop.condition).toBeDefined();

      const passingEvent = {
        id: "e1",
        type: "traffic_drop" as const,
        timestamp: new Date().toISOString(),
        source: "test",
        data: { percentageDrop: 25 },
      };
      expect(trafficDrop.condition!(passingEvent)).toBe(true);

      const failingEvent = {
        id: "e2",
        type: "traffic_drop" as const,
        timestamp: new Date().toISOString(),
        source: "test",
        data: { percentageDrop: 15 },
      };
      expect(trafficDrop.condition!(failingEvent)).toBe(false);
    });

    it("mappings without conditions have no condition function", () => {
      const registry = EventRegistry.fromData(validRegistryData());
      const mappings = registry.toEventMappings();
      const competitorLaunch = mappings[1]!;
      expect(competitorLaunch.eventType).toBe("competitor_launch");
      expect(competitorLaunch.condition).toBeUndefined();
    });
  });

  describe("fromYaml produces working runtime mappings", () => {
    it("YAML-loaded mappings have functional conditions", async () => {
      const registry = await EventRegistry.fromYaml(EVENTS_YAML_PATH);
      const mappings = registry.toEventMappings();

      const trafficDrop = mappings.find((m) => m.eventType === "traffic_drop")!;
      expect(trafficDrop.condition).toBeDefined();

      const passingEvent = {
        id: "e1",
        type: "traffic_drop" as const,
        timestamp: new Date().toISOString(),
        source: "test",
        data: { percentageDrop: 25 },
      };
      expect(trafficDrop.condition!(passingEvent)).toBe(true);
    });
  });

  describe("validation", () => {
    it("rejects unknown event types", () => {
      const data: EventRegistryData = {
        mappings: [
          { eventType: "unknown_event_type", pipelineTemplate: "SEO Cycle", priority: "P1" },
        ],
      };
      expect(() => EventRegistry.fromData(data)).toThrow(EventRegistryError);
    });

    it("rejects invalid priority values", () => {
      const data: EventRegistryData = {
        mappings: [
          { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P9" },
        ],
      };
      expect(() => EventRegistry.fromData(data)).toThrow(EventRegistryError);
    });

    it("rejects missing mappings key", () => {
      const data = { notMappings: [] };
      expect(() => EventRegistry.fromData(data as unknown as EventRegistryData)).toThrow(
        EventRegistryError,
      );
    });

    it("rejects non-object root", () => {
      expect(() => EventRegistry.fromData(null as unknown as EventRegistryData)).toThrow(
        EventRegistryError,
      );
    });

    it("rejects negative cooldownMs", () => {
      const data: EventRegistryData = {
        mappings: [
          { eventType: "traffic_drop", pipelineTemplate: "SEO Cycle", priority: "P1", cooldownMs: -1 },
        ],
      };
      expect(() => EventRegistry.fromData(data)).toThrow(EventRegistryError);
    });

    it("includes all validation errors in the error object", () => {
      const data = {
        mappings: [{ eventType: "unknown_type", priority: "P9" }],
      };
      try {
        EventRegistry.fromData(data as unknown as EventRegistryData);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EventRegistryError);
        const regErr = err as EventRegistryError;
        expect(regErr.errors.length).toBeGreaterThanOrEqual(3);
      }
    });
  });
});

// ── Exports ──────────────────────────────────────────────────────────────────

describe("EventRegistry exports", () => {
  it("is exported from events/index.ts", async () => {
    const mod = await import("../index.ts");
    expect(mod.EventRegistry).toBeDefined();
    expect(mod.EventRegistryError).toBeDefined();
  });

  it("is exported from src/index.ts", async () => {
    const mod = await import("../../index.ts");
    expect(mod.EventRegistry).toBeDefined();
    expect(mod.EventRegistryError).toBeDefined();
  });
});
