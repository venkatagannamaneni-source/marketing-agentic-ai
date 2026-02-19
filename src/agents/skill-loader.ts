import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentMeta, SkillName } from "../types/agent.ts";
import { SKILL_NAMES, SKILL_SQUAD_MAP } from "../types/agent.ts";
import { parseFrontmatter } from "../workspace/markdown.ts";
import { WorkspaceError } from "../workspace/errors.ts";

// ── Default Paths ────────────────────────────────────────────────────────────

const DEFAULT_SKILLS_DIR = ".agents/skills";

// ── Skill Loader ─────────────────────────────────────────────────────────────

/**
 * Load metadata for a single skill from its SKILL.md file.
 */
export async function loadSkillMeta(
  skillName: SkillName,
  projectRoot: string,
): Promise<AgentMeta> {
  const skillDir = resolve(projectRoot, DEFAULT_SKILLS_DIR, skillName);
  const skillFilePath = resolve(skillDir, "SKILL.md");

  let content: string;
  try {
    content = await readFile(skillFilePath, "utf-8");
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      throw new WorkspaceError(
        `SKILL.md not found for ${skillName}`,
        "NOT_FOUND",
        skillFilePath,
      );
    }
    throw new WorkspaceError(
      `Failed to read SKILL.md for ${skillName}`,
      "READ_FAILED",
      skillFilePath,
    );
  }

  const { frontmatter } = parseFrontmatter(content);

  const name = (frontmatter["name"] as string | undefined) ?? skillName;
  const description = (frontmatter["description"] as string | undefined) ?? "";
  // Version may be nested under metadata in some SKILL.md files
  const version = extractVersion(frontmatter);

  const referenceFiles = await discoverReferenceFiles(skillDir);

  return {
    name: name as SkillName,
    description: stripQuotes(description),
    version,
    squad: SKILL_SQUAD_MAP[skillName] ?? null,
    skillFilePath,
    referenceFiles,
  };
}

/**
 * Load metadata for all 26 skills.
 */
export async function loadAllSkills(
  projectRoot: string,
): Promise<Map<SkillName, AgentMeta>> {
  const skills = new Map<SkillName, AgentMeta>();

  for (const skillName of SKILL_NAMES) {
    const meta = await loadSkillMeta(skillName, projectRoot);
    skills.set(skillName, meta);
  }

  return skills;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function discoverReferenceFiles(skillDir: string): Promise<string[]> {
  const refsDir = resolve(skillDir, "references");
  try {
    await stat(refsDir);
  } catch {
    return [];
  }

  const entries = await readdir(refsDir);
  return entries
    .filter((e) => e.endsWith(".md"))
    .sort()
    .map((e) => resolve(refsDir, e));
}

/**
 * Extract version from frontmatter. Some SKILL.md files have:
 *   metadata:
 *     version: 1.0.0
 * which our simple parser reads as key "metadata" with no value.
 * Look for "version" key directly, or default to "1.0.0".
 */
function extractVersion(frontmatter: Record<string, string>): string {
  if (frontmatter["version"]) {
    return frontmatter["version"];
  }
  return "1.0.0";
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
