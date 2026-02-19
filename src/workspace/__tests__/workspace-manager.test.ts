import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../types/task.ts";
import type { Review } from "../../types/review.ts";
import { FileSystemWorkspaceManager } from "../workspace-manager.ts";
import { WorkspaceError } from "../errors.ts";

// ── Test Helpers ─────────────────────────────────────────────────────────────

let tempDir: string;
let ws: FileSystemWorkspaceManager;

function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "copywriting-20260219-a1b2c3",
    createdAt: "2026-02-19T10:00:00.000Z",
    updatedAt: "2026-02-19T10:00:00.000Z",
    from: "director",
    to: "copywriting",
    priority: "P1",
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: null,
    pipelineId: null,
    goal: "Rewrite signup page",
    inputs: [
      {
        path: "context/product-marketing-context.md",
        description: "Product context",
      },
    ],
    requirements: "Write compelling copy",
    output: {
      path: "outputs/creative/copywriting/copywriting-20260219-a1b2c3.md",
      format: "Marketing copy",
    },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
    ...overrides,
  };
}

function createTestReview(): Review {
  return {
    id: "review-copywriting-20260219-a1b2c3-0",
    taskId: "copywriting-20260219-a1b2c3",
    createdAt: "2026-02-19T12:00:00.000Z",
    reviewer: "director",
    author: "copywriting",
    verdict: "APPROVE",
    summary: "Good work, approved.",
    findings: [],
    revisionRequests: [],
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ws-test-"));
  ws = new FileSystemWorkspaceManager({ rootDir: tempDir });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Initialization ───────────────────────────────────────────────────────────

describe("init", () => {
  it("creates all workspace directories", async () => {
    await ws.init();

    for (const dir of ["context", "tasks", "outputs", "reviews", "metrics", "memory"]) {
      const s = await stat(join(tempDir, dir));
      expect(s.isDirectory()).toBe(true);
    }
  });

  it("creates nested output directories for each squad/skill", async () => {
    await ws.init();

    const s = await stat(join(tempDir, "outputs", "creative", "copywriting"));
    expect(s.isDirectory()).toBe(true);

    const s2 = await stat(join(tempDir, "outputs", "measure", "seo-audit"));
    expect(s2.isDirectory()).toBe(true);
  });

  it("is idempotent (calling twice does not error)", async () => {
    await ws.init();
    await ws.init(); // Should not throw
  });
});

describe("isInitialized", () => {
  it("returns false before init", async () => {
    expect(await ws.isInitialized()).toBe(false);
  });

  it("returns true after init", async () => {
    await ws.init();
    expect(await ws.isInitialized()).toBe(true);
  });
});

// ── Task Operations ──────────────────────────────────────────────────────────

describe("task operations", () => {
  beforeEach(async () => {
    await ws.init();
  });

  it("writeTask + readTask round-trips correctly", async () => {
    const task = createTestTask();
    await ws.writeTask(task);
    const restored = await ws.readTask(task.id);

    expect(restored.id).toBe(task.id);
    expect(restored.status).toBe(task.status);
    expect(restored.priority).toBe(task.priority);
    expect(restored.from).toBe(task.from);
    expect(restored.to).toBe(task.to);
    expect(restored.goal).toBe(task.goal);
  });

  it("listTasks returns all tasks", async () => {
    await ws.writeTask(createTestTask({ id: "task-1", to: "copywriting" }));
    await ws.writeTask(createTestTask({ id: "task-2", to: "page-cro" }));

    const tasks = await ws.listTasks();
    expect(tasks).toHaveLength(2);
  });

  it("listTasks with status filter", async () => {
    await ws.writeTask(createTestTask({ id: "task-1", status: "pending" }));
    await ws.writeTask(
      createTestTask({ id: "task-2", status: "completed" }),
    );

    const pending = await ws.listTasks({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("task-1");
  });

  it("listTasks with priority filter", async () => {
    await ws.writeTask(createTestTask({ id: "task-1", priority: "P0" }));
    await ws.writeTask(createTestTask({ id: "task-2", priority: "P2" }));

    const critical = await ws.listTasks({ priority: "P0" });
    expect(critical).toHaveLength(1);
    expect(critical[0]!.id).toBe("task-1");
  });

  it("updateTaskStatus modifies the status", async () => {
    const task = createTestTask();
    await ws.writeTask(task);
    await ws.updateTaskStatus(task.id, "in_progress");

    const updated = await ws.readTask(task.id);
    expect(updated.status).toBe("in_progress");
  });

  it("readTask throws NOT_FOUND for missing task", async () => {
    try {
      await ws.readTask("nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe("NOT_FOUND");
    }
  });
});

// ── Review Operations ────────────────────────────────────────────────────────

describe("review operations", () => {
  beforeEach(async () => {
    await ws.init();
  });

  it("writeReview + readReview round-trips correctly", async () => {
    const review = createTestReview();
    await ws.writeReview(review);
    const restored = await ws.readReview(review.taskId);

    expect(restored.id).toBe(review.id);
    expect(restored.verdict).toBe(review.verdict);
    expect(restored.reviewer).toBe(review.reviewer);
    expect(restored.summary).toBe(review.summary);
  });

  it("listReviews returns all reviews for a task", async () => {
    const review1 = createTestReview();
    await ws.writeReview(review1);

    const review2 = {
      ...createTestReview(),
      id: "review-copywriting-20260219-a1b2c3-1",
      verdict: "APPROVE" as const,
    };
    await ws.writeReview(review2);

    const reviews = await ws.listReviews("copywriting-20260219-a1b2c3");
    expect(reviews).toHaveLength(2);
  });
});

// ── Output Operations ────────────────────────────────────────────────────────

describe("output operations", () => {
  beforeEach(async () => {
    await ws.init();
  });

  it("writeOutput + readOutput round-trips", async () => {
    const content = "# Signup Page Copy\n\nCompelling headline here.";
    await ws.writeOutput("creative", "copywriting", "task-123", content);
    const restored = await ws.readOutput("creative", "copywriting", "task-123");
    expect(restored).toBe(content);
  });

  it("readOutput throws NOT_FOUND for missing output", async () => {
    try {
      await ws.readOutput("creative", "copywriting", "nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe("NOT_FOUND");
    }
  });
});

// ── Context Operations ───────────────────────────────────────────────────────

describe("context operations", () => {
  beforeEach(async () => {
    await ws.init();
  });

  it("contextExists returns false when no context file", async () => {
    expect(await ws.contextExists()).toBe(false);
  });

  it("contextExists returns true when context file exists", async () => {
    await writeFile(
      ws.paths.contextFile,
      "# Product Marketing Context\n\nTest content",
    );
    expect(await ws.contextExists()).toBe(true);
  });

  it("readContext returns the context file content", async () => {
    const content = "# Product Marketing Context\n\nTest content";
    await writeFile(ws.paths.contextFile, content);
    const result = await ws.readContext();
    expect(result).toBe(content);
  });
});

// ── Memory Operations ────────────────────────────────────────────────────────

describe("memory operations", () => {
  beforeEach(async () => {
    await ws.init();
  });

  it("readLearnings returns empty string when file does not exist", async () => {
    const result = await ws.readLearnings();
    expect(result).toBe("");
  });

  it("appendLearning creates the file on first call", async () => {
    await ws.appendLearning({
      timestamp: "2026-02-19T12:00:00.000Z",
      agent: "copywriting",
      goalId: null,
      outcome: "success",
      learning: "Short headlines work better",
      actionTaken: "Use 6-word headlines",
    });

    const content = await ws.readLearnings();
    expect(content).toContain("# Learnings");
    expect(content).toContain("Short headlines work better");
  });

  it("appendLearning accumulates entries without overwriting", async () => {
    await ws.appendLearning({
      timestamp: "2026-02-19T12:00:00.000Z",
      agent: "copywriting",
      goalId: null,
      outcome: "success",
      learning: "First learning",
      actionTaken: "Action 1",
    });

    await ws.appendLearning({
      timestamp: "2026-02-19T13:00:00.000Z",
      agent: "page-cro",
      goalId: null,
      outcome: "failure",
      learning: "Second learning",
      actionTaken: "Action 2",
    });

    const content = await ws.readLearnings();
    expect(content).toContain("First learning");
    expect(content).toContain("Second learning");
  });
});

// ── Metrics Operations ───────────────────────────────────────────────────────

describe("metrics operations", () => {
  beforeEach(async () => {
    await ws.init();
  });

  it("writeMetricsReport + readMetricsReport round-trips", async () => {
    const content = "# Daily Report\n\nConversion: 3.2%";
    await ws.writeMetricsReport("2026-02-19", content);
    const result = await ws.readMetricsReport("2026-02-19");
    expect(result).toBe(content);
  });
});

// ── Path Safety ──────────────────────────────────────────────────────────────

describe("path safety", () => {
  beforeEach(async () => {
    await ws.init();
  });

  it("rejects path traversal attempts", async () => {
    try {
      await ws.readFile("../../etc/passwd");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe("INVALID_PATH");
    }
  });
});

// ── Generic File Operations ──────────────────────────────────────────────────

describe("generic file operations", () => {
  beforeEach(async () => {
    await ws.init();
  });

  it("fileExists returns false for missing file", async () => {
    expect(await ws.fileExists("tasks/nonexistent.md")).toBe(false);
  });

  it("writeFile + readFile round-trips", async () => {
    await ws.writeFile("tasks/test.md", "content");
    const result = await ws.readFile("tasks/test.md");
    expect(result).toBe("content");
  });

  it("deleteFile removes the file", async () => {
    await ws.writeFile("tasks/to-delete.md", "content");
    await ws.deleteFile("tasks/to-delete.md");
    expect(await ws.fileExists("tasks/to-delete.md")).toBe(false);
  });

  it("deleteFile throws NOT_FOUND for missing file", async () => {
    try {
      await ws.deleteFile("tasks/nonexistent.md");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe("NOT_FOUND");
    }
  });

  it("listFiles returns markdown files sorted", async () => {
    await ws.writeFile("tasks/b-task.md", "b");
    await ws.writeFile("tasks/a-task.md", "a");
    const files = await ws.listFiles("tasks");
    expect(files).toEqual(["a-task.md", "b-task.md"]);
  });
});
