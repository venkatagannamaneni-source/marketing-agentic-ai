import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { AgentExecutor } from "../executor.ts";
import type { ExecutorConfig } from "../executor.ts";
import { ExecutionError, MODEL_MAP } from "../claude-client.ts";
import type {
  ClaudeClient,
  ClaudeMessageParams,
  ClaudeMessageResult,
} from "../claude-client.ts";
import {
  createTestWorkspace,
  type TestWorkspace,
} from "../../director/__tests__/helpers.ts";
import type { Task } from "../../types/task.ts";
import type { BudgetState } from "../../director/types.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

// ── Mock Client ──────────────────────────────────────────────────────────────

function createMockClient(
  handler?:
    | Partial<ClaudeMessageResult>
    | ((
        params: ClaudeMessageParams,
        callIndex: number,
      ) => Partial<ClaudeMessageResult>),
): ClaudeClient & { calls: ClaudeMessageParams[] } {
  const calls: ClaudeMessageParams[] = [];
  let callIndex = 0;

  const defaultResult: ClaudeMessageResult = {
    content:
      "# Page CRO Audit\n\n## Summary\n\nTest output content.\n\n## Findings\n\nDetails here.",
    model: MODEL_MAP.sonnet,
    inputTokens: 1000,
    outputTokens: 500,
    stopReason: "end_turn",
    durationMs: 2500,
  };

  return {
    calls,
    createMessage: async (params) => {
      calls.push(params);
      const currentIndex = callIndex++;
      if (typeof handler === "function") {
        return { ...defaultResult, ...handler(params, currentIndex) };
      }
      if (handler) {
        return { ...defaultResult, ...handler };
      }
      return defaultResult;
    },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function createExecutorConfig(
  overrides: Partial<ExecutorConfig> = {},
): ExecutorConfig {
  return {
    projectRoot: PROJECT_ROOT,
    defaultModel: "sonnet",
    defaultTimeoutMs: 120_000,
    defaultMaxTokens: 8192,
    maxRetries: 3,
    maxContextTokens: 150_000,
    ...overrides,
  };
}

function createExecutorTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "page-cro-20260219-abc123",
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:00.000Z",
    from: "director",
    to: "page-cro",
    priority: "P1",
    deadline: null,
    status: "pending",
    revisionCount: 0,
    goalId: "goal-20260219-abc123",
    pipelineId: null,
    goal: "Increase signup conversion rate by 20%",
    inputs: [],
    requirements: "Audit the signup page for conversion issues",
    output: {
      path: "outputs/convert/page-cro/page-cro-20260219-abc123.md",
      format: "Markdown",
    },
    next: { type: "director_review" },
    tags: [],
    metadata: {},
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

let tw: TestWorkspace;

beforeEach(async () => {
  tw = await createTestWorkspace();
});

afterEach(async () => {
  await tw.cleanup();
});

describe("AgentExecutor", () => {
  describe("execute — happy path", () => {
    it("executes task and returns result", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);

      expect(result.taskId).toBe(task.id);
      expect(result.content).toContain("Page CRO Audit");
      expect(result.truncated).toBe(false);
      expect(result.metadata.modelTier).toBe("sonnet");
      expect(result.metadata.inputTokens).toBe(1000);
      expect(result.metadata.outputTokens).toBe(500);
    });

    it("calls Claude API with correct model for skill", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      await executor.execute(task);

      expect(client.calls.length).toBe(1);
      // page-cro is Convert Squad → sonnet
      expect(client.calls[0]!.model).toBe(MODEL_MAP.sonnet);
    });

    it("uses opus for strategy squad skills", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask({ to: "content-strategy" });
      await tw.workspace.writeTask(task);

      await executor.execute(task);

      expect(client.calls[0]!.model).toBe(MODEL_MAP.opus);
    });

    it("writes output to workspace", async () => {
      const client = createMockClient({
        content: "# Output\n\nContent here.",
      });
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      await executor.execute(task);

      const output = await tw.workspace.readOutput(
        "convert",
        "page-cro",
        task.id,
      );
      expect(output).toBe("# Output\n\nContent here.");
    });

    it("updates task status to in_progress then completed", async () => {
      const statusHistory: string[] = [];
      const originalUpdateStatus =
        tw.workspace.updateTaskStatus.bind(tw.workspace);
      tw.workspace.updateTaskStatus = async (taskId, status) => {
        statusHistory.push(status);
        return originalUpdateStatus(taskId, status);
      };

      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      await executor.execute(task);

      expect(statusHistory).toEqual(["in_progress", "completed"]);
    });

    it("computes cost correctly", async () => {
      const client = createMockClient({
        inputTokens: 10000,
        outputTokens: 5000,
      });
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);

      // sonnet: (10000 * 3 + 5000 * 15) / 1_000_000 = 0.105
      expect(result.metadata.estimatedCost).toBeCloseTo(0.105, 4);
    });
  });

  describe("EC-1: foundation skill null squad", () => {
    it("writes to context/ for product-marketing-context", async () => {
      const client = createMockClient({
        content: "# Product Context\n\nOur product...",
      });
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask({ to: "product-marketing-context" });
      await tw.workspace.writeTask(task);

      await executor.execute(task);

      const content = await tw.workspace.readContext();
      expect(content).toBe("# Product Context\n\nOur product...");
    });
  });

  describe("truncation detection", () => {
    it("sets truncated flag when stopReason is not end_turn", async () => {
      const client = createMockClient((_params, callIndex) => {
        if (callIndex === 0) {
          return { stopReason: "max_tokens", content: "Truncated..." };
        }
        // Retry also truncated
        return { stopReason: "max_tokens", content: "Still truncated..." };
      });
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);

      expect(result.truncated).toBe(true);
      expect(result.metadata.retryCount).toBe(1);
      // Should have made 2 calls (original + retry)
      expect(client.calls.length).toBe(2);
    });

    it("clears truncated flag when retry succeeds", async () => {
      const client = createMockClient((_params, callIndex) => {
        if (callIndex === 0) {
          return { stopReason: "max_tokens", content: "Truncated..." };
        }
        return {
          stopReason: "end_turn",
          content: "# Complete Output\n\nDone.",
        };
      });
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe("# Complete Output\n\nDone.");
      expect(result.metadata.retryCount).toBe(1);
    });
  });

  describe("budget integration", () => {
    it("returns BUDGET_EXHAUSTED when level is exhausted", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const budget: BudgetState = {
        totalBudget: 1000,
        spent: 1000,
        percentUsed: 100,
        level: "exhausted",
        allowedPriorities: [],
        modelOverride: null,
      };

      const result = await executor.execute(task, { budgetState: budget });
      expect(result.status).toBe("failed");
      expect(result.error).toBeInstanceOf(ExecutionError);
      expect(result.error?.code).toBe("BUDGET_EXHAUSTED");
    });

    it("uses haiku when budget override is haiku", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const budget: BudgetState = {
        totalBudget: 1000,
        spent: 960,
        percentUsed: 96,
        level: "critical",
        allowedPriorities: ["P0"],
        modelOverride: "haiku",
      };

      await executor.execute(task, { budgetState: budget });

      expect(client.calls[0]!.model).toBe(MODEL_MAP.haiku);
    });
  });

  describe("error handling", () => {
    it("sets task status to failed on API error", async () => {
      const client: ClaudeClient = {
        createMessage: async () => {
          throw new ExecutionError("API error", "API_ERROR", "", false);
        },
      };
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);
      expect(result.status).toBe("failed");

      const updatedTask = await tw.workspace.readTask(task.id);
      expect(updatedTask.status).toBe("failed");
    });
  });

  describe("EC-7: invalid projectRoot", () => {
    it("returns clear error when skills directory does not exist", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig({ projectRoot: "/nonexistent/path" }),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);
      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("Skills directory not found");
    });
  });

  describe("missing inputs propagation (EC-5)", () => {
    it("propagates missingInputs from prompt builder", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask({
        inputs: [
          {
            path: "outputs/strategy/content-strategy/nonexistent.md",
            description: "Strategy output",
          },
        ],
      });
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);

      expect(result.missingInputs).toContain(
        "outputs/strategy/content-strategy/nonexistent.md",
      );
    });
  });

  describe("EXECUTABLE_STATUSES gate", () => {
    it("rejects tasks with completed status", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask({ status: "completed" });
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);
      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("not executable");
    });

    it("rejects tasks with approved status", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask({ status: "approved" });
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);
      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("not executable");
    });

    it("accepts tasks with revision status", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask({ status: "revision" });
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);
      expect(result.taskId).toBe(task.id);
    });

    it("returns TASK_NOT_EXECUTABLE error code", async () => {
      const client = createMockClient();
      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask({ status: "failed" });
      await tw.workspace.writeTask(task);

      const result = await executor.execute(task);
      expect(result.status).toBe("failed");
      expect(result.error).toBeInstanceOf(ExecutionError);
      expect(result.error?.code).toBe("TASK_NOT_EXECUTABLE");
    });
  });

  describe("signal parameter", () => {
    it("passes signal to createMessage calls", async () => {
      let capturedSignal: AbortSignal | undefined;
      const client: ClaudeClient & { calls: ClaudeMessageParams[] } = {
        calls: [],
        async createMessage(params) {
          capturedSignal = params.signal;
          return {
            content: "# Test\n\nContent.",
            model: MODEL_MAP.sonnet,
            inputTokens: 100,
            outputTokens: 50,
            stopReason: "end_turn",
            durationMs: 500,
          };
        },
      };

      const executor = new AgentExecutor(
        client,
        tw.workspace,
        createExecutorConfig(),
      );
      const task = createExecutorTask();
      await tw.workspace.writeTask(task);

      const controller = new AbortController();
      await executor.execute(task, { signal: controller.signal });

      expect(capturedSignal).toBe(controller.signal);
    });
  });
});
