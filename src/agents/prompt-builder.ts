import { readFile } from "node:fs/promises";
import type { AgentMeta } from "../types/agent.ts";
import type { Task } from "../types/task.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { WorkspaceError } from "../workspace/errors.ts";
import { parseLearnings } from "../workspace/markdown.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BuiltPrompt {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly estimatedTokens: number;
  readonly missingInputs: readonly string[];
  readonly warnings: readonly string[];
  readonly learningsIncluded: number;
}

// ── Default ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CONTEXT_TOKENS = 150_000;

// ── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Build the system prompt and user message for a Claude API call.
 *
 * - System prompt = full SKILL.md content
 * - User message = product context + requirements + inputs + references
 */
export async function buildAgentPrompt(
  task: Task,
  agentMeta: AgentMeta,
  workspace: WorkspaceManager,
  _projectRoot: string,
  maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS,
): Promise<BuiltPrompt> {
  const missingInputs: string[] = [];
  const warnings: string[] = [];

  // ── System prompt: full SKILL.md content ─────────────────────────────

  const systemPrompt = await readFile(agentMeta.skillFilePath, "utf-8");

  // ── User message assembly ────────────────────────────────────────────

  const parts: string[] = [];

  // 1. Product marketing context
  try {
    if (await workspace.contextExists()) {
      const context = await workspace.readContext();
      parts.push(`<product-context>\n${context}\n</product-context>`);
    }
  } catch (err: unknown) {
    if (err instanceof WorkspaceError && err.code === "NOT_FOUND") {
      missingInputs.push("context/product-marketing-context.md");
    } else {
      throw err;
    }
  }

  // 2. Past learnings for this skill
  let learningsIncluded = 0;
  try {
    const rawLearnings = await workspace.readLearnings();
    if (rawLearnings) {
      const allLearnings = parseLearnings(rawLearnings);
      const relevant = allLearnings
        .filter(l => l.agent === task.to)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 10);

      if (relevant.length > 0) {
        const learningLines = relevant.map(l =>
          `- [${l.outcome}] ${l.learning} → ${l.actionTaken}`
        );

        // Token budget: max 5% of context window for learnings
        const learningsBudget = Math.floor(maxContextTokens * 0.05);
        let learningsText = learningLines.join("\n");
        while (estimateTokens("", learningsText) > learningsBudget && learningLines.length > 0) {
          learningLines.pop();
          learningsText = learningLines.join("\n");
        }

        if (learningLines.length > 0) {
          learningsIncluded = learningLines.length;
          parts.push(`<past-learnings>\n${learningsText}\n</past-learnings>`);
        }
      }
    }
  } catch (err: unknown) {
    // Learnings are supplementary — skip on expected errors, surface unexpected ones
    if (err instanceof WorkspaceError) {
      warnings.push(`Failed to load learnings: ${err.message}`);
    } else if (err instanceof Error) {
      warnings.push(`Failed to load learnings: ${err.message}`);
    }
    // Don't re-throw — learnings should never block prompt building
  }

  // 3. Task requirements — use original requirements for revision tasks
  const displayRequirements = task.revisionCount > 0 && task.metadata.originalRequirements
    ? String(task.metadata.originalRequirements)
    : task.requirements;
  parts.push(
    `<task-requirements>\n${displayRequirements}\n</task-requirements>`,
  );

  // 4. Revision feedback (structured, prominent — placed before previous output)
  if (task.revisionCount > 0) {
    const feedbackSection = buildRevisionFeedbackSection(task);
    if (feedbackSection) {
      parts.push(feedbackSection);
    }
  }

  // 5. Previous output (revision detection via revisionCount — EC-6)
  if (task.revisionCount > 0) {
    try {
      const previousOutput = await workspace.readFile(task.output.path);
      parts.push(
        `<previous-output>\n${previousOutput}\n</previous-output>`,
      );
    } catch (err: unknown) {
      if (err instanceof WorkspaceError && err.code === "NOT_FOUND") {
        // No previous output file — this is OK for first-time tasks
      } else {
        throw err;
      }
    }
  }

  // 6. Input files
  for (const input of task.inputs) {
    try {
      const content = await workspace.readFile(input.path);
      parts.push(
        `<input-file path="${input.path}">\n${content}\n</input-file>`,
      );
    } catch (err: unknown) {
      if (err instanceof WorkspaceError && err.code === "NOT_FOUND") {
        missingInputs.push(input.path);
      } else {
        throw err;
      }
    }
  }

  // 7. Reference materials — loaded last so they can be dropped if over budget
  const referenceParts: string[] = [];
  for (const refPath of agentMeta.referenceFiles) {
    try {
      const content = await readFile(refPath, "utf-8");
      referenceParts.push(
        `<reference path="${refPath}">\n${content}\n</reference>`,
      );
    } catch {
      // Skip unreadable reference files — they're supplementary
    }
  }

  // ── Context window guard (EC-3) ──────────────────────────────────────

  // Start with all reference parts included
  let userMessage = [...parts, ...referenceParts].join("\n\n");
  let estimatedTokens = estimateTokens(systemPrompt, userMessage);

  // Drop reference files from the end if over budget
  let droppedRefs = 0;
  while (
    estimatedTokens > maxContextTokens &&
    referenceParts.length > 0
  ) {
    const dropped = referenceParts.pop()!;
    const pathMatch = dropped.match(/path="([^"]+)"/);
    const droppedPath = pathMatch ? pathMatch[1] : "unknown";
    warnings.push(
      `Dropped reference file ${droppedPath} to fit within context window limit`,
    );
    droppedRefs++;
    userMessage = [...parts, ...referenceParts].join("\n\n");
    estimatedTokens = estimateTokens(systemPrompt, userMessage);
  }

  if (droppedRefs > 0) {
    warnings.push(
      `Dropped ${droppedRefs} reference file(s) total. Estimated tokens: ${estimatedTokens}`,
    );
  }

  // Warn if core content (after dropping all references) still exceeds budget
  if (estimatedTokens > maxContextTokens) {
    warnings.push(
      `Core prompt exceeds context window limit: ${estimatedTokens} estimated tokens > ${maxContextTokens} max. ` +
        `The API call may fail or truncate input.`,
    );
  }

  return {
    systemPrompt,
    userMessage,
    estimatedTokens,
    missingInputs,
    warnings,
    learningsIncluded,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a structured <revision-feedback> section from task metadata.
 *
 * Renders revision instructions prominently so the agent clearly
 * understands what to fix, why, and what the reviewer found.
 *
 * Falls back to extracting feedback from the requirements field
 * when structured metadata is not available (backward compatibility).
 */
function buildRevisionFeedbackSection(task: Task): string | null {
  const meta = task.metadata;
  const parts: string[] = [];

  parts.push(`This is revision #${task.revisionCount}. Your previous output was reviewed and requires changes.`);
  parts.push("");

  // Review summary from the director
  if (meta.reviewSummary && typeof meta.reviewSummary === "string") {
    parts.push(`**Review summary:** ${meta.reviewSummary}`);
    parts.push("");
  }

  // Structured revision feedback (from semantic review)
  const feedback = meta.revisionFeedback;
  if (Array.isArray(feedback) && feedback.length > 0) {
    parts.push("**Required changes:**");
    for (const item of feedback) {
      if (typeof item === "object" && item !== null) {
        const fb = item as Record<string, unknown>;
        const priority = typeof fb.priority === "string" ? fb.priority : "required";
        const desc = typeof fb.description === "string" ? fb.description : "";
        if (desc) {
          parts.push(`- [${priority}] ${desc}`);
        }
      }
    }
    parts.push("");
  }

  // Review findings (specific issues identified)
  const findings = meta.reviewFindings;
  if (Array.isArray(findings) && findings.length > 0) {
    parts.push("**Issues found in previous output:**");
    for (const item of findings) {
      if (typeof item === "object" && item !== null) {
        const f = item as Record<string, unknown>;
        const severity = typeof f.severity === "string" ? f.severity : "minor";
        const section = typeof f.section === "string" ? f.section : "general";
        const desc = typeof f.description === "string" ? f.description : "";
        if (desc) {
          parts.push(`- [${severity}] ${section}: ${desc}`);
        }
      }
    }
    parts.push("");
  }

  // If no structured metadata is available, fall back to extracting from requirements
  if (!Array.isArray(feedback) && !Array.isArray(findings)) {
    const revisionMatch = task.requirements.match(/^REVISION REQUESTED:\n([\s\S]*?)(?:\n\nOriginal requirements:|$)/m);
    if (revisionMatch) {
      parts.push("**Required changes:**");
      parts.push(revisionMatch[1]!.trim());
      parts.push("");
    }
  }

  parts.push("**Instructions:** Revise your previous output (shown in <previous-output>) to address ALL the changes above. Keep everything that was good — only fix what was flagged. Do not start from scratch unless the issues are fundamental.");

  return `<revision-feedback>\n${parts.join("\n")}\n</revision-feedback>`;
}

function estimateTokens(systemPrompt: string, userMessage: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil((systemPrompt.length + userMessage.length) / 4);
}
