import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { SequentialPipelineEngine } from "../pipeline-engine.ts";
import { PipelineError } from "../types.ts";
import type { StepResult, PipelineEngineConfig } from "../types.ts";
import type { PipelineRun } from "../../types/pipeline.ts";
import { AgentExecutor } from "../../agents/executor.ts";
import type { ExecutorConfig } from "../../agents/executor.ts";
import { ExecutionError } from "../../agents/claude-client.ts";
import type {
  ClaudeClient,
  ClaudeMessageParams,
  ClaudeMessageResult,
} from "../../agents/claude-client.ts";
import { PipelineFactory } from "../../director/pipeline-factory.ts";
import { PIPELINE_TEMPLATES } from "../../agents/registry.ts";
import type { WorkspaceManager } from "../../workspace/workspace-manager.ts";
import {
  createTestWorkspace,
  createTestDefinition,
  createSingleStepDefinition,
  createParallelStepDefinition,
  createReviewStepDefinition,
  createTestRun,
  createConcurrencyTrackingClient,
  type TestWorkspace,
} from "./helpers.ts";

// ── Local MockClaudeClient ───────────────────────────────────────────────────

class MockClaudeClient implements ClaudeClient {
  readonly calls: ClaudeMessageParams[] = [];
  private responseGenerator:
    | ((params: ClaudeMessageParams) => Partial<ClaudeMessageResult>)
    | null;

  constructor(
    responseGenerator?: (
      params: ClaudeMessageParams,
    ) => Partial<ClaudeMessageResult>,
  ) {
    this.responseGenerator = responseGenerator ?? null;
  }

  async createMessage(
    params: ClaudeMessageParams,
  ): Promise<ClaudeMessageResult> {
    this.calls.push(params);
    const defaults: ClaudeMessageResult = {
      content: "Mock output for task",
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 100,
      outputTokens: 200,
      stopReason: "end_turn",
      durationMs: 100,
    };
    if (this.responseGenerator) {
      return { ...defaults, ...this.responseGenerator(params) };
    }
    return defaults;
  }
}

// ── Test Setup ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

const executorConfig: ExecutorConfig = {
  projectRoot: PROJECT_ROOT,
  defaultModel: "sonnet",
  defaultTimeoutMs: 10_000,
  defaultMaxTokens: 8192,
  maxRetries: 0,
  maxContextTokens: 150_000,
};

let tw: TestWorkspace;
let client: MockClaudeClient;
let executor: AgentExecutor;
let factory: PipelineFactory;
let engine: SequentialPipelineEngine;

beforeEach(async () => {
  tw = await createTestWorkspace();
  client = new MockClaudeClient();
  executor = new AgentExecutor(client, tw.workspace, executorConfig);
  factory = new PipelineFactory(PIPELINE_TEMPLATES);
  engine = new SequentialPipelineEngine(factory, executor, tw.workspace);
});

afterEach(async () => {
  await tw.cleanup();
});

function defaultConfig(
  overrides?: Partial<PipelineEngineConfig>,
): PipelineEngineConfig {
  return {
    goalDescription: "Test pipeline execution",
    priority: "P2",
    ...overrides,
  };
}

// ── Happy Path ──────────────────────────────────────────────────────────────

