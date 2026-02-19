import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentExecutor } from "../agent-executor.ts";
import { MockClaudeClient } from "../claude-client.ts";
import {
  ExecutionError,
  createDefaultConfig,
  type ExecutorConfig,
  type ClaudeResponse,
} from "../types.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import type { WorkspaceManager } from "../../workspace/workspace-manager.ts";
import type { Task } from "../../types/task.ts";

// ── Test Setup ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

let tempDir: string;
let workspace: WorkspaceManager;
let client: MockClaudeClient;
let config: ExecutorConfig;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "executor-test-"));
  workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
  await workspace.init();
  client = new MockClaudeClient();
  config = createDefaultConfig({
    projectRoot: PROJECT_ROOT,
    maxRetries: 1,
    retryDelayMs: 10, // fast retries in tests
    defaultTimeoutMs: 10_000,
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "copywriting-20260219-abc123",
    createdAt: "2026-02-19T10:00:00Z",
    updatedAt: "2026-02-19T10:00:00Z",
    from: "director",
    to: "copywriting",
    priority: "P1",
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: "goal-1",
    pipelineId: null,
    goal: "Write signup page copy",
    inputs: [],
    requirements: "Write a compelling headline and 3 benefit bullets.",
    output: {
      path: "outputs/creative/copywriting/copywriting-20260219-abc123.md",
      format: "markdown",
    },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
    ...overrides,
  };
}

async function writeTaskToWorkspace(task: Task): Promise<void> {
  await workspace.writeTask(task);
}

// ── Happy Path ──────────────────────────────────────────────────────────────

describe("AgentExecutor — happy path", () => {
  it("executes a task end-to-end", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");
    expect(result.taskId).toBe("copywriting-20260219-abc123");
    expect(result.skill).toBe("copywriting");
    expect(result.outputPath).toBe(
      "outputs/creative/copywriting/copywriting-20260219-abc123.md",
    );
    expect(result.tokensUsed.input).toBe(100);
    expect(result.tokensUsed.output).toBe(200);
    expect(result.tokensUsed.total).toBe(300);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("writes output to correct workspace path", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    await executor.execute(task);

    const output = await workspace.readOutput(
      "creative",
      "copywriting",
      "copywriting-20260219-abc123",
    );
    expect(output).toBe("Mock output for task");
  });

  it("updates task status to completed", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    await executor.execute(task);

    const updated = await workspace.readTask("copywriting-20260219-abc123");
    expect(updated.status).toBe("completed");
  });

  it("sends correct system prompt from SKILL.md", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    await executor.execute(task);

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.systemPrompt).toContain("expert conversion copywriter");
  });

  it("includes task requirements in user message", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    await executor.execute(task);

    const call = client.calls[0]!;
    expect(call.userMessage).toContain(
      "Write a compelling headline and 3 benefit bullets",
    );
  });

  it("uses correct model from config", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    await executor.execute(task);

    const call = client.calls[0]!;
    expect(call.model).toBe("claude-sonnet-4-5-20250929");
  });
});

// ── Task Status Edge Cases ──────────────────────────────────────────────────

describe("AgentExecutor — task status validation", () => {
  for (const status of ["pending", "assigned", "revision"] as const) {
    it(`executes task with status "${status}"`, async () => {
      const task = makeTask({ status });
      await writeTaskToWorkspace(task);

      const executor = new AgentExecutor(client, workspace, config);
      const result = await executor.execute(task);

      expect(result.status).toBe("completed");
    });
  }

  for (const status of [
    "completed",
    "failed",
    "cancelled",
    "in_progress",
    "in_review",
    "blocked",
    "deferred",
    "approved",
  ] as const) {
    it(`rejects task with status "${status}"`, async () => {
      const task = makeTask({ status });

      const executor = new AgentExecutor(client, workspace, config);
      const result = await executor.execute(task);

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("TASK_NOT_EXECUTABLE");
      expect(client.calls).toHaveLength(0);
    });
  }
});

// ── Context Edge Cases ──────────────────────────────────────────────────────

describe("AgentExecutor — product context", () => {
  it("includes product context when available", async () => {
    // Write product context to workspace
    await workspace.writeFile(
      "context/product-marketing-context.md",
      "# Our Product\n\nWe build dev tools for startups.",
    );

    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    await executor.execute(task);

    const call = client.calls[0]!;
    expect(call.userMessage).toContain("We build dev tools for startups");
  });

  it("works without product context", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");
    const call = client.calls[0]!;
    expect(call.userMessage).toContain(
      "No product marketing context available",
    );
  });

  it("handles product-marketing-context skill without existing context", async () => {
    const task = makeTask({
      id: "product-marketing-context-20260219-def456",
      to: "product-marketing-context",
      output: {
        path: "context/product-marketing-context.md",
        format: "markdown",
      },
    });
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");
    // Output should be written to context path
    const content = await workspace.readFile(
      "context/product-marketing-context.md",
    );
    expect(content).toBe("Mock output for task");
  });
});

