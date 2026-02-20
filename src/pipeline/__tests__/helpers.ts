import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineDefinition, PipelineRun } from "../../types/pipeline.ts";
import type { SkillName } from "../../types/agent.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import { generateRunId } from "../../workspace/id.ts";
import type {
  ClaudeClient,
  ClaudeMessageParams,
  ClaudeMessageResult,
} from "../../agents/claude-client.ts";

// ── Test Workspace ──────────────────────────────────────────────────────────

export interface TestWorkspace {
  workspace: FileSystemWorkspaceManager;
  tempDir: string;
  cleanup: () => Promise<void>;
}

export async function createTestWorkspace(): Promise<TestWorkspace> {
  const tempDir = await mkdtemp(join(tmpdir(), "pipeline-test-"));
  const workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
  await workspace.init();
  // Write minimal product-marketing-context.md (required by PipelineFactory task inputs)
  await workspace.writeFile(
    "context/product-marketing-context.md",
    "# Product Context\n\nTest product for pipeline tests.\n",
  );
  return {
    workspace,
    tempDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

// ── Pipeline Definition Fixtures ────────────────────────────────────────────

export function createTestDefinition(
  overrides?: Partial<PipelineDefinition>,
): PipelineDefinition {
  return {
    id: "test-pipeline",
    name: "Test Pipeline",
    description: "A test pipeline for unit testing",
    steps: [
      { type: "sequential", skill: "content-strategy" as SkillName },
      { type: "sequential", skill: "copywriting" as SkillName },
      { type: "sequential", skill: "copy-editing" as SkillName },
    ],
    defaultPriority: "P2",
    trigger: { type: "manual" },
    ...overrides,
  };
}

export function createSingleStepDefinition(): PipelineDefinition {
  return createTestDefinition({
    id: "single-step-pipeline",
    name: "Single Step Pipeline",
    steps: [{ type: "sequential", skill: "content-strategy" as SkillName }],
  });
}

export function createParallelStepDefinition(): PipelineDefinition {
  return createTestDefinition({
    id: "parallel-pipeline",
    name: "Parallel Pipeline",
    steps: [
      { type: "sequential", skill: "launch-strategy" as SkillName },
      {
        type: "parallel",
        skills: [
          "copywriting" as SkillName,
          "email-sequence" as SkillName,
          "social-content" as SkillName,
          "paid-ads" as SkillName,
        ],
      },
    ],
  });
}

export function createReviewStepDefinition(): PipelineDefinition {
  return createTestDefinition({
    id: "review-pipeline",
    name: "Review Pipeline",
    steps: [
      { type: "sequential", skill: "content-strategy" as SkillName },
      { type: "sequential", skill: "copywriting" as SkillName },
      { type: "review", reviewer: "director" as const },
      { type: "sequential", skill: "copy-editing" as SkillName },
    ],
  });
}

// ── Concurrency Tracking Client ─────────────────────────────────────────────

export interface ConcurrencyTracker {
  client: ConcurrencyTrackingClaudeClient;
  getMaxConcurrent: () => number;
  getConcurrentNow: () => number;
}

/**
 * A ClaudeClient implementation that tracks concurrent call count.
 * Each call has an artificial delay so concurrent calls overlap,
 * enabling tests to verify concurrency limits.
 */
export class ConcurrencyTrackingClaudeClient implements ClaudeClient {
  readonly calls: ClaudeMessageParams[] = [];
  private concurrent = 0;
  private maxConcurrentSeen = 0;
  private readonly delayMs: number;
  private readonly failOnSkill: SkillName | undefined;

  constructor(options?: { delayMs?: number; failOnSkill?: SkillName }) {
    this.delayMs = options?.delayMs ?? 50;
    this.failOnSkill = options?.failOnSkill;
  }

  getMaxConcurrent(): number {
    return this.maxConcurrentSeen;
  }

  getConcurrentNow(): number {
    return this.concurrent;
  }

  async createMessage(params: ClaudeMessageParams): Promise<ClaudeMessageResult> {
    if (params.signal?.aborted) {
      throw new Error("Aborted");
    }

    this.concurrent++;
    this.maxConcurrentSeen = Math.max(this.maxConcurrentSeen, this.concurrent);

    try {
      // Simulate work with a cancellable delay
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        if (params.signal) {
          if (params.signal.aborted) {
            clearTimeout(timer);
            reject(new Error("Aborted"));
            return;
          }
          params.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("Aborted"));
            },
            { once: true },
          );
        }
      });

      this.calls.push(params);

      if (
        this.failOnSkill &&
        params.messages.some(
          (m) => typeof m.content === "string" && m.content.includes(this.failOnSkill!),
        )
      ) {
        throw new Error(`Simulated failure for skill: ${this.failOnSkill}`);
      }

      return {
        content: "Mock output for concurrent task",
        model: "claude-sonnet-4-5-20250929",
        inputTokens: 100,
        outputTokens: 200,
        stopReason: "end_turn",
        durationMs: this.delayMs,
      };
    } finally {
      this.concurrent--;
    }
  }
}

export function createConcurrencyTrackingClient(options?: {
  delayMs?: number;
  failOnSkill?: SkillName;
}): ConcurrencyTracker {
  const client = new ConcurrencyTrackingClaudeClient(options);
  return {
    client,
    getMaxConcurrent: () => client.getMaxConcurrent(),
    getConcurrentNow: () => client.getConcurrentNow(),
  };
}

// ── Pipeline Run Fixtures ───────────────────────────────────────────────────

export function createTestRun(
  overrides?: Partial<PipelineRun>,
): PipelineRun {
  return {
    id: generateRunId("test-pipeline"),
    pipelineId: "test-pipeline",
    goalId: "goal-test-001",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "pending",
    currentStepIndex: 0,
    taskIds: [],
    ...overrides,
  };
}
