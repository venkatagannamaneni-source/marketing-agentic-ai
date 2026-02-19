/**
 * E2E Test Helpers — Bootstrap function wiring all 7 modules.
 *
 * Solves the core challenge: MarketingDirector uses ClaudeClient.createMessage()
 * (from src/agents/claude-client.ts), while SequentialPipelineEngine and
 * TaskQueueManager use ClaudeClient.complete() (from src/executor/types.ts).
 * bootstrapE2E() creates both mock clients and wires everything together.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ── Workspace ─────────────────────────────────────────────────────────────────
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";

// ── Director (uses agents/claude-client.ts interface) ─────────────────────────
import { MarketingDirector } from "../../director/director.ts";
import { PipelineFactory } from "../../director/pipeline-factory.ts";
import type { BudgetState } from "../../director/types.ts";
import type { ExecutorConfig as DirectorExecutorConfig } from "../../agents/executor.ts";
import type {
  ClaudeClient as DirectorClaudeClient,
  ClaudeMessageParams,
  ClaudeMessageResult,
} from "../../agents/claude-client.ts";
import { MODEL_MAP } from "../../agents/claude-client.ts";

// ── Pipeline Engine (uses executor/types.ts interface) ────────────────────────
import { SequentialPipelineEngine } from "../../pipeline/pipeline-engine.ts";
import { AgentExecutor as PipelineAgentExecutor } from "../../executor/agent-executor.ts";
import { MockClaudeClient as PipelineMockClaudeClient } from "../../executor/claude-client.ts";
import { createDefaultConfig } from "../../executor/types.ts";
import type { ClaudeRequest, ClaudeResponse } from "../../executor/types.ts";

// ── Queue ─────────────────────────────────────────────────────────────────────
import { TaskQueueManager } from "../../queue/task-queue.ts";
import { CompletionRouter } from "../../queue/completion-router.ts";
import { FailureTracker } from "../../queue/failure-tracker.ts";
import { createRedisConnectionFromClient } from "../../queue/redis-connection.ts";
import { createWorkerProcessor } from "../../queue/worker.ts";
import type { WorkerProcessorDeps } from "../../queue/worker.ts";
import type { ProcessorFn } from "../../queue/types.ts";
import {
  MockQueueAdapter,
  MockWorkerAdapter,
  MockRedisClient,
} from "../../queue/__tests__/helpers.ts";

// ── Agents Registry ───────────────────────────────────────────────────────────
import { PIPELINE_TEMPLATES } from "../../agents/registry.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface E2EContext {
  // Workspace
  workspace: FileSystemWorkspaceManager;
  tempDir: string;

  // Director (uses agents/claude-client.ts interface)
  director: MarketingDirector;
  directorClient: DirectorClaudeClient & { calls: ClaudeMessageParams[] };

  // Pipeline engine (uses executor/types.ts interface)
  pipelineEngine: SequentialPipelineEngine;
  pipelineClient: PipelineMockClaudeClient;
  pipelineExecutor: PipelineAgentExecutor;
  pipelineFactory: PipelineFactory;

  // Queue
  queueManager: TaskQueueManager;
  completionRouter: CompletionRouter;
  failureTracker: FailureTracker;
  mockQueue: MockQueueAdapter;
  mockWorker: MockWorkerAdapter;
  mockRedis: MockRedisClient;

  // Worker processor (for manual queue simulation)
  createProcessor: () => ProcessorFn;

  // Budget (mutable via setBudget)
  getBudget: () => BudgetState;
  setBudget: (state: BudgetState) => void;

  // Cleanup
  cleanup: () => Promise<void>;
}

export interface BootstrapOptions {
  directorClientHandler?: (
    params: ClaudeMessageParams,
    callIndex: number,
  ) => Partial<ClaudeMessageResult>;
  pipelineClientGenerator?: (request: ClaudeRequest) => ClaudeResponse;
}

// ── Bootstrap Function ────────────────────────────────────────────────────────

export async function bootstrapE2E(
  options?: BootstrapOptions,
): Promise<E2EContext> {
  // 1. Create temp workspace
  const tempDir = await mkdtemp(join(tmpdir(), "e2e-test-"));
  const workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
  await workspace.init();

  // Write product-marketing-context.md (required by AgentExecutor for task inputs)
  await workspace.writeFile(
    "context/product-marketing-context.md",
    MOCK_PRODUCT_CONTEXT,
  );

  // 2. Create Director's mock ClaudeClient (agents/claude-client.ts interface)
  const directorClient = createDirectorMockClient(
    options?.directorClientHandler,
  );

  // 3. Director's ExecutorConfig (for executeAndReviewTask)
  const directorExecutorConfig: DirectorExecutorConfig = {
    projectRoot: PROJECT_ROOT,
    defaultModel: "sonnet",
    defaultTimeoutMs: 120_000,
    defaultMaxTokens: 8192,
    maxRetries: 0,
    maxContextTokens: 150_000,
  };

  // 4. Create MarketingDirector
  const director = new MarketingDirector(
    workspace,
    undefined,
    directorClient,
    directorExecutorConfig,
  );

  // 5. Create Pipeline's MockClaudeClient (executor/types.ts interface)
  const pipelineClient = new PipelineMockClaudeClient(
    options?.pipelineClientGenerator ?? defaultPipelineResponseGenerator,
  );

  // 6. Pipeline's ExecutorConfig + AgentExecutor
  const pipelineExecutorConfig = createDefaultConfig({
    projectRoot: PROJECT_ROOT,
    maxRetries: 0,
    retryDelayMs: 10,
    defaultTimeoutMs: 30_000,
  });
  const pipelineExecutor = new PipelineAgentExecutor(
    pipelineClient,
    workspace,
    pipelineExecutorConfig,
  );

  // 7. PipelineFactory + SequentialPipelineEngine
  const pipelineFactory = new PipelineFactory(PIPELINE_TEMPLATES);
  const pipelineEngine = new SequentialPipelineEngine(
    pipelineFactory,
    pipelineExecutor,
    workspace,
  );

  // 8. Queue mocks
  const mockQueue = new MockQueueAdapter();
  const mockWorker = new MockWorkerAdapter();
  const mockRedis = new MockRedisClient();
  const redis = createRedisConnectionFromClient(mockRedis);

  // 9. CompletionRouter + FailureTracker
  const completionRouter = new CompletionRouter(workspace, director);
  const failureTracker = new FailureTracker(3);

  // 10. Budget state (mutable via closure)
  let budgetState: BudgetState = {
    totalBudget: 1000,
    spent: 0,
    percentUsed: 0,
    level: "normal",
    allowedPriorities: ["P0", "P1", "P2", "P3"],
    modelOverride: null,
  };
  const getBudget = () => budgetState;
  const setBudget = (state: BudgetState) => {
    budgetState = state;
  };

  // 11. TaskQueueManager
  const queueManager = new TaskQueueManager({
    workspace,
    director,
    executor: pipelineExecutor,
    budgetProvider: getBudget,
    queue: mockQueue,
    worker: mockWorker,
    redis,
    config: {
      healthCheckIntervalMs: 60_000_000, // effectively disabled in tests
      fallbackDir: join(tempDir, "queue-fallback"),
    },
  });

  // 12. Worker processor factory (for manual queue simulation)
  const createProcessor = (): ProcessorFn => {
    const deps: WorkerProcessorDeps = {
      workspace,
      executor: pipelineExecutor,
      budgetProvider: getBudget,
      failureTracker,
      completionRouter,
    };
    return createWorkerProcessor(deps);
  };

  return {
    workspace,
    tempDir,
    director,
    directorClient,
    pipelineEngine,
    pipelineClient,
    pipelineExecutor,
    pipelineFactory,
    queueManager,
    completionRouter,
    failureTracker,
    mockQueue,
    mockWorker,
    mockRedis,
    createProcessor,
    getBudget,
    setBudget,
    cleanup: async () => {
      await queueManager.stop().catch(() => {});
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ── Mock Response Generators ──────────────────────────────────────────────────

/**
 * Generates valid markdown output that passes structural review.
 * Must have: >100 chars, 3+ non-empty lines, at least one markdown heading.
 */