// ── Upstream Input Edge Cases ───────────────────────────────────────────────

describe("AgentExecutor — upstream inputs", () => {
  it("loads upstream inputs and includes in prompt", async () => {
    // Write an upstream output
    await workspace.writeOutput(
      "strategy",
      "content-strategy",
      "strategy-task-1",
      "# Strategy\n\nFocus on developers.",
    );

    const task = makeTask({
      inputs: [
        {
          path: "outputs/strategy/content-strategy/strategy-task-1.md",
          description: "Content strategy output",
        },
      ],
    });
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");
    const call = client.calls[0]!;
    expect(call.userMessage).toContain("Content strategy output");
    expect(call.userMessage).toContain("Focus on developers");
  });

  it("fails when upstream input is missing", async () => {
    const task = makeTask({
      inputs: [
        {
          path: "outputs/strategy/content-strategy/missing-task.md",
          description: "Missing strategy",
        },
      ],
    });
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INPUT_NOT_FOUND");
    expect(result.error?.message).toContain("missing-task.md");
    expect(client.calls).toHaveLength(0);

    // Task should be marked as failed
    const updated = await workspace.readTask(task.id);
    expect(updated.status).toBe("failed");
  });

  it("handles empty inputs array", async () => {
    const task = makeTask({ inputs: [] });
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");
    const call = client.calls[0]!;
    expect(call.userMessage).toContain("No upstream inputs for this task");
  });
});

// ── API Error Edge Cases ────────────────────────────────────────────────────

describe("AgentExecutor — API errors and retries", () => {
  it("retries on rate limit and succeeds", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    // First call fails, second succeeds
    client.setError(
      new ExecutionError("rate limited", "API_RATE_LIMITED", ""),
    );

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");
    // Mock records the call before checking error, so both calls are recorded:
    // 1 failed call (rate limited) + 1 successful retry = 2 total
    expect(client.calls).toHaveLength(2);
  });

  it("fails after all retries exhausted", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    // All calls fail
    client.setError(
      new ExecutionError("overloaded", "API_OVERLOADED", ""),
      false, // persistent
    );

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("API_OVERLOADED");

    const updated = await workspace.readTask(task.id);
    expect(updated.status).toBe("failed");
  });

  it("does not retry non-retryable errors", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    client.setError(
      new ExecutionError("empty response", "RESPONSE_EMPTY", ""),
    );

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("failed");
    // Only 1 call (no retry for RESPONSE_EMPTY)
    expect(client.calls).toHaveLength(1);
  });

  it("fails on persistent API error after retries exhausted", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    client.setError(
      new ExecutionError("Internal server error", "API_ERROR", ""),
      false, // persistent — every call fails
    );

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("API_ERROR");
  });

  it("fails immediately with no retries when maxRetries is 0", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    client.setError(
      new ExecutionError("rate limited", "API_RATE_LIMITED", ""),
      false, // persistent
    );

    const zeroRetryConfig = createDefaultConfig({
      projectRoot: PROJECT_ROOT,
      maxRetries: 0,
      retryDelayMs: 10,
      defaultTimeoutMs: 10_000,
    });

    const executor = new AgentExecutor(client, workspace, zeroRetryConfig);
    const result = await executor.execute(task);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("API_RATE_LIMITED");
    // Only 1 call — no retry attempts
    expect(client.calls).toHaveLength(1);
  });

  it("aborts during retry backoff sleep", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    // First call fails with retryable error, then backoff sleep starts
    client.setError(
      new ExecutionError("rate limited", "API_RATE_LIMITED", ""),
      false, // persistent so retry would also fail
    );

    const slowRetryConfig = createDefaultConfig({
      projectRoot: PROJECT_ROOT,
      maxRetries: 3,
      retryDelayMs: 5000, // long delay to ensure abort fires during sleep
      defaultTimeoutMs: 30_000,
    });

    const controller = new AbortController();
    const executor = new AgentExecutor(client, workspace, slowRetryConfig);
    const promise = executor.execute(task, { signal: controller.signal });

    // Abort after first call fails and retry sleep begins
    setTimeout(() => controller.abort(), 100);

    const result = await promise;

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ABORTED");
    // Only 1 call — aborted during retry sleep before second attempt
    expect(client.calls).toHaveLength(1);
  });
});

// ── Response Edge Cases ─────────────────────────────────────────────────────

describe("AgentExecutor — response handling", () => {
  it("fails on empty response", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    client = new MockClaudeClient(() => ({
      content: "",
      inputTokens: 50,
      outputTokens: 0,
      stopReason: "end_turn",
    }));

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("RESPONSE_EMPTY");
  });

  it("fails on whitespace-only response", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    client = new MockClaudeClient(() => ({
      content: "   \n  \t  ",
      inputTokens: 50,
      outputTokens: 5,
      stopReason: "end_turn",
    }));

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("RESPONSE_EMPTY");
  });

  it("completes with warning when response is truncated", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    client = new MockClaudeClient(() => ({
      content: "Truncated output that was cut off",
      inputTokens: 100,
      outputTokens: 4096,
      stopReason: "max_tokens",
    }));

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    // Status is completed (output was still written)
    expect(result.status).toBe("completed");
    expect(result.outputPath).toBeTruthy();

    // But error contains truncation warning
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("RESPONSE_TRUNCATED");

    // Output was written despite truncation
    const output = await workspace.readOutput(
      "creative",
      "copywriting",
      task.id,
    );
    expect(output).toBe("Truncated output that was cut off");
  });
});

