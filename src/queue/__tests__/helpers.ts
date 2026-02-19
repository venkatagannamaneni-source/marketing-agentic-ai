import type { Task, Priority } from "../../types/task.ts";
import type { SkillName } from "../../types/agent.ts";
import type { BudgetState, BudgetLevel } from "../../director/types.ts";
import type { ExecutionResult } from "../../executor/types.ts";
import type {
  QueueAdapter,
  QueueAddOptions,
  QueueJobData,
  QueueJobResult,
  FailedJob,
  WorkerAdapter,
} from "../types.ts";
import type { RedisClient } from "../redis-connection.ts";

// ── Mock Queue Adapter ──────────────────────────────────────────────────────

export interface StoredJob {
  readonly name: string;
  readonly data: QueueJobData;
  readonly opts: QueueAddOptions;
  readonly id: string;
  failedReason: string;
  attemptsMade: number;
}

export class MockQueueAdapter implements QueueAdapter {
  readonly jobs: StoredJob[] = [];
  readonly failedJobs: StoredJob[] = [];
  private paused = false;
  private closed = false;
  shouldThrowOnAdd = false;

  async add(
    name: string,
    data: QueueJobData,
    opts: QueueAddOptions,
  ): Promise<{ id: string }> {
    if (this.shouldThrowOnAdd) {
      throw new Error("Redis connection refused");
    }
    const id = opts.jobId;
    this.jobs.push({
      name,
      data,
      opts,
      id,
      failedReason: "",
      attemptsMade: 0,
    });
    return { id };
  }

  async getJobCounts(): Promise<Record<string, number>> {
    return {
      waiting: this.jobs.length,
      active: 0,
      completed: 0,
      failed: this.failedJobs.length,
      delayed: 0,
      prioritized: 0,
    };
  }

  async getJob(
    jobId: string,
  ): Promise<{ data: QueueJobData; attemptsMade: number } | null> {
    const job = this.jobs.find((j) => j.id === jobId);
    return job ? { data: job.data, attemptsMade: job.attemptsMade } : null;
  }

  async getFailed(
    _start?: number,
    _end?: number,
  ): Promise<FailedJob[]> {
    return this.failedJobs.map((j) => ({
      id: j.id,
      data: j.data,
      failedReason: j.failedReason,
      attemptsMade: j.attemptsMade,
      retry: async () => {
        // Move from failed back to jobs
        const idx = this.failedJobs.indexOf(j);
        if (idx >= 0) this.failedJobs.splice(idx, 1);
        this.jobs.push(j);
      },
    }));
  }

  async obliterate(): Promise<void> {
    this.jobs.length = 0;
    this.failedJobs.length = 0;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
  }

  // Test helpers
  isPaused(): boolean {
    return this.paused;
  }

  isClosed(): boolean {
    return this.closed;
  }

  addFailedJob(data: QueueJobData, reason: string, attempts: number): void {
    this.failedJobs.push({
      name: "process-task",
      data,
      opts: {} as QueueAddOptions,
      id: data.taskId,
      failedReason: reason,
      attemptsMade: attempts,
    });
  }
}

// ── Mock Worker Adapter ─────────────────────────────────────────────────────

export class MockWorkerAdapter implements WorkerAdapter {
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private running = true;
  private closed = false;

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async close(): Promise<void> {
    this.running = false;
    this.closed = true;
  }

  async pause(): Promise<void> {
    this.running = false;
  }

  async resume(): Promise<void> {
    this.running = true;
  }

  isRunning(): boolean {
    return this.running;
  }

  // Test helpers
  isClosed(): boolean {
    return this.closed;
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(...args);
    }
  }
}

// ── Mock Redis Client ───────────────────────────────────────────────────────

export class MockRedisClient implements RedisClient {
  status = "ready";
  shouldFailPing = false;
  disconnected = false;
  quit_called = false;

  async ping(): Promise<string> {
    if (this.shouldFailPing) {
      throw new Error("Redis connection lost");
    }
    return "PONG";
  }

  async quit(): Promise<string> {
    this.quit_called = true;
    return "OK";
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

// ── Test Fixtures ───────────────────────────────────────────────────────────

export function createTestTask(overrides?: Partial<Task>): Task {
  const now = new Date().toISOString();
  const skill: SkillName = (overrides?.to ?? "copywriting") as SkillName;
  const id = overrides?.id ?? `${skill}-20260219-abc123`;

  return {
    id,
    createdAt: now,
    updatedAt: now,
    from: "director",
    to: skill,
    priority: "P2" as Priority,
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: null,
    pipelineId: null,
    goal: "Test goal",
    inputs: [],
    requirements: "Test requirements",
    output: {
      path: `outputs/creative/${skill}/${id}.md`,
      format: "markdown",
    },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
    ...overrides,
  } as Task;
}

export function createTestBudgetState(
  level: BudgetLevel = "normal",
): BudgetState {
  const configs: Record<BudgetLevel, BudgetState> = {
    normal: {
      totalBudget: 1000,
      spent: 100,
      percentUsed: 10,
      level: "normal",
      allowedPriorities: ["P0", "P1", "P2", "P3"],
      modelOverride: null,
    },
    warning: {
      totalBudget: 1000,
      spent: 800,
      percentUsed: 80,
      level: "warning",
      allowedPriorities: ["P0", "P1", "P2"],
      modelOverride: null,
    },
    throttle: {
      totalBudget: 1000,
      spent: 900,
      percentUsed: 90,
      level: "throttle",
      allowedPriorities: ["P0", "P1"],
      modelOverride: null,
    },
    critical: {
      totalBudget: 1000,
      spent: 950,
      percentUsed: 95,
      level: "critical",
      allowedPriorities: ["P0"],
      modelOverride: "haiku",
    },
    exhausted: {
      totalBudget: 1000,
      spent: 1000,
      percentUsed: 100,
      level: "exhausted",
      allowedPriorities: [],
      modelOverride: "haiku",
    },
  };

  return configs[level];
}

export function createTestExecutionResult(
  overrides?: Partial<ExecutionResult>,
): ExecutionResult {
  return {
    taskId: overrides?.taskId ?? "copywriting-20260219-abc123",
    skill: (overrides?.skill ?? "copywriting") as SkillName,
    status: "completed",
    outputPath: `outputs/creative/copywriting/${overrides?.taskId ?? "copywriting-20260219-abc123"}.md`,
    tokensUsed: { input: 1000, output: 500, total: 1500 },
    durationMs: 5000,
    ...overrides,
  };
}

export function createTestJobData(
  overrides?: Partial<QueueJobData>,
): QueueJobData {
  return {
    taskId: "copywriting-20260219-abc123",
    skill: "copywriting",
    priority: "P2" as Priority,
    goalId: null,
    pipelineId: null,
    enqueuedAt: new Date().toISOString(),
    ...overrides,
  };
}