describe("SequentialPipelineEngine — happy path", () => {
  it("executes a 3-step sequential pipeline end-to-end", async () => {
    const definition = createTestDefinition();
    const run = createTestRun();

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("completed");
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults[0]!.status).toBe("completed");
    expect(result.stepResults[1]!.status).toBe("completed");
    expect(result.stepResults[2]!.status).toBe("completed");
    expect(client.calls).toHaveLength(3);
    expect(run.status).toBe("completed");
    expect(run.completedAt).not.toBeNull();
    expect(run.currentStepIndex).toBe(2);
  });

  it("wires step N output paths as step N+1 input paths", async () => {
    const definition = createTestDefinition({
      steps: [
        { type: "sequential", skill: "content-strategy" },
        { type: "sequential", skill: "copywriting" },
      ],
    });
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(definition, run, defaultConfig());

    // Step 1 (copywriting) should receive the output path from step 0 (content-strategy)
    // The 2nd API call's user message should reference the upstream output
    expect(client.calls).toHaveLength(2);
    const secondCall = client.calls[1]!;
    // The upstream output from content-strategy should be referenced in the prompt
    const userContent = secondCall.messages.find(
      (m) => m.role === "user",
    )?.content;
    expect(userContent).toContain("content-strategy");
  });

  it("persists all tasks to workspace", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(definition, run, defaultConfig());

    const tasks = await tw.workspace.listTasks();
    expect(tasks).toHaveLength(3);
    // All tasks should be marked completed by the executor
    for (const task of tasks) {
      expect(task.status).toBe("completed");
    }
  });

  it("records all task IDs on the PipelineRun", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(definition, run, defaultConfig());

    expect(run.taskIds).toHaveLength(3);
    // Each task ID should correspond to the skill
    expect(run.taskIds[0]).toContain("content-strategy");
    expect(run.taskIds[1]).toContain("copywriting");
    expect(run.taskIds[2]).toContain("copy-editing");
  });

  it("aggregates token usage across all steps", async () => {
    client = new MockClaudeClient((_params: ClaudeMessageParams) => ({
      content: "Generated output",
      inputTokens: 100,
      outputTokens: 200,
      stopReason: "end_turn",
    }));
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.totalTokensUsed.input).toBe(300); // 100 * 3 steps
    expect(result.totalTokensUsed.output).toBe(600); // 200 * 3 steps
    expect(result.totalTokensUsed.total).toBe(900);
  });

  it("calls onStepComplete callback after each step", async () => {
    const stepResults: StepResult[] = [];
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(
      definition,
      run,
      defaultConfig({
        onStepComplete: (result) => stepResults.push(result),
      }),
    );

    expect(stepResults).toHaveLength(3);
    expect(stepResults[0]!.stepIndex).toBe(0);
    expect(stepResults[1]!.stepIndex).toBe(1);
    expect(stepResults[2]!.stepIndex).toBe(2);
  });

  it("calls onStatusChange callback for status transitions", async () => {
    const statusChanges: string[] = [];
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(
      definition,
      run,
      defaultConfig({
        onStatusChange: (r) => statusChanges.push(r.status),
      }),
    );

    expect(statusChanges).toContain("running");
    expect(statusChanges).toContain("completed");
    expect(statusChanges[0]).toBe("running");
    expect(statusChanges[statusChanges.length - 1]).toBe("completed");
  });

  it("handles single-step pipeline", async () => {
    const definition = createSingleStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("completed");
    expect(result.stepResults).toHaveLength(1);
    expect(client.calls).toHaveLength(1);
    expect(run.status).toBe("completed");
  });

  it("tracks total duration", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Parallel Step Execution ──────────────────────────────────────────────────

describe("SequentialPipelineEngine — parallel step execution", () => {
  it("executes parallel step skills concurrently", async () => {
    const definition = createParallelStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("completed");
    expect(result.stepResults).toHaveLength(2);
    // Step 1 is parallel with 4 skills
    expect(result.stepResults[1]!.executionResults).toHaveLength(4);
    // 1 sequential + 4 parallel = 5 total API calls
    expect(client.calls).toHaveLength(5);
  });

  it("collects all output paths from parallel step for downstream wiring", async () => {
    const definition = createTestDefinition({
      id: "parallel-wiring-test",
      steps: [
        { type: "sequential", skill: "content-strategy" },
        {
          type: "parallel",
          skills: ["copywriting", "social-content"],
        },
        { type: "sequential", skill: "copy-editing" },
      ],
    });
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("completed");
    // Step 1 (parallel) should have 2 output paths
    expect(result.stepResults[1]!.outputPaths).toHaveLength(2);
    // Step 2 (copy-editing) should reference both upstream outputs
    expect(client.calls).toHaveLength(4); // 1 + 2 + 1
    const lastCall = client.calls[3]!;
    // Both upstream outputs should appear in the copy-editing prompt
    const lastUserContent = lastCall.messages.find(
      (m) => m.role === "user",
    )?.content;
    // Both upstream output paths should be referenced in input-file tags
    expect(lastUserContent).toContain("copywriting");
    expect(lastUserContent).toContain("social-content");
  });

  it("fails fast on first parallel sub-task failure", async () => {
    let callCount = 0;
    client = new MockClaudeClient((_params: ClaudeMessageParams) => {
      callCount++;
      if (callCount === 3) {
        // 3rd call is 2nd parallel sub-task (1 sequential + 2 parallel, maxConcurrency=1)
        throw new ExecutionError("API exploded", "API_ERROR", "", false);
      }
      return {
        content: "Generated output",
        inputTokens: 100,
        outputTokens: 200,
        stopReason: "end_turn",
      };
    });
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createParallelStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    // Use maxConcurrency=1 for deterministic failure ordering
    const result = await engine.execute(
      definition,
      run,
      defaultConfig({ maxConcurrency: 1 }),
    );

    expect(result.status).toBe("failed");
    // Step 0 succeeded, step 1 failed
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]!.status).toBe("completed");
    expect(result.stepResults[1]!.status).toBe("failed");
    // With maxConcurrency=1, exactly 2 of 4 sub-tasks ran before failure
    expect(result.stepResults[1]!.executionResults).toHaveLength(2);
    expect(result.error?.code).toBe("STEP_FAILED");
  });

  it("records all parallel task IDs on the PipelineRun before execution", async () => {
    const definition = createParallelStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(definition, run, defaultConfig());

    // 1 sequential + 4 parallel = 5 task IDs (all recorded upfront)
    expect(run.taskIds).toHaveLength(5);
  });

  it("records all task IDs even when parallel execution fails immediately", async () => {
    client = new MockClaudeClient((_params: ClaudeMessageParams) => {
      throw new ExecutionError("API exploded", "API_ERROR", "", false);
    });
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createTestDefinition({
      id: "parallel-fail-ids",
      steps: [
        {
          type: "parallel",
          skills: ["copywriting", "social-content", "paid-ads"],
        },
      ],
    });
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(definition, run, defaultConfig());

    // All 3 task IDs recorded even though execution failed
    expect(run.taskIds).toHaveLength(3);
  });

  it("returns execution results in task order", async () => {
    const definition = createTestDefinition({
      id: "parallel-order-test",
      steps: [
        {
          type: "parallel",
          skills: ["copywriting", "email-sequence", "social-content"],
        },
      ],
    });
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("completed");
    const skills = result.stepResults[0]!.executionResults.map(
      (r) => r.skill,
    );
    // Results should be in the same order as the skills array
    expect(skills).toEqual(["copywriting", "email-sequence", "social-content"]);
  });
});

