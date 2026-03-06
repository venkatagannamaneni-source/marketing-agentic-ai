import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QualityScore } from "../../types/quality.ts";
import { FileSystemWorkspaceManager } from "../workspace-manager.ts";

// ── Test Helpers ─────────────────────────────────────────────────────────────

let tempDir: string;
let ws: FileSystemWorkspaceManager;

function createTestScore(overrides: Partial<QualityScore> = {}): QualityScore {
  return {
    taskId: "page-cro-20260219-abc123",
    skill: "page-cro",
    dimensions: [
      { dimension: "completeness", score: 7.5, weight: 0.2, rationale: "Good coverage" },
      { dimension: "clarity", score: 8.0, weight: 0.15, rationale: "Well structured" },
      { dimension: "actionability", score: 6.5, weight: 0.25, rationale: "Needs specifics" },
    ],
    overallScore: 7.2,
    scoredAt: "2026-02-19T12:00:00.000Z",
    scoredBy: "structural",
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ws-quality-test-"));
  ws = new FileSystemWorkspaceManager({ rootDir: tempDir });
  await ws.init();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("WorkspaceManager — quality score operations", () => {
  it("writes and reads a quality score", async () => {
    const score = createTestScore();

    await ws.writeQualityScore(score);
    const read = await ws.readQualityScore(score.taskId);

    expect(read).not.toBeNull();
    expect(read!.taskId).toBe(score.taskId);
    expect(read!.skill).toBe("page-cro");
    expect(read!.overallScore).toBe(7.2);
    expect(read!.dimensions).toHaveLength(3);
    expect(read!.scoredBy).toBe("structural");
  });

  it("returns null for non-existent score", async () => {
    const result = await ws.readQualityScore("nonexistent-task");
    expect(result).toBeNull();
  });

  it("overwrites existing score for same task", async () => {
    const score1 = createTestScore({ overallScore: 5.0 });
    const score2 = createTestScore({ overallScore: 8.5, scoredBy: "semantic" });

    await ws.writeQualityScore(score1);
    await ws.writeQualityScore(score2);

    const read = await ws.readQualityScore(score1.taskId);
    expect(read!.overallScore).toBe(8.5);
    expect(read!.scoredBy).toBe("semantic");
  });

  it("lists all quality scores", async () => {
    const score1 = createTestScore({ taskId: "task-a" });
    const score2 = createTestScore({ taskId: "task-b", overallScore: 9.0 });

    await ws.writeQualityScore(score1);
    await ws.writeQualityScore(score2);

    const all = await ws.listQualityScores();
    expect(all).toHaveLength(2);

    const ids = all.map(s => s.taskId).sort();
    expect(ids).toEqual(["task-a", "task-b"]);
  });

  it("returns empty list when no scores exist", async () => {
    const all = await ws.listQualityScores();
    expect(all).toEqual([]);
  });

  it("preserves all dimension fields", async () => {
    const score = createTestScore();
    await ws.writeQualityScore(score);
    const read = await ws.readQualityScore(score.taskId);

    const actionability = read!.dimensions.find(d => d.dimension === "actionability");
    expect(actionability).toBeDefined();
    expect(actionability!.score).toBe(6.5);
    expect(actionability!.weight).toBe(0.25);
    expect(actionability!.rationale).toBe("Needs specifics");
  });

  it("stores scores in metrics/quality/ directory", async () => {
    const score = createTestScore();
    await ws.writeQualityScore(score);

    // Verify the path structure
    expect(ws.paths.qualityScores).toBe(`${tempDir}/metrics/quality`);
    expect(ws.paths.qualityScoreFile(score.taskId)).toBe(
      `${tempDir}/metrics/quality/${score.taskId}.json`,
    );
  });
});
