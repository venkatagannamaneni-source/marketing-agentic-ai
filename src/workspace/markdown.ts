import type { Task, TaskInput, TaskNext, TaskFrom } from "../types/task.ts";
import type {
  Review,
  ReviewFinding,
  RevisionRequest,
  FindingSeverity,
  RevisionPriority,
} from "../types/review.ts";
import type { LearningEntry } from "../types/workspace.ts";
import type { SkillName } from "../types/agent.ts";
import type { Goal, GoalPlan, GoalPhase } from "../types/goal.ts";
import { GOAL_CATEGORIES } from "../types/goal.ts";
import { TASK_STATUSES, PRIORITIES } from "../types/task.ts";
import { REVIEW_VERDICTS } from "../types/review.ts";
import { SKILL_NAMES } from "../types/agent.ts";
import { WorkspaceError } from "./errors.ts";

const VALID_FROM_VALUES: readonly string[] = [
  ...SKILL_NAMES,
  "director",
  "scheduler",
  "event-bus",
];

// ── Frontmatter Parser ───────────────────────────────────────────────────────

export interface ParsedMarkdown {
  readonly frontmatter: Record<string, string>;
  readonly body: string;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Handles the subset of YAML we use: simple key: value pairs, one per line.
 * Splits on the FIRST colon per line to handle values containing colons.
 */
export function parseFrontmatter(markdown: string): ParsedMarkdown {
  const trimmed = markdown.trim();

  // Frontmatter delimiters must be --- on their own line (with optional trailing whitespace).
  // This prevents false matches on --- appearing inside body content.
  const fmPattern = /^---[ \t]*\n([\s\S]*?\n)?---[ \t]*(?:\n([\s\S]*))?$/;
  const match = trimmed.match(fmPattern);

  if (!match) {
    // Detect malformed frontmatter: starts with --- but no valid closing ---
    if (/^---[ \t]*\n/.test(trimmed) && !/\n---[ \t]*(\n|$)/.test(trimmed)) {
      throw new WorkspaceError(
        "Malformed frontmatter: missing closing ---",
        "PARSE_ERROR",
      );
    }
    return { frontmatter: {}, body: trimmed };
  }

  const frontmatterStr = (match[1] ?? "").trim();
  const body = (match[2] ?? "").trim();

  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterStr.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ── Task Serialization ───────────────────────────────────────────────────────

export function serializeTask(task: Task): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`id: ${task.id}`);
  lines.push(`status: ${task.status}`);
  lines.push(`priority: ${task.priority}`);
  lines.push(`from: ${task.from}`);
  lines.push(`to: ${task.to}`);
  lines.push(`created_at: ${task.createdAt}`);
  lines.push(`updated_at: ${task.updatedAt}`);
  if (task.deadline) lines.push(`deadline: ${task.deadline}`);
  if (task.goalId) lines.push(`goal_id: ${task.goalId}`);
  if (task.pipelineId) lines.push(`pipeline_id: ${task.pipelineId}`);
  lines.push(`revision_count: ${task.revisionCount}`);
  lines.push(`output_path: ${task.output.path}`);
  lines.push(`output_format: ${task.output.format}`);
  lines.push(`next_type: ${task.next.type}`);
  if (task.next.type === "agent") lines.push(`next_skill: ${task.next.skill}`);
  if (task.next.type === "pipeline_continue")
    lines.push(`next_pipeline: ${task.next.pipelineId}`);
  if (task.tags.length > 0) lines.push(`tags: ${task.tags.join(", ")}`);
  if (Object.keys(task.metadata).length > 0) {
    lines.push(`metadata: ${JSON.stringify(task.metadata)}`);
  }
  lines.push("---");
  lines.push("");