// ── Review Step Handling ────────────────────────────────────────────────────

describe("SequentialPipelineEngine — review step handling", () => {
  it("pauses pipeline at review step", async () => {
    const definition = createReviewStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("paused");
    // 2 sequential steps completed, 1 review step paused
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults[0]!.status).toBe("completed");
    expect(result.stepResults[1]!.status).toBe("completed");
    expect(result.stepResults[2]!.status).toBe("paused");
    expect(run.status).toBe("paused");
    expect(run.currentStepIndex).toBe(2); // paused at review step
    expect(run.completedAt).toBeNull();
    expect(result.error?.code).toBe("PAUSED_FOR_REVIEW");
    // Only 2 API calls (the review step doesn't call Claude)
    expect(client.calls).toHaveLength(2);
  });

  it("resumes paused pipeline from step after review", async () => {
    const definition = createReviewStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    // First execution: pauses at review step
    const pausedResult = await engine.execute(
      definition,
      run,
      defaultConfig(),
    );
    expect(pausedResult.status).toBe("paused");

    // Collect the output paths from the last completed step before the review
    const lastCompletedStep = pausedResult.stepResults[1]!;
    const outputPaths = lastCompletedStep.outputPaths;

    // Resume: execute again with paused run and initial input paths
    const resumedResult = await engine.execute(
      definition,
      run,
      defaultConfig({ initialInputPaths: outputPaths }),
    );

    expect(resumedResult.status).toBe("completed");
    // Only the remaining step (copy-editing, step 3) was executed
    expect(resumedResult.stepResults).toHaveLength(1);
    expect(resumedResult.stepResults[0]!.status).toBe("completed");
    expect(run.status).toBe("completed");
    expect(run.completedAt).not.toBeNull();
    // 3 total API calls: 2 from first run + 1 from resumed run
    expect(client.calls).toHaveLength(3);
  });
});

