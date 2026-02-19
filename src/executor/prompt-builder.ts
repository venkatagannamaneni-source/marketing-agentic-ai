import type { Task } from "../types/task.ts";
import type { SkillContent } from "./types.ts";

// ── Input Types ─────────────────────────────────────────────────────────────

export interface UpstreamOutput {
  readonly path: string;
  readonly description: string;
  readonly content: string;
}

export interface BuildPromptParams {
  readonly skillContent: SkillContent;
  readonly task: Task;
  readonly productContext: string | null;
  readonly upstreamOutputs: readonly UpstreamOutput[];
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

export function buildPrompt(params: BuildPromptParams): {
  systemPrompt: string;
  userMessage: string;
} {
  const systemPrompt = buildSystemPrompt(params.skillContent);
  const userMessage = buildUserMessage(
    params.task,
    params.productContext,
    params.upstreamOutputs,
  );

  return { systemPrompt, userMessage };
}

// ── System Prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(skillContent: SkillContent): string {
  const parts: string[] = [];

  if (skillContent.body) {
    parts.push(skillContent.body);
  }

  for (const ref of skillContent.referenceContents) {
    parts.push(`---\n\n## Reference: ${ref.path}\n\n${ref.content}`);
  }

  return parts.join("\n\n");
}

// ── User Message ────────────────────────────────────────────────────────────

function buildUserMessage(
  task: Task,
  productContext: string | null,
  upstreamOutputs: readonly UpstreamOutput[],
): string {
  const sections: string[] = [];

  // Product context
  sections.push("## Product Context\n");
  if (productContext) {
    sections.push(productContext);
  } else {
    sections.push(
      "No product marketing context available. Work with the information provided in the task.",
    );
  }

  // Task assignment
  sections.push(
    [
      "## Task Assignment\n",
      `- **Task ID:** ${task.id}`,
      `- **From:** ${task.from}`,
      `- **Priority:** ${task.priority}`,
      `- **Goal:** ${task.goal}`,
    ].join("\n"),
  );

  // Upstream inputs
  sections.push("## Upstream Inputs\n");
  if (upstreamOutputs.length > 0) {
    for (const output of upstreamOutputs) {
      sections.push(
        `### Input: ${output.description}\nSource: ${output.path}\n\n${output.content}`,
      );
    }
  } else {
    sections.push("No upstream inputs for this task.");
  }

  // Requirements
  sections.push(`## Requirements\n\n${task.requirements}`);

  // Revision context (if this is a revision)
  if (task.revisionCount > 0) {
    sections.push(
      [
        "## Revision Context\n",
        `This is revision #${task.revisionCount}. Previous output was reviewed and changes were requested.`,
        "See the review feedback in the upstream inputs above.",
      ].join("\n"),
    );
  }

  // Output instructions
  sections.push(
    [
      "## Output Instructions\n",
      "- Write your complete output below",
      `- Format: ${task.output.format}`,
      "- Be thorough and follow the skill guidelines above",
    ].join("\n"),
  );

  return sections.join("\n\n");
}
