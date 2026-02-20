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
        while (estimateTokens("", learningsText) > learningsBudget && learningLines.length > 1) {
          learningLines.pop();
          learningsText = learningLines.join("\n");
        }

        learningsIncluded = learningLines.length;
        parts.push(`<past-learnings>\n${learningsText}\n</past-learnings>`);
      }
    }
  } catch {
    // Learnings are supplementary — don't fail the prompt build
  }

  // 3. Task requirements
  parts.push(
    `<task-requirements>\n${task.requirements}\n</task-requirements>`,
  );

  // 4. Previous output (revision detection via revisionCount — EC-6)
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

  // 5. Input files
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

  // 6. Reference materials — loaded last so they can be dropped if over budget
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

function estimateTokens(systemPrompt: string, userMessage: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil((systemPrompt.length + userMessage.length) / 4);
}
