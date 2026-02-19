import type { SkillName } from "../types/agent.ts";

/**
 * Generate a task ID: {skill}-{YYYYMMDD}-{6-char-hex}
 * Example: "copywriting-20260219-a1b2c3"
 */
export function generateTaskId(skill: SkillName): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${skill}-${dateStr}-${hex}`;
}

/**
 * Generate a review ID: "review-{taskId}-{n}"
 */
export function generateReviewId(taskId: string, index: number): string {
  return `review-${taskId}-${index}`;
}

/**
 * Generate a pipeline run ID: "run-{pipelineId}-{timestamp}"
 */
export function generateRunId(pipelineId: string): string {
  return `run-${pipelineId}-${Date.now()}`;
}
