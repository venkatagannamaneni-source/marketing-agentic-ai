import { describe, expect, it } from "bun:test";
import { SKILL_NAMES } from "../../types/agent.ts";
import {
  AGENT_DEPENDENCY_GRAPH,
  getUpstreamSkills,
  getDownstreamSkills,
  PIPELINE_TEMPLATES,
} from "../registry.ts";

describe("AGENT_DEPENDENCY_GRAPH", () => {
  it("has an entry for every skill", () => {
    for (const skill of SKILL_NAMES) {
      expect(skill in AGENT_DEPENDENCY_GRAPH).toBe(true);
    }
  });

  it("all downstream skills are valid SKILL_NAMES", () => {
    for (const [producer, consumers] of Object.entries(
      AGENT_DEPENDENCY_GRAPH,
    )) {
      for (const consumer of consumers) {
        expect(SKILL_NAMES).toContain(consumer);
      }
    }
  });

  it("product-marketing-context feeds 25 agents", () => {
    const consumers =
      AGENT_DEPENDENCY_GRAPH["product-marketing-context"];
    expect(consumers).toHaveLength(25);
    expect(consumers).not.toContain("product-marketing-context");
  });
});

describe("getUpstreamSkills", () => {
  it("returns correct producers for copywriting", () => {
    const upstream = getUpstreamSkills("copywriting");
    expect(upstream).toContain("content-strategy");
    expect(upstream).toContain("competitor-alternatives");
    expect(upstream).toContain("page-cro");
    expect(upstream).toContain("product-marketing-context");
  });

  it("returns product-marketing-context for every non-foundation skill", () => {
    for (const skill of SKILL_NAMES) {
      if (skill === "product-marketing-context") continue;
      const upstream = getUpstreamSkills(skill);
      expect(upstream).toContain("product-marketing-context");
    }
  });
});

describe("getDownstreamSkills", () => {
  it("returns correct consumers for content-strategy", () => {
    const downstream = getDownstreamSkills("content-strategy");
    expect(downstream).toContain("copywriting");
    expect(downstream).toContain("programmatic-seo");
    expect(downstream).toContain("social-content");
  });

  it("returns empty array for leaf nodes", () => {
    expect(getDownstreamSkills("social-content")).toHaveLength(0);
    expect(getDownstreamSkills("cold-email")).toHaveLength(0);
    expect(getDownstreamSkills("schema-markup")).toHaveLength(0);
  });
});

describe("PIPELINE_TEMPLATES", () => {
  it("has 8 pipeline templates", () => {
    expect(PIPELINE_TEMPLATES).toHaveLength(8);
  });

  it("all templates reference valid skills", () => {
    for (const template of PIPELINE_TEMPLATES) {
      for (const step of template.steps) {
        if (Array.isArray(step)) {
          for (const skill of step) {
            expect(SKILL_NAMES).toContain(skill);
          }
        } else {
          expect((SKILL_NAMES as readonly string[])).toContain(step as string);
        }
      }
    }
  });

  it("includes Content Production pipeline", () => {
    const cp = PIPELINE_TEMPLATES.find(
      (t) => t.name === "Content Production",
    );
    expect(cp).toBeDefined();
    expect(cp!.steps).toContain("copywriting");
  });

  it("includes Product Launch pipeline with parallel step", () => {
    const pl = PIPELINE_TEMPLATES.find(
      (t) => t.name === "Product Launch",
    );
    expect(pl).toBeDefined();
    const parallelStep = pl!.steps.find((s) => Array.isArray(s));
    expect(parallelStep).toBeDefined();
    expect(parallelStep).toContain("copywriting");
    expect(parallelStep).toContain("email-sequence");
  });
});