// ── Failure Handling ────────────────────────────────────────────────────────

describe("SequentialPipelineEngine — failure handling", () => {
  it("fails pipeline on agent execution failure (fail-fast)", async () => {
    let callCount = 0;
    client = new MockClaudeClient((_params: ClaudeMessageParams) => {
      callCount++;
      if (callCount === 2) {
        throw new ExecutionError("API error", "API_ERROR", "", false);
      }
      return {
        content: "Generated output",
        inputTokens: 100,
        outputTokens: 200,
        stopReason: "end_turn",
      };
    });
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("failed");
    expect(result.stepResults[0]!.status).toBe("completed");
    expect(result.stepResults[1]!.status).toBe("failed");
    expect(result.stepResults).toHaveLength(2); // step 2 never ran
    expect(run.status).toBe("failed");
    expect(result.error?.code).toBe("STEP_FAILED");
  });

  it("returns NO_STEPS error for empty definition", async () => {
    const definition = createTestDefinition({ steps: [] });
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(PipelineError);
    expect(result.error?.code).toBe("NO_STEPS");
    expect(client.calls).toHaveLength(0);
    // BUG 2 fix: run.status should also be "failed"
    expect(run.status).toBe("failed");
    expect(run.completedAt).not.toBeNull();
  });

  it("returns ALREADY_RUNNING error for non-pending/non-paused run", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ status: "running" });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALREADY_RUNNING");
    expect(client.calls).toHaveLength(0);
  });

  it("returns ALREADY_RUNNING error for completed run", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ status: "completed" });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALREADY_RUNNING");
  });

  it("never throws from execute()", async () => {
    // Set up a broken mock client that throws unexpectedly
    client = new MockClaudeClient((_params: ClaudeMessageParams) => {
      throw new Error("Unexpected catastrophic failure");
    });
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    // Should not throw — should return a failed result
    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe("SequentialPipelineEngine — cancellation", () => {
  it("cancels pipeline when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({ signal: controller.signal }),
    );

    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("ABORTED");
    expect(client.calls).toHaveLength(0);
    expect(run.status).toBe("cancelled");
  });

  it("cancels pipeline between steps", async () => {
    const controller = new AbortController();

    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({
        signal: controller.signal,
        onStepComplete: (stepResult) => {
          // After step 0 completes, abort
          if (stepResult.stepIndex === 0) {
            controller.abort();
          }
        },
      }),
    );

    expect(result.status).toBe("cancelled");
    // Step 0 completed, but step 1 was not started because signal was checked
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]!.status).toBe("completed");
    expect(client.calls).toHaveLength(1);
  });

  it("cancels between parallel sub-tasks", async () => {
    const controller = new AbortController();

    // Abort after the first API call within the parallel step
    let callCount = 0;
    client = new MockClaudeClient((_params: ClaudeMessageParams) => {
      callCount++;
      // After the 2nd call (1st parallel sub-task), abort
      if (callCount === 2) {
        controller.abort();
      }
      return {
        content: "Generated output",
        inputTokens: 100,
        outputTokens: 200,
        stopReason: "end_turn",
      };
    });
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createParallelStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({ signal: controller.signal }),
    );

    // Pipeline should fail because signal was aborted during parallel step
    expect(["failed", "cancelled"]).toContain(result.status);
    // Fewer than 5 calls made (not all parallel sub-tasks ran)
    expect(client.calls.length).toBeLessThan(5);
  });
});

