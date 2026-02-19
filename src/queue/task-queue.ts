import type { Task } from "../types/task.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { MarketingDirector } from "../director/director.ts";
import type { AgentExecutor } from "../executor/agent-executor.ts";
import type { BudgetState } from "../director/types.ts";
import type {
  TaskQueueConfig,
  QueueJobData,
  QueueJobResult,
  QueueHealth,
  DeadLetterEntry,
  QueueAdapter,
  WorkerAdapter,
} from "./types.ts";
import { DEFAULT_TASK_QUEUE_CONFIG } from "./types.ts";
import type { RedisConnectionManager } from "./redis-connection.ts";
import { taskPriorityToQueuePriority } from "./priority-map.ts";
import { BudgetGate } from "./budget-gate.ts";
import { FailureTracker } from "./failure-tracker.ts";
import { FallbackQueue } from "./fallback-queue.ts";
import { CompletionRouter } from "./completion-router.ts";

// ── Task Queue Manager ──────────────────────────────────────────────────────
// Self-contained orchestration loop: enqueue → worker processes → route → re-enqueue.

export interface TaskQueueManagerDeps {
  readonly config?: Partial<TaskQueueConfig>;
  readonly workspace: WorkspaceManager;
  readonly director: MarketingDirector;
  readonly executor: AgentExecutor;
  readonly budgetProvider: () => BudgetState;
  readonly queue: QueueAdapter;
  readonly worker: WorkerAdapter;
  readonly redis: RedisConnectionManager;
}

export type EnqueueResult = "enqueued" | "deferred" | "fallback";

