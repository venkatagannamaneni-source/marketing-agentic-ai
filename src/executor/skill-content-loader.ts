import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SkillName } from "../types/agent.ts";
import type { SkillContent } from "./types.ts";
import { loadSkillMeta } from "../agents/skill-loader.ts";
import { parseFrontmatter } from "../workspace/markdown.ts";

/**
 * Load full skill content for agent execution: metadata + body + reference file contents.
 * Extends loadSkillMeta() with the SKILL.md body text and loaded reference files.
 */
export async function loadSkillContent(
  skillName: SkillName,
  projectRoot: string,
): Promise<SkillContent> {
  const meta = await loadSkillMeta(skillName, projectRoot);

  // Read the full SKILL.md to extract the body (content after frontmatter)
  const rawContent = await readFile(meta.skillFilePath, "utf-8");
  const { body } = parseFrontmatter(rawContent);

  // Load reference file contents (non-fatal on failure)
  const referenceContents: { path: string; content: string }[] = [];
  for (const refPath of meta.referenceFiles) {
    try {
      const content = await readFile(refPath, "utf-8");
      referenceContents.push({
        path: basename(refPath),
        content,
      });
    } catch {
      // Reference file missing or unreadable — skip silently.
      // Don't crash the executor because a reference was deleted.
    }
  }

  return {
    ...meta,
    body,
    referenceContents,
  };
}