// ── Integration with Content Production ─────────────────────────────────────

describe("SequentialPipelineEngine — Content Production integration", () => {
  it("runs full Content Production pipeline (5 sequential steps)", async () => {
    // Use the real Content Production template via PipelineFactory
    const { definition, run } = factory.instantiate(
      "Content Production",
      "Weekly blog content production",
      "goal-weekly-001",
    );

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({
        goalDescription: "Weekly blog content production",
        priority: "P2",
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.stepResults).toHaveLength(5);
    // 5 API calls: content-strategy → copywriting → copy-editing → seo-audit → schema-markup
    expect(client.calls).toHaveLength(5);

    // All 5 task IDs should be recorded
    expect(run.taskIds).toHaveLength(5);

    // Verify tasks are persisted
    const tasks = await tw.workspace.listTasks();
    expect(tasks).toHaveLength(5);

    // Verify output wiring: each step after the first references upstream output
    for (let i = 1; i < result.stepResults.length; i++) {
      const stepResult = result.stepResults[i]!;
      expect(stepResult.tasks[0]!.inputs.length).toBeGreaterThan(1);
      expect(stepResult.tasks[0]!.inputs[1]!.description).toBe(
        "Output from previous pipeline step",
      );
    }

    // Last task's next should be director_review
    const lastStep = result.stepResults[4]!;
    expect(lastStep.tasks[0]!.next).toEqual({ type: "director_review" });

    // Non-last tasks should be pipeline_continue
    const middleStep = result.stepResults[2]!;
    expect(middleStep.tasks[0]!.next).toEqual({
      type: "pipeline_continue",
      pipelineId: run.id,
    });
  });

  it("preserves truncation warnings from executor", async () => {
    client = new MockClaudeClient((_params: ClaudeMessageParams) => ({
      content: "Truncated output...",
      inputTokens: 100,
      outputTokens: 4096,
      stopReason: "max_tokens",
    }));
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createSingleStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    // Truncation is a warning, not a failure
    expect(result.status).toBe("completed");
    expect(result.stepResults[0]!.status).toBe("completed");
    // The execution result within the step should carry the truncation warning
    const execResult = result.stepResults[0]!.executionResults[0]!;
    expect(execResult.status).toBe("completed");
    expect(execResult.truncated).toBe(true);
    expect(execResult.warnings.length).toBeGreaterThan(0);
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────────────

describe("SequentialPipelineEngine — edge cases", () => {
  it("returns correct pipelineId and pipelineRunId in result", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.pipelineId).toBe(definition.id);
    expect(result.pipelineRunId).toBe(run.id);
  });

  it("sets completedAt on failed pipeline", async () => {
    client = new MockClaudeClient((_params: ClaudeMessageParams) => {
      throw new ExecutionError("API error", "API_ERROR", "", false);
    });
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(definition, run, defaultConfig());

    expect(run.status).toBe("failed");
    expect(run.completedAt).not.toBeNull();
  });

  it("uses initialInputPaths for first step when provided", async () => {
    const definition = createTestDefinition({
      steps: [{ type: "sequential", skill: "copywriting" }],
    });
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(
      definition,
      run,
      defaultConfig({
        initialInputPaths: ["outputs/strategy/content-strategy/prev-task.md"],
      }),
    );

    // The task should have the initial input path wired
    const tasks = await tw.workspace.listTasks();
    expect(tasks).toHaveLength(1);
    const taskInputPaths = tasks[0]!.inputs.map((i) => i.path);
    expect(taskInputPaths).toContain(
      "outputs/strategy/content-strategy/prev-task.md",
    );
  });
});

// ── Production Readiness: Bug Fix Regression Tests ──────────────────────────

describe("SequentialPipelineEngine — run.status consistency (BUG 2)", () => {
  it("sets run.status to 'failed' when definition has no steps", async () => {
    const definition = createTestDefinition({ steps: [] });
    const run = createTestRun();

    const result = await engine.execute(definition, run, defaultConfig());

    // result.status and run.status must always agree
    expect(result.status).toBe("failed");
    expect(run.status).toBe("failed");
    expect(result.run.status).toBe("failed");
    expect(run.completedAt).not.toBeNull();
  });

  it("preserves original run.status when ALREADY_RUNNING", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ status: "running" });

    const result = await engine.execute(definition, run, defaultConfig());

    // run.status should NOT be mutated — it was already "running"
    expect(result.status).toBe("failed");
    expect(run.status).toBe("running"); // preserved, not overwritten
  });
});