export function generateMockOutput(skill: string, taskId: string): string {
  return `# ${skill} Output

## Summary

This is the output for task ${taskId}, generated by the ${skill} agent.
The analysis covers key findings and actionable recommendations.

## Findings

- Finding 1: Important insight about the target audience
- Finding 2: Competitive positioning opportunity identified
- Finding 3: Performance metrics indicate room for improvement

## Recommendations

1. Implement the primary recommendation with specific action items
2. Monitor key metrics and adjust strategy based on data
3. Coordinate with downstream agents for implementation

## Next Steps

The output is ready for review or handoff to the next pipeline step.
`;
}

function defaultPipelineResponseGenerator(
  request: ClaudeRequest,
): ClaudeResponse {
  // Extract skill name from user message if possible
  const skillMatch = request.userMessage.match(
    /\*\*Skill:\*\*\s+(\S+)/,
  );
  const taskMatch = request.userMessage.match(
    /\*\*Task ID:\*\*\s+(\S+)/,
  );
  const skill = skillMatch?.[1] ?? "agent";
  const taskId = taskMatch?.[1] ?? "unknown-task";

  return {
    content: generateMockOutput(skill, taskId),
    inputTokens: 500,
    outputTokens: 300,
    stopReason: "end_turn",
  };
}

function createDirectorMockClient(
  handler?: (
    params: ClaudeMessageParams,
    callIndex: number,
  ) => Partial<ClaudeMessageResult>,
): DirectorClaudeClient & { calls: ClaudeMessageParams[] } {
  const calls: ClaudeMessageParams[] = [];
  let callIndex = 0;

  const defaultResult: ClaudeMessageResult = {
    content: "[]", // Empty findings → APPROVE in semantic review
    model: MODEL_MAP.sonnet,
    inputTokens: 1000,
    outputTokens: 500,
    stopReason: "end_turn",
    durationMs: 2500,
  };

  return {
    calls,
    createMessage: async (
      params: ClaudeMessageParams,
    ): Promise<ClaudeMessageResult> => {
      calls.push(params);
      const idx = callIndex++;
      if (handler) {
        return { ...defaultResult, ...handler(params, idx) };
      }
      return defaultResult;
    },
  };
}

// ── Mock Product Context ──────────────────────────────────────────────────────

export const MOCK_PRODUCT_CONTEXT = `# Product Marketing Context

## Product
Test Product — A SaaS marketing automation tool for B2B teams.

## Audience
Marketing teams at B2B SaaS companies (50-500 employees).

## Positioning
The only AI-powered marketing orchestration platform that runs 24/7.

## Voice
Professional, data-driven, confident. Avoid jargon and buzzwords.

## Goals
- Increase signup conversion rate by 20%
- Grow organic traffic by 50%
- Reduce churn by 15%

## Competitors
- HubSpot Marketing Hub
- Marketo Engage
- Mailchimp

## Key Metrics
- MRR: $50K
- Monthly signups: 200
- Conversion rate: 3.2%
- Churn: 5.1%
`;