  // Readable markdown body
  lines.push(`# Task: ${task.id}`);
  lines.push("");
  lines.push("## Assignment");
  lines.push(`- **From:** ${task.from}`);
  lines.push(`- **To:** ${task.to}`);
  lines.push(`- **Priority:** ${task.priority}`);
  lines.push(`- **Deadline:** ${task.deadline ?? "next cycle"}`);
  lines.push("");
  lines.push("## Context");
  lines.push(`- **Goal:** ${task.goal}`);
  lines.push("- **Input files:**");
  for (const input of task.inputs) {
    lines.push(`  - \`${input.path}\` — ${input.description}`);
  }
  lines.push("");
  lines.push("## Requirements");
  lines.push("");
  lines.push(task.requirements);
  lines.push("");
  lines.push("## Output");
  lines.push(`- **Write to:** \`${task.output.path}\``);
  lines.push(`- **Format:** ${task.output.format}`);
  lines.push(`- **Then:** ${formatNext(task.next)}`);
  lines.push("");

  return lines.join("\n");
}

function formatNext(next: TaskNext): string {
  switch (next.type) {
    case "agent":
      return `Send to ${next.skill}`;
    case "director_review":
      return "Return to Director for review";
    case "pipeline_continue":
      return `Continue pipeline ${next.pipelineId}`;
    case "complete":
      return "Task complete";
  }
}

export function deserializeTask(markdown: string): Task {
  const { frontmatter: fm, body } = parseFrontmatter(markdown);

  const id = requireField(fm, "id");
  const status = requireEnum(fm, "status", TASK_STATUSES);
  const priority = requireEnum(fm, "priority", PRIORITIES);
  const from = requireEnum(fm, "from", VALID_FROM_VALUES) as TaskFrom;
  const to = requireEnum(fm, "to", SKILL_NAMES);
  const createdAt = requireField(fm, "created_at");
  const updatedAt = requireField(fm, "updated_at");
  const deadline = fm["deadline"] ?? null;
  const goalId = fm["goal_id"] ?? null;
  const pipelineId = fm["pipeline_id"] ?? null;
  const revisionCountStr = requireField(fm, "revision_count");
  const revisionCount = parseInt(revisionCountStr, 10);
  if (Number.isNaN(revisionCount) || revisionCount < 0) {
    throw new WorkspaceError(
      `Invalid revision_count: "${revisionCountStr}"`,
      "PARSE_ERROR",
    );
  }
  const outputPath = requireField(fm, "output_path");
  const outputFormat = requireField(fm, "output_format");
  const nextType = requireField(fm, "next_type");
  const tags = fm["tags"] ? fm["tags"].split(",").map((t) => t.trim()) : [];

  const next = parseNext(nextType, fm);
  const goal = extractBodySection(body, "Context", "goal");
  const inputs = extractInputFiles(body);
  const requirements = extractSection(body, "Requirements");

  return {
    id,
    createdAt,
    updatedAt,
    from,
    to,
    priority,
    deadline,
    status,
    revisionCount,
    goalId,
    pipelineId,
    goal,
    inputs,
    requirements,
    output: { path: outputPath, format: outputFormat },
    next,
    tags,
    metadata: parseMetadata(fm["metadata"]),
  };
}

// ── Review Serialization ─────────────────────────────────────────────────────