describe("SequentialPipelineEngine — callback safety (BUG 3)", () => {
  it("survives onStepComplete callback throwing", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({
        onStepComplete: () => {
          throw new Error("Callback exploded!");
        },
      }),
    );

    // Pipeline should complete successfully despite callback throwing
    expect(result.status).toBe("completed");
    expect(run.status).toBe("completed");
    expect(result.stepResults).toHaveLength(3);
  });

  it("survives onStatusChange callback throwing", async () => {
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({
        onStatusChange: () => {
          throw new Error("Status callback exploded!");
        },
      }),
    );

    // Pipeline should complete successfully despite callback throwing
    expect(result.status).toBe("completed");
    expect(run.status).toBe("completed");
  });
});

describe("SequentialPipelineEngine — completedAt ordering (BUG 6)", () => {
  it("sets completedAt BEFORE onStatusChange fires on completion", async () => {
    let completedAtWhenNotified: string | null = null;
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(
      definition,
      run,
      defaultConfig({
        onStatusChange: (r) => {
          if (r.status === "completed") {
            completedAtWhenNotified = r.completedAt;
          }
        },
      }),
    );

    expect(completedAtWhenNotified).not.toBeNull();
  });

  it("sets completedAt BEFORE onStatusChange fires on failure", async () => {
    let completedAtWhenNotified: string | null = null;
    client = new MockClaudeClient((_params: ClaudeMessageParams) => {
      throw new ExecutionError("API error", "API_ERROR", "", false);
    });
    executor = new AgentExecutor(client, tw.workspace, executorConfig);
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(
      definition,
      run,
      defaultConfig({
        onStatusChange: (r) => {
          if (r.status === "failed") {
            completedAtWhenNotified = r.completedAt;
          }
        },
      }),
    );

    expect(completedAtWhenNotified).not.toBeNull();
  });
});

describe("SequentialPipelineEngine — cancelled pipeline completedAt (BUG 7)", () => {
  it("sets completedAt when pipeline is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(
      definition,
      run,
      defaultConfig({ signal: controller.signal }),
    );

    expect(run.status).toBe("cancelled");
    expect(run.completedAt).not.toBeNull();
  });

  it("sets completedAt when cancelled between steps", async () => {
    const controller = new AbortController();
    const definition = createTestDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    await engine.execute(
      definition,
      run,
      defaultConfig({
        signal: controller.signal,
        onStepComplete: (stepResult) => {
          if (stepResult.stepIndex === 0) controller.abort();
        },
      }),
    );

    expect(run.status).toBe("cancelled");
    expect(run.completedAt).not.toBeNull();
  });
});

