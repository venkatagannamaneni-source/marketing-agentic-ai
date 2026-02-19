import { mkdir, readFile, writeFile, readdir, unlink, stat, appendFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { WorkspaceConfig, WorkspacePaths, LearningEntry } from "../types/workspace.ts";
import type { Task, TaskStatus, TaskFilter } from "../types/task.ts";
import type { Review } from "../types/review.ts";
import type { SkillName, SquadName } from "../types/agent.ts";
import { SKILL_NAMES, SKILL_SQUAD_MAP, SQUAD_NAMES } from "../types/agent.ts";
import { WORKSPACE_DIRS } from "../types/workspace.ts";
import { WorkspaceError } from "./errors.ts";
import { acquireLock } from "./lock.ts";
import {
  serializeTask,
  deserializeTask,
  serializeReview,
  deserializeReview,
  serializeLearningEntry,
} from "./markdown.ts";

// ── WorkspaceManager Interface ───────────────────────────────────────────────

export interface WorkspaceManager {
  init(): Promise<void>;
  isInitialized(): Promise<boolean>;
  readonly paths: WorkspacePaths;

  // Generic file I/O
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  fileExists(relativePath: string): Promise<boolean>;
  listFiles(relativeDir: string): Promise<string[]>;
  deleteFile(relativePath: string): Promise<void>;

  // Task operations
  writeTask(task: Task): Promise<void>;
  readTask(taskId: string): Promise<Task>;
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>;

  // Review operations
  writeReview(review: Review): Promise<void>;
  readReview(taskId: string, reviewIndex?: number): Promise<Review>;
  listReviews(taskId: string): Promise<Review[]>;

  // Output operations
  writeOutput(
    squad: SquadName,
    skill: SkillName,
    taskId: string,
    content: string,
  ): Promise<void>;
  readOutput(
    squad: SquadName,
    skill: SkillName,
    taskId: string,
  ): Promise<string>;

  // Context
  readContext(): Promise<string>;
  contextExists(): Promise<boolean>;

  // Memory (append-only)
  appendLearning(entry: LearningEntry): Promise<void>;
  readLearnings(): Promise<string>;

  // Metrics
  writeMetricsReport(date: string, content: string): Promise<void>;
  readMetricsReport(date: string): Promise<string>;
}

// ── Path Builder ─────────────────────────────────────────────────────────────

export function createWorkspacePaths(rootDir: string): WorkspacePaths {
  return {
    root: rootDir,
    context: `${rootDir}/context`,
    contextFile: `${rootDir}/context/product-marketing-context.md`,
    tasks: `${rootDir}/tasks`,
    taskFile: (taskId: string) => `${rootDir}/tasks/${taskId}.md`,
    outputs: `${rootDir}/outputs`,
    outputDir: (squad: SquadName, skill: SkillName) =>
      `${rootDir}/outputs/${squad}/${skill}`,
    outputFile: (squad: SquadName, skill: SkillName, taskId: string) =>
      `${rootDir}/outputs/${squad}/${skill}/${taskId}.md`,
    reviews: `${rootDir}/reviews`,
    reviewFile: (taskId: string, reviewIndex?: number) =>
      reviewIndex !== undefined && reviewIndex > 0
        ? `${rootDir}/reviews/${taskId}-review-${reviewIndex}.md`
        : `${rootDir}/reviews/${taskId}-review.md`,
    metrics: `${rootDir}/metrics`,
    metricsFile: (date: string) => `${rootDir}/metrics/${date}-report.md`,
    memory: `${rootDir}/memory`,
    memoryFile: `${rootDir}/memory/learnings.md`,
  };
}

// ── FileSystem Implementation ────────────────────────────────────────────────

export class FileSystemWorkspaceManager implements WorkspaceManager {
  readonly paths: WorkspacePaths;
  private readonly rootDir: string;

  constructor(config: WorkspaceConfig) {
    this.rootDir = resolve(config.rootDir);
    this.paths = createWorkspacePaths(this.rootDir);
  }

  async init(): Promise<void> {
    // Create top-level workspace dirs
    for (const dir of WORKSPACE_DIRS) {
      await mkdir(resolve(this.rootDir, dir), { recursive: true });
    }

    // Create outputs/{squad}/{skill}/ for every skill
    for (const squad of SQUAD_NAMES) {
      const skills = SKILL_NAMES.filter((s) => SKILL_SQUAD_MAP[s] === squad);
      for (const skill of skills) {
        await mkdir(resolve(this.rootDir, "outputs", squad, skill), {
          recursive: true,
        });
      }
    }
  }

  async isInitialized(): Promise<boolean> {
    try {
      for (const dir of WORKSPACE_DIRS) {
        await stat(resolve(this.rootDir, dir));
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── Generic File I/O ────────────────────────────────────────────────────

  async readFile(relativePath: string): Promise<string> {
    const absPath = this.resolveSafe(relativePath);
    try {
      return await readFile(absPath, "utf-8");
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        throw new WorkspaceError(
          `File not found: ${relativePath}`,
          "NOT_FOUND",
          relativePath,
        );
      }
      throw new WorkspaceError(
        `Failed to read: ${relativePath}`,
        "READ_FAILED",
        relativePath,
      );
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const absPath = this.resolveSafe(relativePath);
    const lock = await acquireLock(absPath);
    try {
      // Ensure parent directory exists
      const parentDir = absPath.slice(0, absPath.lastIndexOf("/"));
      await mkdir(parentDir, { recursive: true });
      await writeFile(absPath, content, "utf-8");
    } catch (err: unknown) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError(
        `Failed to write: ${relativePath}`,
        "WRITE_FAILED",
        relativePath,
      );
    } finally {
      await lock.release();
    }
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const absPath = this.resolveSafe(relativePath);
    try {
      await stat(absPath);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(relativeDir: string): Promise<string[]> {
    const absPath = this.resolveSafe(relativeDir);
    try {
      const entries = await readdir(absPath);
      return entries.filter((e) => e.endsWith(".md")).sort();
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async deleteFile(relativePath: string): Promise<void> {
    const absPath = this.resolveSafe(relativePath);
    try {
      await unlink(absPath);
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        throw new WorkspaceError(
          `File not found: ${relativePath}`,
          "NOT_FOUND",
          relativePath,
        );
      }
      throw err;
    }
  }

  // ── Task Operations ─────────────────────────────────────────────────────

  async writeTask(task: Task): Promise<void> {
    const content = serializeTask(task);
    await this.writeFile(`tasks/${task.id}.md`, content);
  }

  async readTask(taskId: string): Promise<Task> {
    const content = await this.readFile(`tasks/${taskId}.md`);
    return deserializeTask(content);
  }

  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    const files = await this.listFiles("tasks");
    const tasks: Task[] = [];

    for (const file of files) {
      const content = await this.readFile(`tasks/${file}`);
      try {
        const task = deserializeTask(content);
        if (matchesFilter(task, filter)) {
          tasks.push(task);
        }
      } catch {
        // Skip malformed task files
      }
    }

    return tasks;
  }

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    const task = await this.readTask(taskId);
    const updated: Task = {
      ...task,
      status,
      updatedAt: new Date().toISOString(),
    };
    await this.writeTask(updated);
  }

  // ── Review Operations ───────────────────────────────────────────────────

  async writeReview(review: Review): Promise<void> {
    const content = serializeReview(review);
    // Extract index from review ID if present, otherwise default to 0
    const match = review.id.match(/-(\d+)$/);
    const index = match ? parseInt(match[1]!, 10) : 0;
    const fileName =
      index > 0
        ? `reviews/${review.taskId}-review-${index}.md`
        : `reviews/${review.taskId}-review.md`;
    await this.writeFile(fileName, content);
  }

  async readReview(taskId: string, reviewIndex?: number): Promise<Review> {
    const fileName =
      reviewIndex !== undefined && reviewIndex > 0
        ? `reviews/${taskId}-review-${reviewIndex}.md`
        : `reviews/${taskId}-review.md`;
    const content = await this.readFile(fileName);
    return deserializeReview(content);
  }

  async listReviews(taskId: string): Promise<Review[]> {
    const files = await this.listFiles("reviews");
    const reviews: Review[] = [];

    for (const file of files) {
      if (file.startsWith(`${taskId}-review`)) {
        const content = await this.readFile(`reviews/${file}`);
        try {
          reviews.push(deserializeReview(content));
        } catch {
          // Skip malformed review files
        }
      }
    }

    return reviews;
  }

  // ── Output Operations ───────────────────────────────────────────────────

  async writeOutput(
    squad: SquadName,
    skill: SkillName,
    taskId: string,
    content: string,
  ): Promise<void> {
    await this.writeFile(`outputs/${squad}/${skill}/${taskId}.md`, content);
  }

  async readOutput(
    squad: SquadName,
    skill: SkillName,
    taskId: string,
  ): Promise<string> {
    return this.readFile(`outputs/${squad}/${skill}/${taskId}.md`);
  }

  // ── Context ─────────────────────────────────────────────────────────────

  async readContext(): Promise<string> {
    return this.readFile("context/product-marketing-context.md");
  }

  async contextExists(): Promise<boolean> {
    return this.fileExists("context/product-marketing-context.md");
  }

  // ── Memory (append-only) ────────────────────────────────────────────────

  async appendLearning(entry: LearningEntry): Promise<void> {
    const absPath = this.resolveSafe("memory/learnings.md");
    const lock = await acquireLock(absPath);
    try {
      const content = serializeLearningEntry(entry);
      const exists = await this.fileExists("memory/learnings.md");
      if (!exists) {
        await writeFile(
          absPath,
          `# Learnings\n\n${content}`,
          "utf-8",
        );
      } else {
        await appendFile(absPath, content, "utf-8");
      }
    } finally {
      await lock.release();
    }
  }

  async readLearnings(): Promise<string> {
    try {
      return await this.readFile("memory/learnings.md");
    } catch (err: unknown) {
      if (err instanceof WorkspaceError && err.code === "NOT_FOUND") {
        return "";
      }
      throw err;
    }
  }

  // ── Metrics ─────────────────────────────────────────────────────────────

  async writeMetricsReport(date: string, content: string): Promise<void> {
    await this.writeFile(`metrics/${date}-report.md`, content);
  }

  async readMetricsReport(date: string): Promise<string> {
    return this.readFile(`metrics/${date}-report.md`);
  }

  // ── Path Safety ─────────────────────────────────────────────────────────

  private resolveSafe(relativePath: string): string {
    const absPath = resolve(this.rootDir, relativePath);
    const rel = relative(this.rootDir, absPath);

    // Prevent path traversal: resolved path must be within rootDir
    if (rel.startsWith("..") || resolve(absPath) !== absPath.replace(/\/+$/, "")) {
      throw new WorkspaceError(
        `Path traversal detected: ${relativePath}`,
        "INVALID_PATH",
        relativePath,
      );
    }

    return absPath;
  }
}

// ── Filter Matching ──────────────────────────────────────────────────────────

function matchesFilter(task: Task, filter?: TaskFilter): boolean {
  if (!filter) return true;

  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status)
      ? filter.status
      : [filter.status];
    if (!statuses.includes(task.status)) return false;
  }

  if (filter.priority !== undefined) {
    const priorities = Array.isArray(filter.priority)
      ? filter.priority
      : [filter.priority];
    if (!priorities.includes(task.priority)) return false;
  }

  if (filter.skill !== undefined && task.to !== filter.skill) {
    return false;
  }

  if (filter.pipelineId !== undefined && task.pipelineId !== filter.pipelineId) {
    return false;
  }

  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
