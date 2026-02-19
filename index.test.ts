import { describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";

describe("marketing-agentic-ai", () => {
  it("has product-marketing-context skill installed", () => {
    const skillPath = resolve(
      import.meta.dir,
      ".agents/skills/product-marketing-context/SKILL.md"
    );
    expect(existsSync(skillPath)).toBe(true);
  });

  it("has all 26 skills symlinked in .claude/skills", () => {
    const skillsDir = resolve(import.meta.dir, ".claude/skills");
    expect(existsSync(skillsDir)).toBe(true);
  });
});