describe("SequentialPipelineEngine — review at last step (BUG 1)", () => {
  it("completes when review is the last step and then resumed", async () => {
    const definition = createTestDefinition({
      id: "review-last",
      steps: [
        { type: "sequential", skill: "content-strategy" },
        { type: "review", reviewer: "director" },
      ],
    });
    const run = createTestRun({ pipelineId: definition.id });

    // First execution pauses at review
    const pausedResult = await engine.execute(
      definition,
      run,
      defaultConfig(),
    );
    expect(pausedResult.status).toBe("paused");
    expect(run.currentStepIndex).toBe(1);

    // Resume: advances past the review step (index 2), loop doesn't execute
    const resumedResult = await engine.execute(
      definition,
      run,
      defaultConfig({ initialInputPaths: pausedResult.stepResults[0]!.outputPaths }),
    );

    expect(resumedResult.status).toBe("completed");
    expect(resumedResult.stepResults).toHaveLength(0); // no steps after review
    expect(run.status).toBe("completed");
    expect(run.completedAt).not.toBeNull();
  });
});

// ── Parallel Concurrency Control ────────────────────────────────────────────

describe("SequentialPipelineEngine — concurrency control", () => {
  it("respects maxConcurrency limit for parallel steps", async () => {
    const tracker = createConcurrencyTrackingClient({ delayMs: 40 });
    executor = new AgentExecutor(
      tracker.client as any,
      tw.workspace,
      executorConfig,
    );
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createParallelStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({ maxConcurrency: 2 }),
    );

    expect(result.status).toBe("completed");
    // At most 2 API calls were in-flight simultaneously
    expect(tracker.getMaxConcurrent()).toBeLessThanOrEqual(2);
    // All 4 parallel tasks completed
    expect(result.stepResults[1]!.executionResults).toHaveLength(4);
  });

  it("maxConcurrency=1 executes tasks sequentially", async () => {
    const tracker = createConcurrencyTrackingClient({ delayMs: 10 });
    executor = new AgentExecutor(
      tracker.client as any,
      tw.workspace,
      executorConfig,
    );
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createParallelStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({ maxConcurrency: 1 }),
    );

    expect(result.status).toBe("completed");
    // Only 1 API call at a time
    expect(tracker.getMaxConcurrent()).toBe(1);
  });

  it("uses default concurrency (3) when maxConcurrency not specified", async () => {
    const tracker = createConcurrencyTrackingClient({ delayMs: 40 });
    executor = new AgentExecutor(
      tracker.client as any,
      tw.workspace,
      executorConfig,
    );
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createParallelStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    // No maxConcurrency → defaults to 3
    const result = await engine.execute(definition, run, defaultConfig());

    expect(result.status).toBe("completed");
    expect(tracker.getMaxConcurrent()).toBeLessThanOrEqual(3);
  });

  it("maxConcurrency > task count runs all tasks immediately", async () => {
    const definition = createTestDefinition({
      id: "small-parallel",
      steps: [
        {
          type: "parallel",
          skills: ["copywriting", "social-content"],
        },
      ],
    });
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({ maxConcurrency: 10 }),
    );

    expect(result.status).toBe("completed");
    expect(result.stepResults[0]!.executionResults).toHaveLength(2);
  });

  it("actively cancels in-flight parallel tasks on failure", async () => {
    const tracker = createConcurrencyTrackingClient({
      delayMs: 40,
      failOnSkill: "email-sequence" as any,
    });
    executor = new AgentExecutor(
      tracker.client as any,
      tw.workspace,
      executorConfig,
    );
    engine = new SequentialPipelineEngine(factory, executor, tw.workspace);

    const definition = createParallelStepDefinition();
    const run = createTestRun({ pipelineId: definition.id });

    const result = await engine.execute(
      definition,
      run,
      defaultConfig({ maxConcurrency: 4 }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("STEP_FAILED");
    // Not all 4 parallel tasks completed successfully
    const parallelStep = result.stepResults[1]!;
    expect(parallelStep.status).toBe("failed");
    // Fewer than 4 tasks completed successfully
    const completedCount = parallelStep.executionResults.filter(
      (r) => r.status === "completed",
    ).length;
    expect(completedCount).toBeLessThan(4);
  });
});
