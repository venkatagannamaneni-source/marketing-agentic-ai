import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { loadSkillContent } from "../skill-content-loader.ts";
import { WorkspaceError } from "../../workspace/errors.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

describe("loadSkillContent", () => {
  it("loads copywriting skill with body and references", async () => {
    const content = await loadSkillContent("copywriting", PROJECT_ROOT);

    expect(content.name).toBe("copywriting");
    expect(content.squad).toBe("creative");
    expect(content.body).toBeTruthy();
    expect(content.body.length).toBeGreaterThan(100);

    // Body should contain skill instructions, not frontmatter
    expect(content.body).toContain("expert conversion copywriter");
    expect(content.body).not.toStartWith("---");

    // Copywriting has 2 reference files
    expect(content.referenceContents.length).toBe(2);
    const refNames = content.referenceContents.map((r) => r.path);
    expect(refNames).toContain("copy-frameworks.md");
    expect(refNames).toContain("natural-transitions.md");

    // Reference contents should be non-empty
    for (const ref of content.referenceContents) {
      expect(ref.content.length).toBeGreaterThan(0);
    }
  });

  it("loads skill with no reference files", async () => {
    // content-strategy has no references/ directory
    const content = await loadSkillContent("content-strategy", PROJECT_ROOT);

    expect(content.name).toBe("content-strategy");
    expect(content.squad).toBe("strategy");
    expect(content.body).toBeTruthy();
    expect(content.referenceContents).toHaveLength(0);
  });

  it("loads foundation skill (product-marketing-context)", async () => {
    const content = await loadSkillContent(
      "product-marketing-context",
      PROJECT_ROOT,
    );

    expect(content.name).toBe("product-marketing-context");
    expect(content.squad).toBeNull();
    expect(content.body).toBeTruthy();
  });

  it("throws WorkspaceError for non-existent skill", async () => {
    try {
      // "marketing-ideas" exists but we'll test with the loading mechanism
      // by using a bad project root
      await loadSkillContent("copywriting", "/nonexistent/path");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe("NOT_FOUND");
    }
  });

  it("body does not include frontmatter delimiters", async () => {
    const content = await loadSkillContent("seo-audit", PROJECT_ROOT);

    // Body should be the content after frontmatter, not containing ---
    // (unless --- is used as a section divider in the body)
    expect(content.body).not.toStartWith("---");
    expect(content.body).not.toMatch(/^name:/m);
    expect(content.body).not.toMatch(/^description:/m);
  });

  it("preserves all metadata fields from loadSkillMeta", async () => {
    const content = await loadSkillContent("page-cro", PROJECT_ROOT);

    expect(content.name).toBe("page-cro");
    expect(content.description).toBeTruthy();
    expect(content.version).toBeTruthy();
    expect(content.squad).toBe("convert");
    expect(content.skillFilePath).toContain("page-cro/SKILL.md");
    expect(Array.isArray(content.referenceFiles)).toBe(true);
  });
});
