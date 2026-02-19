import { describe, expect, it } from "bun:test";
import { ReviewEngine } from "../review-engine.ts";
import type { SemanticReviewResult } from "../review-engine.ts";
import { DEFAULT_DIRECTOR_CONFIG } from "../types.ts";
import { createTestTask, createTestOutput } from "./helpers.ts";
import type {
  ClaudeClient,
  ClaudeMessageParams,
  ClaudeMessageResult,
} from "../../agents/claude-client.ts";
import { MODEL_MAP } from "../../agents/claude-client.ts";

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
    content: "[]",
    model: MODEL_MAP.opus,
    inputTokens: 5000,
    outputTokens: 500,
    stopReason: "end_turn",
    durationMs: 3000,
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ReviewEngine — semantic review", () => {
  describe("evaluateTaskSemantic", () => {
    it("calls Opus with correct prompt structure", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      await engine.evaluateTaskSemantic(task, output, []);

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.model).toBe(MODEL_MAP.opus);
      expect(client.calls[0]!.system).toContain("Marketing Director");
      expect(client.calls[0]!.system).toContain("Completeness");
      expect(client.calls[0]!.messages[0]!.content).toContain(task.to);
      expect(client.calls[0]!.messages[0]!.content).toContain(
        task.requirements,
      );
    });

    it("short-circuits Opus call on critical structural failure", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask();

      // Empty output → critical structural finding → no Opus call
      const result = await engine.evaluateTaskSemantic(task, "", []);

      expect(client.calls.length).toBe(0);
      expect(result.decision.review!.verdict).toBe("REJECT");
      expect(result.reviewCost).toBe(0);
    });

    it("parses semantic findings from JSON response", async () => {
      const client = createMockClient({
        content: JSON.stringify([
          {
            section: "recommendations",
            severity: "minor",
            description: "Lacks specific metrics",
          },
        ]),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      // Should have the semantic finding included
      const findings = result.decision.review!.findings;
      const semanticFinding = findings.find(
        (f) => f.description === "Lacks specific metrics",
      );
      expect(semanticFinding).toBeDefined();
      expect(semanticFinding!.section).toBe("recommendations");
      expect(semanticFinding!.severity).toBe("minor");
    });

    it("degrades gracefully on malformed Opus response", async () => {
      const client = createMockClient({
        content: "This is prose, not JSON. The output looks good overall.",
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      // Should NOT throw
      const result = await engine.evaluateTaskSemantic(task, output, []);

      // Should fall back to structural-only (no semantic findings)
      expect(result.decision.review!.verdict).toBe("APPROVE");
    });

    it("discards findings with unknown severity", async () => {
      const client = createMockClient({
        content: JSON.stringify([
          {
            section: "content",
            severity: "catastrophic",
            description: "This has an invalid severity",
          },
          {
            section: "format",
            severity: "minor",
            description: "Valid finding",
          },
        ]),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      const findings = result.decision.review!.findings;
      // Should have the valid "minor" finding but NOT the "catastrophic" one
      expect(findings.some((f) => f.description === "Valid finding")).toBe(true);
      expect(
        findings.some((f) =>
          f.description.includes("invalid severity"),
        ),
      ).toBe(false);
    });

    it("merges structural + semantic findings with deduplication", async () => {
      // Return a finding that overlaps with structural validation
      const client = createMockClient({
        content: JSON.stringify([
          {
            section: "recommendations",
            severity: "major",
            description: "Lacks supporting data for claims",
          },
        ]),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      // Should have the semantic "major" finding merged in
      const findings = result.decision.review!.findings;
      expect(
        findings.some((f) => f.description === "Lacks supporting data for claims"),
      ).toBe(true);
    });

    it("returns correct verdict from merged findings", async () => {
      // Return a major semantic finding → should cause REVISE
      const client = createMockClient({
        content: JSON.stringify([
          {
            section: "content",
            severity: "major",
            description: "Missing competitive analysis section",
          },
        ]),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      expect(result.decision.review!.verdict).toBe("REVISE");
      expect(result.decision.action).toBe("revise");
      expect(result.decision.nextTasks.length).toBe(1);
    });

    it("falls back to structural-only when no client provided", async () => {
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG); // No client
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      // Should work like structural-only
      expect(result.decision.review!.verdict).toBe("APPROVE");
      expect(result.reviewCost).toBe(0);
    });

    it("returns reviewCost from Opus call (EC-4)", async () => {
      const client = createMockClient({
        content: "[]",
        inputTokens: 10000,
        outputTokens: 500,
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      // opus: (10000 * 15 + 500 * 75) / 1_000_000 = 0.1875
      expect(result.reviewCost).toBeCloseTo(0.1875, 4);
    });

    it("degrades gracefully on API error", async () => {
      const client: ClaudeClient & { calls: ClaudeMessageParams[] } = {
        calls: [],
        createMessage: async () => {
          throw new Error("API connection failed");
        },
      };
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      // Should NOT throw — degrades to structural-only
      const result = await engine.evaluateTaskSemantic(task, output, []);

      expect(result.decision.review!.verdict).toBe("APPROVE");
      expect(result.reviewCost).toBe(0);
    });

    it("handles JSON wrapped in markdown code blocks", async () => {
      const client = createMockClient({
        content:
          '```json\n[{"section":"tone","severity":"suggestion","description":"Consider more casual tone"}]\n```',
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      const findings = result.decision.review!.findings;
      expect(
        findings.some(
          (f) => f.description === "Consider more casual tone",
        ),
      ).toBe(true);
    });

    it("handles empty JSON array response (no issues found)", async () => {
      const client = createMockClient({ content: "[]" });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      expect(result.decision.review!.verdict).toBe("APPROVE");
      expect(result.decision.action).toBe("goal_complete");
    });

    it("critical semantic finding causes REJECT verdict", async () => {
      const client = createMockClient({
        content: JSON.stringify([
          {
            section: "entire output",
            severity: "critical",
            description: "Output is entirely off-topic",
          },
        ]),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask();
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(task, output, []);

      expect(result.decision.review!.verdict).toBe("REJECT");
      expect(result.decision.action).toBe("reject_reassign");
    });
  });
});
