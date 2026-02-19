import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { QueueJobData } from "./types.ts";
import { taskPriorityToQueuePriority } from "./priority-map.ts";

// ── Fallback Queue ──────────────────────────────────────────────────────────
// File-based FIFO queue for when Redis is unavailable.
// Jobs are stored as JSON files with filenames that encode priority and timestamp
// for natural sort ordering: {priority_numeric}-{timestamp}-{taskId}.json

export class FallbackQueue {
  private initialized = false;

  constructor(private readonly dir: string) {}

  /**
   * Enqueue a job to the fallback file store.
   */
  async enqueue(jobData: QueueJobData): Promise<void> {
    await this.ensureDir();

    const priority = taskPriorityToQueuePriority(jobData.priority);
    const paddedPriority = String(priority).padStart(3, "0");
    const timestamp = Date.now();
    const filename = `${paddedPriority}-${timestamp}-${jobData.taskId}.json`;

    await writeFile(
      resolve(this.dir, filename),
      JSON.stringify(jobData),
      "utf-8",
    );
  }

  /**
   * Drain all jobs from the fallback store, sorted by priority then timestamp.
   * Deletes the files after reading.
   */
  async drain(): Promise<QueueJobData[]> {
    await this.ensureDir();

    const files = await readdir(this.dir);
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

    const jobs: QueueJobData[] = [];

    for (const file of jsonFiles) {
      const filePath = resolve(this.dir, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const data = JSON.parse(content) as QueueJobData;

        // Validate required fields
        if (!data.taskId || !data.skill || !data.priority) {
          // Corrupt file — leave for manual inspection, skip it
          continue;
        }

        jobs.push(data);
        await unlink(filePath);
      } catch {
        // Parse or read error — leave corrupt file for manual inspection, skip it
      }
    }

    return jobs;
  }

  /**
   * Return the number of pending fallback jobs.
   */
  async peek(): Promise<number> {
    await this.ensureDir();

    const files = await readdir(this.dir);
    return files.filter((f) => f.endsWith(".json")).length;
  }

  /**
   * Check if the fallback queue is empty.
   */
  async isEmpty(): Promise<boolean> {
    return (await this.peek()) === 0;
  }

  private async ensureDir(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.dir, { recursive: true });
      this.initialized = true;
    }
  }
}
