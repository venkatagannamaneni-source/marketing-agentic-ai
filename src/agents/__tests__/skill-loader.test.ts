import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { loadSkillMeta, loadAllSkills } from "../skill-loader.ts";
import { SKILL_NAMES } from "../../types/agent.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

describe("loadSkillMeta", () => {
  it("loads copywriting skill metadata", async () => {
    const meta = await loadSkillMeta("copywriting", PROJECT_ROOT);

    expect(meta.name).toBe("copywriting");
    expect(meta.description).toBeTruthy();
    expect(meta.version).toBeTruthy();
    expect(meta.squad).toBe("creative");
    expect(meta.skillFilePath).toContain("copywriting/SKILL.md");
  });

  it("discovers reference files for skills that have them", async () => {
    const meta = await loadSkillMeta("copywriting", PROJECT_ROOT);
    expect(meta.referenceFiles.length).toBeGreaterThan(0);
    expect(meta.referenceFiles.every((f) => f.endsWith(".md"))).toBe(true);
  });

  it("returns empty referenceFiles for skills without references dir", async () => {
    const meta = await loadSkillMeta("content-strategy", PROJECT_ROOT);
    expect(meta.referenceFiles).toHaveLength(0);
  });

  it("maps product-marketing-context squad to null", async () => {
    const meta = await loadSkillMeta(
      "product-marketing-context",
      PROJECT_ROOT,
    );
    expect(meta.squad).toBeNull();
  });

  it("strips quotes from description", async () => {
    const meta = await loadSkillMeta("copywriting", PROJECT_ROOT);
    expect(meta.description).not.toMatch(/^["']/);
    expect(meta.description).not.toMatch(/["']$/);
  });
});

describe("loadAllSkills", () => {
  it("loads all 26 skills", async () => {
    const skills = await loadAllSkills(PROJECT_ROOT);
    expect(skills.size).toBe(26);
  });

  it("every SKILL_NAME has a loaded entry", async () => {
    const skills = await loadAllSkills(PROJECT_ROOT);
    for (const name of SKILL_NAMES) {
      expect(skills.has(name)).toBe(true);
    }
  });

  it("all loaded skills have required fields", async () => {
    const skills = await loadAllSkills(PROJECT_ROOT);
    for (const [name, meta] of skills) {
      expect(meta.name).toBe(name);
      expect(typeof meta.description).toBe("string");
      expect(typeof meta.version).toBe("string");
      expect(meta.skillFilePath).toContain("SKILL.md");
      expect(Array.isArray(meta.referenceFiles)).toBe(true);
    }
  });
});
