import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task } from "../../types/task.ts";
import type { Review } from "../../types/review.ts";
import type { Goal, BudgetState, DirectorConfig } from "../types.ts";
import { DEFAULT_DIRECTOR_CONFIG } from "../types.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import type {
  ClaudeClient,
  ClaudeMessageParams,
  ClaudeMessageResult,
} from "../../agents/claude-client.ts";
import { MODEL_MAP } from "../../agents/claude-client.ts";

// ── Test Workspace ───────────────────────────────────────────────────────────

export interface TestWorkspace {
  workspace: FileSystemWorkspaceManager;
  tempDir: string;
  cleanup: () => Promise<void>;
}

export async function createTestWorkspace(): Promise<TestWorkspace> {
  const tempDir = await mkdtemp(join(tmpdir(), "director-test-"));
  const workspace = new FileSystemWorkspaceManager({ rootDir: tempDir });
  await workspace.init();
  return {
    workspace,
    tempDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

// ── Test Fixtures ────────────────────────────────────────────────────────────

export function createTestGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-20260219-abc123",
    description: "Increase signup conversion rate by 20%",
    category: "optimization",
    priority: "P1",
    createdAt: "2026-02-19T00:00:00.000Z",
    deadline: null,
    metadata: {},
    ...overrides,
  };
}

export function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "page-cro-20260219-abc123",
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:00.000Z",
    from: "director",
    to: "page-cro",
    priority: "P1",
    deadline: null,
    status: "completed",
    revisionCount: 0,
    goalId: "goal-20260219-abc123",
    pipelineId: null,
    goal: "Increase signup conversion rate by 20%",
    inputs: [
      {
        path: "context/product-marketing-context.md",
        description: "Product context",
      },
    ],
    requirements: "Audit the signup page for conversion issues",
    output: {
      path: "outputs/convert/page-cro/page-cro-20260219-abc123.md",
      format: "Markdown per SKILL.md specification",
    },
    next: { type: "director_review" },
    tags: ["page-cro"],
    metadata: {},
    ...overrides,
  };
}

export function createTestReview(overrides: Partial<Review> = {}): Review {
  return {
    id: "review-page-cro-20260219-abc123-0",
    taskId: "page-cro-20260219-abc123",
    createdAt: "2026-02-19T00:00:00.000Z",
    reviewer: "director",
    author: "page-cro",
    verdict: "APPROVE",
    findings: [],
    revisionRequests: [],
    summary: "Output meets structural requirements.",
    ...overrides,
  };
}

export function createTestBudgetState(
  overrides: Partial<BudgetState> = {},
): BudgetState {
  return {
    totalBudget: 1000,
    spent: 0,
    percentUsed: 0,
    level: "normal",
    allowedPriorities: ["P0", "P1", "P2", "P3"],
    modelOverride: null,
    ...overrides,
  };
}

export function createTestConfig(
  overrides: Partial<DirectorConfig> = {},
): DirectorConfig {
  return {
    ...DEFAULT_DIRECTOR_CONFIG,
    ...overrides,
  };
}

/**
 * Minimal valid output content that passes structural validation.
 */
export function createTestOutput(): string {
  return `# Page CRO Audit

## Executive Summary

This audit evaluates the signup page for conversion optimization opportunities.
We identified several key areas for improvement based on CRO best practices.

## Findings

### Above the Fold
- Headline clarity: The current headline does not communicate the core value proposition
- CTA button: Low contrast, positioned below the fold on mobile

### Form Analysis
- Too many required fields (7 fields; best practice is 3-5)
- No inline validation feedback
- Missing progress indicator

## Recommendations

1. Simplify the form to 3 essential fields (name, email, password)
2. Move CTA above the fold with high-contrast design
3. Add inline validation and progress indicators
4. Implement social proof near the CTA

## Expected Impact

Estimated conversion lift: 15-25% based on similar optimizations.
`;
}

// ── Mock Claude Client (EC-8) ───────────────────────────────────────────────

/**
 * Create a mock ClaudeClient for testing. Supports:
 * - Static response (all calls return the same result)
 * - Dynamic/sequence-based responses via callback (different per call)
 * - Records all calls for assertion
 */
export function createMockClaudeClient(
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
    content: createTestOutput(),
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