// ── Abort/Cancellation Edge Cases ───────────────────────────────────────────

describe("AgentExecutor — abort handling", () => {
  it("returns ABORTED when signal is already aborted", async () => {
    const task = makeTask();

    const controller = new AbortController();
    controller.abort();

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task, {
      signal: controller.signal,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ABORTED");
    expect(client.calls).toHaveLength(0);
  });

  it("aborts during API call", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    client.setDelay(5000); // long delay

    const controller = new AbortController();
    const executor = new AgentExecutor(client, workspace, config);

    const promise = executor.execute(task, { signal: controller.signal });

    // Abort after short delay
    setTimeout(() => controller.abort(), 50);

    const result = await promise;

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ABORTED");
  });

  it("executes normally when signal is not aborted", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const controller = new AbortController();
    const executor = new AgentExecutor(client, workspace, config);

    const result = await executor.execute(task, {
      signal: controller.signal,
    });

    expect(result.status).toBe("completed");
  });
});

// ── Config Overrides ────────────────────────────────────────────────────────

describe("AgentExecutor — config overrides", () => {
  it("uses per-task model tier override", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    await executor.execute(task, {
      agentConfig: { skill: "copywriting", modelTier: "opus", timeoutMs: 60_000, maxRetries: 0 },
    });

    const call = client.calls[0]!;
    expect(call.model).toBe("claude-opus-4-6");
  });

  it("uses default config when no overrides provided", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    await executor.execute(task);

    const call = client.calls[0]!;
    expect(call.model).toBe("claude-sonnet-4-5-20250929");
    expect(call.maxTokens).toBe(4096);
  });
});

// ── Revision Context ────────────────────────────────────────────────────────

describe("AgentExecutor — revision handling", () => {
  it("includes revision context for revision tasks", async () => {
    const task = makeTask({ status: "revision", revisionCount: 2 });
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");
    const call = client.calls[0]!;
    expect(call.userMessage).toContain("Revision Context");
    expect(call.userMessage).toContain("revision #2");
  });
});

// ── Token Tracking ──────────────────────────────────────────────────────────

describe("AgentExecutor — token tracking", () => {
  it("tracks token usage from API response", async () => {
    const task = makeTask();
    await writeTaskToWorkspace(task);

    client = new MockClaudeClient(() => ({
      content: "Generated copy",
      inputTokens: 500,
      outputTokens: 1200,
      stopReason: "end_turn",
    }));

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.tokensUsed.input).toBe(500);
    expect(result.tokensUsed.output).toBe(1200);
    expect(result.tokensUsed.total).toBe(1700);
  });

  it("reports zero tokens on failure", async () => {
    const task = makeTask({ status: "completed" });

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.tokensUsed.input).toBe(0);
    expect(result.tokensUsed.output).toBe(0);
    expect(result.tokensUsed.total).toBe(0);
  });
});

// ── Output Path Routing ─────────────────────────────────────────────────────

describe("AgentExecutor — output routing", () => {
  it("writes to squad output path for normal skills", async () => {
    const task = makeTask({ to: "page-cro", id: "page-cro-20260219-xyz789" });
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");

    const output = await workspace.readOutput(
      "convert",
      "page-cro",
      "page-cro-20260219-xyz789",
    );
    expect(output).toBe("Mock output for task");
  });

  it("writes to context path for foundation skill", async () => {
    const task = makeTask({
      to: "product-marketing-context",
      id: "product-marketing-context-20260219-aaa111",
      output: {
        path: "context/product-marketing-context.md",
        format: "markdown",
      },
    });
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(client, workspace, config);
    const result = await executor.execute(task);

    expect(result.status).toBe("completed");
    expect(result.outputPath).toBe("context/product-marketing-context.md");

    const content = await workspace.readFile(
      "context/product-marketing-context.md",
    );
    expect(content).toBe("Mock output for task");
  });
});

// ── Never Throws ────────────────────────────────────────────────────────────

describe("AgentExecutor — error contract", () => {
  it("never throws, always returns ExecutionResult", async () => {
    // Even with a completely broken client, executor returns a result
    const brokenClient = new MockClaudeClient();
    brokenClient.setError(new Error("catastrophic failure"), false);

    const task = makeTask();
    await writeTaskToWorkspace(task);

    const executor = new AgentExecutor(brokenClient, workspace, config);

    // This should NOT throw
    const result = await executor.execute(task);

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });
});
