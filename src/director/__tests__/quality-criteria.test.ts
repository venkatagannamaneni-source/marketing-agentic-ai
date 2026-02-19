import { describe, it, expect } from "bun:test";
import { DEFAULT_SKILL_CRITERIA, getSkillCriteria, resolveThreshold } from "../quality-criteria.ts";
import { DEFAULT_QUALITY_THRESHOLD } from "../../types/quality.ts";
import { SKILL_NAMES } from "../../types/agent.ts";

describe("quality-criteria", () => {
  describe("DEFAULT_SKILL_CRITERIA", () => {
    it("has entries for all 26 skills", () => {
      const criteriaKeys = Object.keys(DEFAULT_SKILL_CRITERIA);
      expect(criteriaKeys.length).toBe(26);
      for (const skill of SKILL_NAMES) {
        expect(DEFAULT_SKILL_CRITERIA[skill]).toBeDefined();
      }
    });

    it("each criteria entry has weights that sum to approximately 1.0", () => {
      for (const [skill, criteria] of Object.entries(DEFAULT_SKILL_CRITERIA)) {
        const weightSum = criteria.dimensions.reduce((sum, d) => sum + d.weight, 0);
        expect(weightSum).toBeCloseTo(1.0, 5);
      }
    });

    it("each criteria entry has all dimensions with non-negative weights", () => {
      for (const [skill, criteria] of Object.entries(DEFAULT_SKILL_CRITERIA)) {
        for (const dim of criteria.dimensions) {
          expect(dim.weight).toBeGreaterThanOrEqual(0);
          expect(dim.minScore).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe("getSkillCriteria", () => {
    it("returns defaults for known skills", () => {
      const criteria = getSkillCriteria("page-cro");
      expect(criteria.skill).toBe("page-cro");
      expect(criteria.dimensions.length).toBe(7);
      expect(criteria.threshold).toEqual(DEFAULT_QUALITY_THRESHOLD);
    });

    it("returns fallback for unknown skills", () => {
      const criteria = getSkillCriteria("nonexistent-skill");
      expect(criteria.skill).toBe("nonexistent-skill");
      expect(criteria.dimensions.length).toBe(7);
      expect(criteria.requiredSections).toEqual([]);
      expect(criteria.minWordCount).toBe(100);
      expect(criteria.threshold).toEqual(DEFAULT_QUALITY_THRESHOLD);
    });

    it("merges overrides correctly", () => {
      const criteria = getSkillCriteria("page-cro", {
        minWordCount: 500,
        requiredSections: ["Custom Section"],
      });
      expect(criteria.minWordCount).toBe(500);
      expect(criteria.requiredSections).toEqual(["Custom Section"]);
      // Non-overridden fields remain as defaults
      expect(criteria.skill).toBe("page-cro");
      expect(criteria.dimensions.length).toBe(7);
    });

    it("preserves skill name from defaults even with overrides", () => {
      const criteria = getSkillCriteria("page-cro", {
        skill: "overridden-name",
        minWordCount: 999,
      } as any);
      expect(criteria.skill).toBe("page-cro");
    });
  });

  describe("resolveThreshold", () => {
    it("returns skill-specific threshold when defined", () => {
      const threshold = resolveThreshold("page-cro");
      expect(threshold).toEqual(DEFAULT_QUALITY_THRESHOLD);
    });

    it("falls back to DEFAULT_QUALITY_THRESHOLD for unknown skills", () => {
      const threshold = resolveThreshold("nonexistent-skill");
      expect(threshold).toEqual(DEFAULT_QUALITY_THRESHOLD);
    });

    it("uses customThresholds when provided", () => {
      const custom = {
        "page-cro": { approveAbove: 8.0, reviseBelow: 6.0, rejectBelow: 3.0 },
      };
      const threshold = resolveThreshold("page-cro", custom);
      expect(threshold.approveAbove).toBe(8.0);
      expect(threshold.reviseBelow).toBe(6.0);
      expect(threshold.rejectBelow).toBe(3.0);
    });
  });

  describe("squad-specific dimension weights", () => {
    it("strategy skills have high completeness weight", () => {
      const strategySkills = [
        "content-strategy",
        "pricing-strategy",
        "launch-strategy",
        "marketing-ideas",
        "marketing-psychology",
        "competitor-alternatives",
      ] as const;
      for (const skill of strategySkills) {
        const criteria = getSkillCriteria(skill);
        const completeness = criteria.dimensions.find(
          (d) => d.dimension === "completeness",
        );
        expect(completeness).toBeDefined();
        expect(completeness!.weight).toBeGreaterThanOrEqual(0.2);
      }
    });

    it("creative skills have high clarity weight", () => {
      const creativeSkills = [
        "copywriting",
        "copy-editing",
        "social-content",
        "cold-email",
        "paid-ads",
        "programmatic-seo",
      ] as const;
      for (const skill of creativeSkills) {
        const criteria = getSkillCriteria(skill);
        const clarity = criteria.dimensions.find(
          (d) => d.dimension === "clarity",
        );
        expect(clarity).toBeDefined();
        expect(clarity!.weight).toBeGreaterThanOrEqual(0.2);
      }
    });

    it("measure skills have high technical_accuracy weight", () => {
      const measureSkills = [
        "analytics-tracking",
        "ab-test-setup",
        "seo-audit",
      ] as const;
      for (const skill of measureSkills) {
        const criteria = getSkillCriteria(skill);
        const techAccuracy = criteria.dimensions.find(
          (d) => d.dimension === "technical_accuracy",
        );
        expect(techAccuracy).toBeDefined();
        expect(techAccuracy!.weight).toBeGreaterThanOrEqual(0.2);
      }
    });

    it("convert skills have high actionability weight", () => {
      const convertSkills = [
        "page-cro",
        "form-cro",
        "signup-flow-cro",
        "popup-cro",
        "free-tool-strategy",
      ] as const;
      for (const skill of convertSkills) {
        const criteria = getSkillCriteria(skill);
        const actionability = criteria.dimensions.find(
          (d) => d.dimension === "actionability",
        );
        expect(actionability).toBeDefined();
        expect(actionability!.weight).toBeGreaterThanOrEqual(0.2);
      }
    });

    it("activate skills have high actionability weight", () => {
      const activateSkills = [
        "onboarding-cro",
        "email-sequence",
        "paywall-upgrade-cro",
        "referral-program",
      ] as const;
      for (const skill of activateSkills) {
        const criteria = getSkillCriteria(skill);
        const actionability = criteria.dimensions.find(
          (d) => d.dimension === "actionability",
        );
        expect(actionability).toBeDefined();
        expect(actionability!.weight).toBeGreaterThanOrEqual(0.2);
      }
    });
  });
});
