import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineDefinition, PipelineRun } from "../../types/pipeline.ts";
import type { SkillName } from "../../types/agent.ts";
import { FileSystemWorkspaceManager } from "../../workspace/workspace-manager.ts";
import { generateRunId } from "../../workspace/id.ts";

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