export function serializeReview(review: Review): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`id: ${review.id}`);
  lines.push(`task_id: ${review.taskId}`);
  lines.push(`created_at: ${review.createdAt}`);
  lines.push(`reviewer: ${review.reviewer}`);
  lines.push(`author: ${review.author}`);
  lines.push(`verdict: ${review.verdict}`);
  lines.push("---");
  lines.push("");

  // Readable markdown body
  lines.push(`# Review: ${review.taskId}`);
  lines.push("");
  lines.push(`**Reviewer:** ${review.reviewer}`);
  lines.push(`**Author:** ${review.author}`);
  lines.push(`**Verdict:** ${review.verdict}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(review.summary);
  lines.push("");

  if (review.findings.length > 0) {
    lines.push("## Findings");
    lines.push("");
    for (const finding of review.findings) {
      lines.push(
        `- **[${finding.severity}]** ${finding.section}: ${finding.description}`,
      );
    }
    lines.push("");
  }

  if (review.revisionRequests.length > 0) {
    lines.push("## Revision Requests");
    lines.push("");
    for (const req of review.revisionRequests) {
      lines.push(`- **[${req.priority}]** ${req.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function deserializeReview(markdown: string): Review {
  const { frontmatter: fm, body } = parseFrontmatter(markdown);

  const id = requireField(fm, "id");
  const taskId = requireField(fm, "task_id");
  const createdAt = requireField(fm, "created_at");
  const reviewerStr = requireField(fm, "reviewer");
  if (
    reviewerStr !== "director" &&
    !(SKILL_NAMES as readonly string[]).includes(reviewerStr)
  ) {
    throw new WorkspaceError(
      `Invalid reviewer: "${reviewerStr}"`,
      "PARSE_ERROR",
    );
  }
  const reviewer = reviewerStr as SkillName | "director";
  const author = requireEnum(fm, "author", SKILL_NAMES);
  const verdict = requireEnum(fm, "verdict", REVIEW_VERDICTS);

  const summary = extractSection(body, "Summary");
  const findings = extractFindings(body);
  const revisionRequests = extractRevisionRequests(body);

  return {
    id,
    taskId,
    createdAt,
    reviewer,
    author,
    verdict,
    findings,
    revisionRequests,
    summary,
  };
}

// ── Learning Entry Serialization ─────────────────────────────────────────────

export function serializeLearningEntry(entry: LearningEntry): string {
  const lines: string[] = [];
  lines.push(`### ${entry.timestamp}`);
  lines.push("");
  lines.push(`- **Agent:** ${entry.agent}`);
  if (entry.goalId) lines.push(`- **Goal:** ${entry.goalId}`);
  lines.push(`- **Outcome:** ${entry.outcome}`);
  lines.push(`- **Learning:** ${entry.learning}`);
  lines.push(`- **Action:** ${entry.actionTaken}`);
  lines.push("");
  return lines.join("\n");
}

// ── Goal Serialization ──────────────────────────────────────────────────────

export function serializeGoal(goal: Goal): string {
  const lines = [
    "---",
    `id: ${goal.id}`,
    `category: ${goal.category}`,
    `priority: ${goal.priority}`,
    `created_at: ${goal.createdAt}`,
    `deadline: ${goal.deadline ?? "none"}`,
    `metadata: ${JSON.stringify(goal.metadata)}`,
    "---",
    "",
    `# Goal: ${goal.id}`,
    "",
    "## Description",
    "",
    goal.description,
    "",
  ];
  return lines.join("\n");
}

export function deserializeGoal(markdown: string): Goal {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new WorkspaceError("Invalid goal file: no frontmatter", "PARSE_ERROR");

  const fm: Record<string, string> = {};
  for (const line of fmMatch[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  const bodyMatch = markdown.match(/## Description\n\n([\s\S]*?)$/);
  const description = bodyMatch ? bodyMatch[1]!.trim() : "";

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(fm.metadata ?? "{}");
  } catch {
    // ignore parse errors
  }

  if (!fm.id) throw new WorkspaceError("Invalid goal file: missing id", "PARSE_ERROR");
  if (!fm.created_at) throw new WorkspaceError("Invalid goal file: missing created_at", "PARSE_ERROR");

  const category = fm.category;
  if (
    !category ||
    !(GOAL_CATEGORIES as readonly string[]).includes(category)
  ) {
    throw new WorkspaceError(`Invalid goal file: invalid category "${category}"`, "PARSE_ERROR");
  }

  const priority = fm.priority;
  if (!priority || !(PRIORITIES as readonly string[]).includes(priority)) {
    throw new WorkspaceError(`Invalid goal file: invalid priority "${priority}"`, "PARSE_ERROR");
  }

  return {
    id: fm.id,
    description,
    category: category as Goal["category"],
    priority: priority as Goal["priority"],
    createdAt: fm.created_at,
    deadline: fm.deadline === "none" || !fm.deadline ? null : fm.deadline,
    metadata,
  };
}

export function serializeGoalPlan(plan: GoalPlan): string {
  const lines = [
    "---",
    `goal_id: ${plan.goalId}`,
    `estimated_task_count: ${plan.estimatedTaskCount}`,
    `pipeline_template: ${plan.pipelineTemplateName ?? "none"}`,
    "---",
    "",
    `# Goal Plan: ${plan.goalId}`,
    "",
  ];

  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i]!;
    lines.push(`## Phase ${i + 1}: ${phase.name}`);
    lines.push("");
    lines.push(phase.description);
    lines.push("");
    lines.push(`- **Parallel:** ${phase.parallel}`);
    lines.push(
      `- **Depends on:** ${phase.dependsOnPhase !== null ? `Phase ${phase.dependsOnPhase + 1}` : "none"}`,
    );
    lines.push(`- **Skills:** ${phase.skills.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function deserializeGoalPlan(markdown: string): GoalPlan {
  const { frontmatter: fm } = parseFrontmatter(markdown);

  const goalId = fm.goal_id;
  if (!goalId) throw new WorkspaceError("Invalid goal plan: missing goal_id", "PARSE_ERROR");

  const estimatedTaskCount = parseInt(fm.estimated_task_count ?? "0", 10);
  const pipelineTemplateName =
    fm.pipeline_template === "none" || !fm.pipeline_template
      ? null
      : fm.pipeline_template;

  // Parse phases from ## Phase N: Name sections
  const phases: GoalPhase[] = [];
  const phasePattern = /## Phase \d+: (.+)\n\n([\s\S]*?)(?=\n## Phase |\n*$)/g;
  let match;
  while ((match = phasePattern.exec(markdown)) !== null) {
    const name = match[1]!.trim();
    const block = match[2]!;

    const descLines: string[] = [];
    const lines = block.split("\n");
    let parallel = false;
    let dependsOnPhase: number | null = null;
    let skills: SkillName[] = [];

    for (const line of lines) {
      if (line.startsWith("- **Parallel:**")) {
        parallel = line.includes("true");
      } else if (line.startsWith("- **Depends on:**")) {
        const depMatch = line.match(/Phase (\d+)/);
        dependsOnPhase = depMatch ? parseInt(depMatch[1]!, 10) - 1 : null;
      } else if (line.startsWith("- **Skills:**")) {
        const skillStr = line.replace("- **Skills:**", "").trim();
        skills = skillStr.split(",").map((s) => s.trim()) as SkillName[];
      } else if (!line.startsWith("- **")) {
        descLines.push(line);
      }
    }

    phases.push({
      name,
      description: descLines.join("\n").trim(),
      skills,
      parallel,
      dependsOnPhase,
    });
  }

  return { goalId, phases, estimatedTaskCount, pipelineTemplateName };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function parseMetadata(
  raw: string | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function requireField(
  fm: Record<string, string>,
  field: string,
): string {
  const value = fm[field];
  if (value === undefined || value === "") {
    throw new WorkspaceError(
      `Missing required frontmatter field: ${field}`,
      "PARSE_ERROR",
    );
  }
  return value;
}

function requireEnum<T extends string>(
  fm: Record<string, string>,
  field: string,
  values: readonly T[],
): T {
  const value = requireField(fm, field);
  if (!values.includes(value as T)) {
    throw new WorkspaceError(
      `Invalid value for ${field}: "${value}". Expected one of: ${values.join(", ")}`,
      "PARSE_ERROR",
    );
  }
  return value as T;
}

function parseNext(
  nextType: string,
  fm: Record<string, string>,
): TaskNext {
  switch (nextType) {
    case "agent": {
      const skill = fm["next_skill"];
      if (!skill) {
        throw new WorkspaceError(
          "Missing next_skill for agent next type",
          "PARSE_ERROR",
        );
      }
      if (!(SKILL_NAMES as readonly string[]).includes(skill)) {
        throw new WorkspaceError(
          `Invalid next_skill: "${skill}"`,
          "PARSE_ERROR",
        );
      }
      return { type: "agent", skill: skill as SkillName };
    }
    case "director_review":
      return { type: "director_review" };
    case "pipeline_continue": {
      const pipelineId = fm["next_pipeline"];
      if (!pipelineId) {
        throw new WorkspaceError(
          "Missing next_pipeline for pipeline_continue next type",
          "PARSE_ERROR",
        );
      }
      return { type: "pipeline_continue", pipelineId };
    }
    case "complete":
      return { type: "complete" };
    default:
      throw new WorkspaceError(
        `Invalid next type: "${nextType}"`,
        "PARSE_ERROR",
      );
  }
}

/**
 * Extract content between a ## heading and the next ## heading (or end of body).
 */
function extractSection(body: string, heading: string): string {
  const pattern = new RegExp(
    `## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const match = body.match(pattern);
  return match ? match[1]!.trim() : "";
}

/**
 * Extract the "Goal" value from a Context section.
 * Looks for "- **Goal:** value" pattern.
 */
function extractBodySection(
  body: string,
  section: string,
  field: string,
): string {
  const sectionContent = extractSection(body, section);
  const fieldPattern = new RegExp(
    `\\*\\*${field.charAt(0).toUpperCase() + field.slice(1)}:\\*\\*\\s*(.+)`,
    "i",
  );
  const match = sectionContent.match(fieldPattern);
  return match ? match[1]!.trim() : "";
}

/**
 * Extract input files from body. Looks for lines matching:
 *   - `path` — description
 */
function extractInputFiles(body: string): TaskInput[] {
  const contextSection = extractSection(body, "Context");
  const inputs: TaskInput[] = [];
  const inputPattern = /^\s+-\s+`([^`]+)`\s*[—-]\s*(.+)$/gm;
  let match;
  while ((match = inputPattern.exec(contextSection)) !== null) {
    inputs.push({
      path: match[1]!,
      description: match[2]!.trim(),
    });
  }
  return inputs;
}

const VALID_SEVERITIES: readonly FindingSeverity[] = [
  "critical",
  "major",
  "minor",
  "suggestion",
];

/**
 * Extract findings from review body.
 * Pattern: - **[severity]** section: description
 */
function extractFindings(body: string): ReviewFinding[] {
  const section = extractSection(body, "Findings");
  if (!section) return [];

  const findings: ReviewFinding[] = [];
  const pattern = /^-\s+\*\*\[(\w+)\]\*\*\s+([^:]+):\s*(.+)$/gm;
  let match;
  while ((match = pattern.exec(section)) !== null) {
    const severity = match[1]!.toLowerCase();
    if (VALID_SEVERITIES.includes(severity as FindingSeverity)) {
      findings.push({
        severity: severity as FindingSeverity,
        section: match[2]!.trim(),
        description: match[3]!.trim(),
      });
    }
  }
  return findings;
}

const VALID_REVISION_PRIORITIES: readonly RevisionPriority[] = [
  "required",
  "recommended",
  "optional",
];

/**
 * Extract revision requests from review body.
 * Pattern: - **[priority]** description
 */
function extractRevisionRequests(body: string): RevisionRequest[] {
  const section = extractSection(body, "Revision Requests");
  if (!section) return [];

  const requests: RevisionRequest[] = [];
  const pattern = /^-\s+\*\*\[(\w+)\]\*\*\s+(.+)$/gm;
  let match;
  while ((match = pattern.exec(section)) !== null) {
    const priority = match[1]!.toLowerCase();
    if (VALID_REVISION_PRIORITIES.includes(priority as RevisionPriority)) {
      requests.push({
        priority: priority as RevisionPriority,
        description: match[2]!.trim(),
      });
    }
  }
  return requests;
}
