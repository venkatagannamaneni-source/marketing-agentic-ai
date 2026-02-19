import { describe, expect, it } from "bun:test";
import { routeGoal, selectSkills, ROUTING_RULES } from "../squad-router.ts";
import { GOAL_CATEGORIES } from "../types.ts";
import type { GoalCategory } from "../types.ts";

describe("ROUTING_RULES", () => {
  it("has a rule for every goal category", () => {
    for (const category of GOAL_CATEGORIES) {
      expect(ROUTING_RULES[category]).toBeDefined();
      expect(ROUTING_RULES[category].length).toBeGreaterThan(0);
    }
  });
});

describe("routeGoal", () => {
  it("routes strategic goals to strategy squad first, then measure", () => {
    const decision = routeGoal("strategic");
    expect(decision.goalCategory).toBe("strategic");
    expect(decision.routes[0]!.squad).toBe("strategy");
    expect(decision.routes[decision.routes.length - 1]!.squad).toBe("measure");
  });

  it("routes content goals to strategy then creative then measure", () => {
    const decision = routeGoal("content");
    const squads = decision.routes.map((r) => r.squad);
    expect(squads).toEqual(["strategy", "creative", "measure"]);
  });

  it("routes optimization goals to convert then creative then measure", () => {
    const decision = routeGoal("optimization");
    const squads = decision.routes.map((r) => r.squad);
    expect(squads).toEqual(["convert", "creative", "measure"]);
  });

  it("routes retention goals to activate then measure", () => {
    const decision = routeGoal("retention");
    const squads = decision.routes.map((r) => r.squad);
    expect(squads).toEqual(["activate", "measure"]);
  });

  it("routes competitive goals through strategy, creative, strategy, measure", () => {
    const decision = routeGoal("competitive");
    const squads = decision.routes.map((r) => r.squad);
    expect(squads).toEqual(["strategy", "creative", "strategy", "measure"]);
  });

  it("routes measurement goals directly to measure squad", () => {
    const decision = routeGoal("measurement");
    const squads = decision.routes.map((r) => r.squad);
    expect(squads).toEqual(["measure"]);
  });

  it("always sets measureSquadFinal to true", () => {
    for (const category of GOAL_CATEGORIES) {
      const decision = routeGoal(category);
      expect(decision.measureSquadFinal).toBe(true);
    }
  });

  it("always ends with measure squad in routes", () => {
    for (const category of GOAL_CATEGORIES) {
      const decision = routeGoal(category);
      const lastRoute = decision.routes[decision.routes.length - 1]!;
      expect(lastRoute.squad).toBe("measure");
    }
  });

  it("includes skills for every route", () => {
    for (const category of GOAL_CATEGORIES) {
      const decision = routeGoal(category);
      for (const route of decision.routes) {
        expect(route.skills.length).toBeGreaterThan(0);
      }
    }
  });

  it("includes a reason for every route", () => {
    for (const category of GOAL_CATEGORIES) {
      const decision = routeGoal(category);
      for (const route of decision.routes) {
        expect(route.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("selectSkills", () => {
  it("returns de-duplicated list of skills from routing decision", () => {
    const decision = routeGoal("competitive");
    const skills = selectSkills(decision);
    // competitive has pricing-strategy in both a strategy route
    // but it should only appear once
    const uniqueSkills = [...new Set(skills)];
    expect(skills.length).toBe(uniqueSkills.length);
  });

  it("preserves ordering from route sequence", () => {
    const decision = routeGoal("content");
    const skills = selectSkills(decision);
    // First skill should be from strategy squad
    expect(skills[0]).toBe("content-strategy");
    // Last skills should be from measure squad
    expect(skills.includes("seo-audit")).toBe(true);
    expect(skills.includes("analytics-tracking")).toBe(true);
  });

  it("includes all skills from all routes", () => {
    for (const category of GOAL_CATEGORIES) {
      const decision = routeGoal(category);
      const skills = selectSkills(decision);
      const allSkills = decision.routes.flatMap((r) => [...r.skills]);
      const uniqueAll = [...new Set(allSkills)];
      expect(skills.length).toBe(uniqueAll.length);
    }
  });
});
