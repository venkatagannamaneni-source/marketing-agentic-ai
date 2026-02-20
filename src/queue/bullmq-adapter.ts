import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import type {
  QueueAdapter,
  QueueAddOptions,
  QueueJobData,
  QueueJobResult,
  FailedJob,
  WorkerAdapter,
  ProcessorFn,
} from "./types.ts";

// ── Connection Options ─────────────────────────────────────────────────────

export interface BullMQConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db?: number;
  readonly maxRetriesPerRequest?: number | null;
  readonly enableReadyCheck?: boolean;
}

// ── BullMQ Queue Adapter ───────────────────────────────────────────────────
// Wraps a real BullMQ Queue behind the QueueAdapter interface for production use.

export class BullMQQueueAdapter implements QueueAdapter {
  private readonly queue: Queue;

  constructor(queueName: string, connection: BullMQConnectionOptions) {
    this.queue = new Queue(queueName, { connection });
  }

  async add(
    name: string,
    data: QueueJobData,
    opts: QueueAddOptions,
  ): Promise<{ id: string }> {
    const job = await this.queue.add(name, data, {
      priority: opts.priority,
      attempts: opts.attempts,
      backoff: opts.backoff,
      jobId: opts.jobId,
      removeOnComplete: opts.removeOnComplete,
      removeOnFail: opts.removeOnFail,
    });
    return { id: job.id ?? opts.jobId };
  }

  async getJobCounts(): Promise<Record<string, number>> {
    return await this.queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "prioritized",
    );
  }

  async getJob(
    jobId: string,
  ): Promise<{ data: QueueJobData; attemptsMade: number } | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    return {
      data: job.data as QueueJobData,
      attemptsMade: job.attemptsMade,
    };
  }

  async getFailed(start?: number, end?: number): Promise<FailedJob[]> {
    const jobs = await this.queue.getFailed(start, end);
    return jobs.map((job) => this.toFailedJob(job));
  }

  async obliterate(opts?: { force: boolean }): Promise<void> {
    await this.queue.obliterate(opts);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  async pause(): Promise<void> {
    await this.queue.pause();
  }

  async resume(): Promise<void> {
    await this.queue.resume();
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private toFailedJob(job: Job<QueueJobData, QueueJobResult>): FailedJob {
    return {
      id: job.id ?? "",
      data: job.data,
      failedReason: job.failedReason ?? "Unknown",
      attemptsMade: job.attemptsMade,
      finishedOn: job.finishedOn,
      retry: async () => {
        await job.retry();
      },
    };
  }
}

// ── BullMQ Worker Adapter ──────────────────────────────────────────────────
// Wraps a real BullMQ Worker behind the WorkerAdapter interface for production use.

export class BullMQWorkerAdapter implements WorkerAdapter {
  private readonly worker: Worker;
  private running = true;

  constructor(
    queueName: string,
    processor: ProcessorFn,
    connection: BullMQConnectionOptions,
    concurrency: number,
  ) {
    this.worker = new Worker(
      queueName,
      async (job: Job) => {
        const handle = {
          data: job.data as QueueJobData,
          id: job.id ?? "",
          attemptsMade: job.attemptsMade,
        };
        return await processor(handle);
      },
      { connection, concurrency },
    );
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    // BullMQ Worker uses typed event overloads; we forward generically.
    this.worker.on(event as "completed", handler as (...args: unknown[]) => void);
  }

  async close(): Promise<void> {
    this.running = false;
    await this.worker.close();
  }

  async pause(): Promise<void> {
    this.running = false;
    await this.worker.pause();
  }

  async resume(): Promise<void> {
    this.running = true;
    await this.worker.resume();
  }

  isRunning(): boolean {
    return this.running && !this.worker.closing;
  }
}
