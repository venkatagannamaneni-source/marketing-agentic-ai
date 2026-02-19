import type { Priority } from "../types/task.ts";

// ── Priority Mapping ────────────────────────────────────────────────────────
// BullMQ uses numeric priority where lower number = higher priority.

export const PRIORITY_MAP: Record<Priority, number> = {
  P0: 1,
  P1: 5,
  P2: 10,
  P3: 20,
} as const;

export function taskPriorityToQueuePriority(priority: Priority): number {
  return PRIORITY_MAP[priority];
}

export function queuePriorityToTaskPriority(numericPriority: number): Priority {
  if (numericPriority <= 1) return "P0";
  if (numericPriority <= 5) return "P1";
  if (numericPriority <= 10) return "P2";
  return "P3";
}
