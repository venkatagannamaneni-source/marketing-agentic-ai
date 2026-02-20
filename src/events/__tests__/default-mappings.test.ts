import { describe, it, expect } from "bun:test";
import { DEFAULT_EVENT_MAPPINGS } from "../default-mappings.ts";
import { EVENT_TYPES } from "../../types/events.ts";
import type { SystemEvent } from "../../types/events.ts";
import { PIPELINE_TEMPLATES } from "../../agents/registry.ts";
import { PRIORITIES } from "../../types/task.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_TEMPLATE_NAMES = new Set(PIPELINE_TEMPLATES.map((t) => t.name));
const VALID_EVENT_TYPES = new Set<string>(EVENT_TYPES);
const VALID_PRIORITIES = new Set<string>(PRIORITIES);

function createEventForCondition(
  type: string,
  data: Record<string, unknown>,
): SystemEvent {
  return {
    id: `test-${Date.now()}`,
    type: type as SystemEvent["type"],
    timestamp: new Date().toISOString(),
    source: "test",
    data,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DEFAULT_EVENT_MAPPINGS", () => {
  describe("structural validation", () => {
    it("every mapping has a valid eventType", () => {
      for (const mapping of DEFAULT_EVENT_MAPPINGS) {
        expect(VALID_EVENT_TYPES.has(mapping.eventType)).toBe(true);
      }
    });

    it("every mapping references an existing pipeline template name", () => {
      for (const mapping of DEFAULT_EVENT_MAPPINGS) {
        expect(VALID_TEMPLATE_NAMES.has(mapping.pipelineTemplate)).toBe(true);
      }
    });

    it("every mapping has a valid priority", () => {
      for (const mapping of DEFAULT_EVENT_MAPPINGS) {
        expect(VALID_PRIORITIES.has(mapping.priority)).toBe(true);
      }
    });

    it("all mappings have a cooldownMs value", () => {
      for (const mapping of DEFAULT_EVENT_MAPPINGS) {
        expect(typeof mapping.cooldownMs).toBe("number");
        expect(mapping.cooldownMs!).toBeGreaterThan(0);
      }
    });

    it("has expected number of mappings", () => {
      expect(DEFAULT_EVENT_MAPPINGS.length).toBe(7);
    });
  });

  describe("traffic_drop condition", () => {
    const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "traffic_drop")!;

    it("exists with SEO Cycle pipeline", () => {
      expect(mapping).toBeDefined();
      expect(mapping.pipelineTemplate).toBe("SEO Cycle");
      expect(mapping.priority).toBe("P1");
    });

    it("rejects drops <= 20%", () => {
      const event = createEventForCondition("traffic_drop", { percentageDrop: 20 });
      expect(mapping.condition!(event)).toBe(false);
    });

    it("accepts drops > 20%", () => {
      const event = createEventForCondition("traffic_drop", { percentageDrop: 21 });
      expect(mapping.condition!(event)).toBe(true);
    });

    it("rejects non-numeric percentageDrop", () => {
      const event = createEventForCondition("traffic_drop", { percentageDrop: "high" });
      expect(mapping.condition!(event)).toBe(false);
    });

    it("rejects missing percentageDrop", () => {
      const event = createEventForCondition("traffic_drop", {});
      expect(mapping.condition!(event)).toBe(false);
    });
  });

  describe("conversion_drop condition", () => {
    const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "conversion_drop")!;

    it("exists with Conversion Sprint pipeline", () => {
      expect(mapping).toBeDefined();
      expect(mapping.pipelineTemplate).toBe("Conversion Sprint");
      expect(mapping.priority).toBe("P0");
    });

    it("rejects drops <= 10%", () => {
      const event = createEventForCondition("conversion_drop", { percentageDrop: 10 });
      expect(mapping.condition!(event)).toBe(false);
    });

    it("accepts drops > 10%", () => {
      const event = createEventForCondition("conversion_drop", { percentageDrop: 11 });
      expect(mapping.condition!(event)).toBe(true);
    });

    it("rejects non-numeric percentageDrop", () => {
      const event = createEventForCondition("conversion_drop", { percentageDrop: null });
      expect(mapping.condition!(event)).toBe(false);
    });
  });

  describe("email_bounce_spike condition", () => {
    const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "email_bounce_spike")!;

    it("exists with Retention Sprint pipeline", () => {
      expect(mapping).toBeDefined();
      expect(mapping.pipelineTemplate).toBe("Retention Sprint");
      expect(mapping.priority).toBe("P1");
    });

    it("rejects spikes <= 15%", () => {
      const event = createEventForCondition("email_bounce_spike", { percentageSpike: 15 });
      expect(mapping.condition!(event)).toBe(false);
    });

    it("accepts spikes > 15%", () => {
      const event = createEventForCondition("email_bounce_spike", { percentageSpike: 16 });
      expect(mapping.condition!(event)).toBe(true);
    });

    it("rejects non-numeric percentageSpike", () => {
      const event = createEventForCondition("email_bounce_spike", { percentageSpike: undefined });
      expect(mapping.condition!(event)).toBe(false);
    });
  });

  describe("mappings without conditions", () => {
    it("competitor_launch has no condition", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "competitor_launch")!;
      expect(mapping).toBeDefined();
      expect(mapping.condition).toBeUndefined();
      expect(mapping.pipelineTemplate).toBe("Competitive Response");
      expect(mapping.priority).toBe("P1");
    });

    it("new_feature_shipped has no condition", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "new_feature_shipped")!;
      expect(mapping).toBeDefined();
      expect(mapping.condition).toBeUndefined();
      expect(mapping.pipelineTemplate).toBe("Page Launch");
      expect(mapping.priority).toBe("P1");
    });

    it("new_blog_post has no condition", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "new_blog_post")!;
      expect(mapping).toBeDefined();
      expect(mapping.condition).toBeUndefined();
      expect(mapping.pipelineTemplate).toBe("Content Production");
      expect(mapping.priority).toBe("P2");
    });

    it("ab_test_significant has no condition", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "ab_test_significant")!;
      expect(mapping).toBeDefined();
      expect(mapping.condition).toBeUndefined();
      expect(mapping.pipelineTemplate).toBe("Conversion Sprint");
      expect(mapping.priority).toBe("P1");
    });
  });

  describe("internal events are excluded", () => {
    it("does not include budget_warning mapping", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "budget_warning");
      expect(mapping).toBeUndefined();
    });

    it("does not include budget_critical mapping", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "budget_critical");
      expect(mapping).toBeUndefined();
    });

    it("does not include agent_failure mapping", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "agent_failure");
      expect(mapping).toBeUndefined();
    });

    it("does not include pipeline_blocked mapping", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "pipeline_blocked");
      expect(mapping).toBeUndefined();
    });

    it("does not include manual_goal mapping", () => {
      const mapping = DEFAULT_EVENT_MAPPINGS.find((m) => m.eventType === "manual_goal");
      expect(mapping).toBeUndefined();
    });
  });
});