export class TaskQueueManager {
  private readonly config: TaskQueueConfig;
  private readonly workspace: WorkspaceManager;
  private readonly budgetProvider: () => BudgetState;
  private readonly queue: QueueAdapter;
  private readonly worker: WorkerAdapter;
  private readonly redis: RedisConnectionManager;
  private readonly budgetGate: BudgetGate;
  private readonly failureTracker: FailureTracker;
  private readonly fallbackQueue: FallbackQueue;
  private readonly completionRouter: CompletionRouter;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(deps: TaskQueueManagerDeps) {
    this.config = { ...DEFAULT_TASK_QUEUE_CONFIG, ...deps.config };
    this.workspace = deps.workspace;
    this.budgetProvider = deps.budgetProvider;
    this.queue = deps.queue;
    this.worker = deps.worker;
    this.redis = deps.redis;
    this.budgetGate = new BudgetGate();
    this.failureTracker = new FailureTracker();
    this.fallbackQueue = new FallbackQueue(this.config.fallbackDir);
    this.completionRouter = new CompletionRouter(deps.workspace, deps.director);

    this.wireWorkerEvents();
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a single task.
   * Checks budget, falls back to file queue if Redis is down.
   */
  async enqueue(task: Task): Promise<EnqueueResult> {
    const budget = this.budgetProvider();
    const decision = this.budgetGate.check(task, budget);

    if (decision !== "allow") {
      await this.workspace.updateTaskStatus(task.id, "deferred");
      return "deferred";
    }

    const jobData: QueueJobData = {
      taskId: task.id,
      skill: task.to,
      priority: task.priority,
      goalId: task.goalId,
      pipelineId: task.pipelineId,
      enqueuedAt: new Date().toISOString(),
    };

    try {
      await this.queue.add("process-task", jobData, {
        priority: taskPriorityToQueuePriority(task.priority),
        attempts: this.config.retry.maxAttempts,
        backoff: {
          type: this.config.retry.backoffType,
          delay: this.config.retry.initialDelayMs,
        },
        jobId: task.id,
        removeOnComplete: { count: 100 },
        removeOnFail: false,
      });
      return "enqueued";
    } catch {
      // Redis likely down — fall back to file queue
      await this.fallbackQueue.enqueue(jobData);
      return "fallback";
    }
  }

  /**
   * Enqueue multiple tasks.
   */
  async enqueueBatch(tasks: readonly Task[]): Promise<void> {
    for (const task of tasks) {
      await this.enqueue(task);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start the queue manager: begin health checks and enable processing.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Start periodic health check
    this.healthCheckTimer = setInterval(
      () => this.runHealthCheck(),
      this.config.healthCheckIntervalMs,
    );

    // Drain any fallback queue items from a previous Redis outage
    await this.drainFallbackQueue();
  }

  /**
   * Graceful shutdown: stop health checks, close worker and queue.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    await this.worker.close();
    await this.queue.close();
  }

  /**
   * Pause processing. Worker stops picking up new jobs.
   */
  async pause(): Promise<void> {
    await this.worker.pause();
    await this.queue.pause();
  }

  /**
   * Resume processing after a pause.
   */
  async resume(): Promise<void> {
    await this.queue.resume();
    await this.worker.resume();
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /**
   * Get a snapshot of queue health.
   */
  async getHealth(): Promise<QueueHealth> {
    const now = new Date().toISOString();

    const redisHealth = await this.redis.checkHealth();

    let jobCounts: Record<string, number> = {};
    try {
      jobCounts = await this.queue.getJobCounts();
    } catch {
      // Queue unreachable
    }

    let failedJobs: unknown[] = [];
    try {
      failedJobs = await this.queue.getFailed(0, -1);
    } catch {
      // Queue unreachable
    }

    const queueDepth =
      (jobCounts.waiting ?? 0) +
      (jobCounts.delayed ?? 0) +
      (jobCounts.prioritized ?? 0);
    const activeJobs = jobCounts.active ?? 0;

    return {
      redis: redisHealth,
      queue: {
        name: "task-queue",
        status: redisHealth.status === "healthy" ? "healthy" : "degraded",
        lastCheckedAt: now,
        details: { jobCounts },
      },
      worker: {
        name: "worker",
        status: this.worker.isRunning() ? "healthy" : "offline",
        lastCheckedAt: now,
        details: { running: this.worker.isRunning() },
      },
      queueDepth,
      activeJobs,
      deadLetterCount: failedJobs.length,
    };
  }

  // ── Dead Letter Queue ───────────────────────────────────────────────────

  /**
   * Get all permanently failed jobs.
   */
  async getDeadLetterEntries(): Promise<readonly DeadLetterEntry[]> {
    const failedJobs = await this.queue.getFailed(0, -1);

    return failedJobs.map((job) => ({
      taskId: job.data.taskId,
      skill: job.data.skill,
      failedAt: new Date().toISOString(),
      attempts: job.attemptsMade,
      lastError: job.failedReason,
      originalPriority: job.data.priority,
    }));
  }

  /**
   * Retry a dead-lettered job.
   */
  async retryDeadLetter(taskId: string): Promise<void> {
    const failedJobs = await this.queue.getFailed(0, -1);
    const job = failedJobs.find((j) => j.data.taskId === taskId);

    if (!job) {
      throw new Error(`No dead-letter job found for task ${taskId}`);
    }

    await job.retry();
  }

  // ── Internal: Worker Event Wiring ───────────────────────────────────────

  private wireWorkerEvents(): void {
    // On job completion: inspect routing action and re-enqueue if needed
    this.worker.on("completed", async (_job: unknown, result: unknown) => {
      const jobResult = result as QueueJobResult | undefined;
      if (!jobResult?.routingAction) return;

      const action = jobResult.routingAction;

      if (action.type === "enqueue_tasks" && action.tasks.length > 0) {
        await this.enqueueBatch(action.tasks);
      }
    });

    // On job failure (after all retries exhausted)
    this.worker.on("failed", async (job: unknown, error: unknown) => {
      const typedJob = job as { data: QueueJobData } | undefined;
      if (!typedJob?.data) return;

      const { taskId, pipelineId } = typedJob.data;

      // Update task status in workspace
      try {
        await this.workspace.updateTaskStatus(taskId, "failed");
      } catch {
        // Best-effort
      }

      // Track the failure
      this.failureTracker.recordFailure(taskId, pipelineId);

      // Check for cascading failure — pause if threshold reached
      if (this.failureTracker.shouldPause(pipelineId)) {
        await this.worker.pause();
      }

      // Record learning
      try {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await this.workspace.appendLearning({
          timestamp: new Date().toISOString(),
          agent: typedJob.data.skill as import("../types/agent.ts").SkillName,
          goalId: typedJob.data.goalId,
          outcome: "failure",
          learning: `Task ${taskId} permanently failed after all retries: ${errorMsg}`,
          actionTaken: this.failureTracker.shouldPause(pipelineId)
            ? "Pipeline paused due to cascading failures"
            : "Task moved to dead letter queue",
        });
      } catch {
        // Best-effort
      }
    });
  }

  // ── Internal: Health Check ──────────────────────────────────────────────

  private async runHealthCheck(): Promise<void> {
    // Check if Redis is back and drain fallback queue
    if (this.redis.isConnected()) {
      await this.drainFallbackQueue();
    }
  }

  private async drainFallbackQueue(): Promise<void> {
    if (await this.fallbackQueue.isEmpty()) return;

    const jobs = await this.fallbackQueue.drain();
    for (const jobData of jobs) {
      try {
        await this.queue.add("process-task", jobData, {
          priority: taskPriorityToQueuePriority(jobData.priority),
          attempts: this.config.retry.maxAttempts,
          backoff: {
            type: this.config.retry.backoffType,
            delay: this.config.retry.initialDelayMs,
          },
          jobId: jobData.taskId,
          removeOnComplete: { count: 100 },
          removeOnFail: false,
        });
      } catch {
        // Redis went down again during drain — re-enqueue to fallback
        await this.fallbackQueue.enqueue(jobData);
        break;
      }
    }
  }
}
