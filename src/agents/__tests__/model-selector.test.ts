import { describe, expect, it } from "bun:test";
import { selectModelTier } from "../model-selector.ts";
import type { BudgetState } from "../../director/types.ts";

describe("selectModelTier", () => {
  // ── Strategy Squad → opus ───────────────────────────────────────────────

  it("selects opus for content-strategy (strategy squad)", () => {
    expect(selectModelTier("content-strategy")).toBe("opus");
  });

  it("selects opus for pricing-strategy (strategy squad)", () => {
    expect(selectModelTier("pricing-strategy")).toBe("opus");
  });

  it("selects opus for launch-strategy (strategy squad)", () => {
    expect(selectModelTier("launch-strategy")).toBe("opus");
  });

  it("selects opus for marketing-ideas (strategy squad)", () => {
    expect(selectModelTier("marketing-ideas")).toBe("opus");
  });

  it("selects opus for marketing-psychology (strategy squad)", () => {
    expect(selectModelTier("marketing-psychology")).toBe("opus");
  });

  it("selects opus for competitor-alternatives (strategy squad)", () => {
    expect(selectModelTier("competitor-alternatives")).toBe("opus");
  });

  // ── Foundation → opus ─────────────────────────────────────────────────

  it("selects opus for product-marketing-context (foundation, null squad)", () => {
    expect(selectModelTier("product-marketing-context")).toBe("opus");
  });

  // ── Creative Squad → sonnet ───────────────────────────────────────────

  it("selects sonnet for copywriting (creative squad)", () => {
    expect(selectModelTier("copywriting")).toBe("sonnet");
  });

  it("selects sonnet for copy-editing (creative squad)", () => {
    expect(selectModelTier("copy-editing")).toBe("sonnet");
  });

  it("selects sonnet for social-content (creative squad)", () => {
    expect(selectModelTier("social-content")).toBe("sonnet");
  });

  it("selects sonnet for cold-email (creative squad)", () => {
    expect(selectModelTier("cold-email")).toBe("sonnet");
  });

  it("selects sonnet for paid-ads (creative squad)", () => {
    expect(selectModelTier("paid-ads")).toBe("sonnet");
  });

  // ── Convert Squad → sonnet ────────────────────────────────────────────

  it("selects sonnet for page-cro (convert squad)", () => {
    expect(selectModelTier("page-cro")).toBe("sonnet");
  });

  it("selects sonnet for signup-flow-cro (convert squad)", () => {
    expect(selectModelTier("signup-flow-cro")).toBe("sonnet");
  });

  // ── Activate Squad → sonnet ───────────────────────────────────────────

  it("selects sonnet for onboarding-cro (activate squad)", () => {
    expect(selectModelTier("onboarding-cro")).toBe("sonnet");
  });

  it("selects sonnet for email-sequence (activate squad)", () => {
    expect(selectModelTier("email-sequence")).toBe("sonnet");
  });

  // ── Measure Squad → sonnet ────────────────────────────────────────────

  it("selects sonnet for analytics-tracking (measure squad)", () => {
    expect(selectModelTier("analytics-tracking")).toBe("sonnet");
  });

  it("selects sonnet for seo-audit (measure squad)", () => {
    expect(selectModelTier("seo-audit")).toBe("sonnet");
  });

  // ── Budget override ───────────────────────────────────────────────────

  it("budget modelOverride haiku overrides strategy squad opus", () => {
    const budget: BudgetState = {
      totalBudget: 1000,
      spent: 960,
      percentUsed: 96,
      level: "critical",
      allowedPriorities: ["P0"],
      modelOverride: "haiku",
    };
    expect(selectModelTier("content-strategy", budget)).toBe("haiku");
  });

  it("budget modelOverride haiku overrides creative squad sonnet", () => {
    const budget: BudgetState = {
      totalBudget: 1000,
      spent: 960,
      percentUsed: 96,
      level: "critical",
      allowedPriorities: ["P0"],
      modelOverride: "haiku",
    };
    expect(selectModelTier("copywriting", budget)).toBe("haiku");
  });

  it("budget modelOverride sonnet overrides strategy squad opus", () => {
    const budget: BudgetState = {
      totalBudget: 1000,
      spent: 910,
      percentUsed: 91,
      level: "throttle",
      allowedPriorities: ["P0", "P1"],
      modelOverride: "sonnet",
    };
    expect(selectModelTier("content-strategy", budget)).toBe("sonnet");
  });

  it("null budget modelOverride uses default selection", () => {
    const budget: BudgetState = {
      totalBudget: 1000,
      spent: 100,
      percentUsed: 10,
      level: "normal",
      allowedPriorities: ["P0", "P1", "P2", "P3"],
      modelOverride: null,
    };
    expect(selectModelTier("content-strategy", budget)).toBe("opus");
    expect(selectModelTier("copywriting", budget)).toBe("sonnet");
  });

  it("undefined budgetState uses default selection", () => {
    expect(selectModelTier("content-strategy", undefined)).toBe("opus");
    expect(selectModelTier("copywriting", undefined)).toBe("sonnet");
  });

  // ── Config override ───────────────────────────────────────────────────

  it("configOverride takes highest priority over everything", () => {
    const budget: BudgetState = {
      totalBudget: 1000,
      spent: 960,
      percentUsed: 96,
      level: "critical",
      allowedPriorities: ["P0"],
      modelOverride: "haiku",
    };
    // configOverride opus beats budget haiku beats squad sonnet
    expect(selectModelTier("copywriting", budget, "opus")).toBe("opus");
  });

  it("configOverride beats budget override", () => {
    const budget: BudgetState = {
      totalBudget: 1000,
      spent: 960,
      percentUsed: 96,
      level: "critical",
      allowedPriorities: ["P0"],
      modelOverride: "haiku",
    };
    expect(selectModelTier("content-strategy", budget, "sonnet")).toBe(
      "sonnet",
    );
  });

  it("configOverride without budget uses config", () => {
    expect(selectModelTier("copywriting", undefined, "opus")).toBe("opus");
  });
});
