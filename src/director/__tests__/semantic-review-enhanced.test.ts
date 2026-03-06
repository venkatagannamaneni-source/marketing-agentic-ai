import { describe, expect, it } from "bun:test";
import { ReviewEngine } from "../review-engine.ts";
import type { SemanticReviewConfig } from "../review-engine.ts";
import { DEFAULT_DIRECTOR_CONFIG } from "../types.ts";
import { createTestTask, createTestOutput, createTestBudgetState } from "./helpers.ts";
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
    content: JSON.stringify({
      verdict: "APPROVE",
      findings: [],
      revisionInstructions: "",
      summary: "Output meets all quality criteria.",
    }),
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

describe("ReviewEngine — enhanced semantic review", () => {
  describe("review depth control", () => {
    it("uses structural-only for quick depth", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "quick" },
      );

      // No API call should be made
      expect(client.calls.length).toBe(0);
      expect(result.reviewCost).toBe(0);
      expect(result.reviewDepth).toBe("quick");
      expect(result.decision.review!.verdict).toBe("APPROVE");
    });

    it("uses Sonnet for standard depth", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.model).toBe(MODEL_MAP.sonnet);
      expect(result.reviewDepth).toBe("standard");
    });

    it("uses Opus for deep depth", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "deep" },
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.model).toBe(MODEL_MAP.opus);
      expect(result.reviewDepth).toBe("deep");
    });

    it("budget modelOverride overrides depth-based model selection", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();
      const budgetState = createTestBudgetState({ modelOverride: "haiku" });

      const result = await engine.evaluateTaskSemantic(
        task, output, [], budgetState,
        { depth: "deep" },
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.model).toBe(MODEL_MAP.haiku);
      expect(result.reviewDepth).toBe("deep");
    });

    it("falls back to quick when no client is available", async () => {
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG); // No client
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "deep" },
      );

      expect(result.reviewCost).toBe(0);
      expect(result.reviewDepth).toBe("quick");
    });
  });

  describe("structured verdict from Claude", () => {
    it("uses Claude's APPROVE verdict directly", async () => {
      const client = createMockClient({
        content: JSON.stringify({
          verdict: "APPROVE",
          findings: [
            { section: "tone", severity: "suggestion", description: "Consider more casual tone" },
          ],
          revisionInstructions: "",
          summary: "Output is strong with minor tone suggestion.",
        }),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      // Claude said APPROVE even with a suggestion — that should be respected
      expect(result.decision.review!.verdict).toBe("APPROVE");
      expect(result.decision.review!.summary).toBe("Output is strong with minor tone suggestion.");
    });

    it("uses Claude's REVISE verdict with revision instructions", async () => {
      const client = createMockClient({
        content: JSON.stringify({
          verdict: "REVISE",
          findings: [
            { section: "recommendations", severity: "major", description: "Missing competitive analysis" },
          ],
          revisionInstructions: "Add a competitive analysis section comparing your approach to 2-3 alternatives. Include specific differentiators and pricing comparison.",
          summary: "Output lacks competitive context — needs revision.",
        }),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(result.decision.review!.verdict).toBe("REVISE");
      expect(result.decision.action).toBe("revise");
      expect(result.decision.nextTasks.length).toBe(1);

      // Revision task should include the semantic instructions
      const revisionTask = result.decision.nextTasks[0]!;
      expect(revisionTask.requirements).toContain("competitive analysis section");
      expect(revisionTask.requirements).toContain("Missing competitive analysis");
    });

    it("uses Claude's REJECT verdict", async () => {
      const client = createMockClient({
        content: JSON.stringify({
          verdict: "REJECT",
          findings: [
            { section: "entire output", severity: "critical", description: "Output is entirely off-topic — discusses social media instead of CRO" },
          ],
          revisionInstructions: "",
          summary: "Output is fundamentally off-topic.",
        }),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask();
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(result.decision.review!.verdict).toBe("REJECT");
      expect(result.decision.action).toBe("reject_reassign");
    });

    it("falls back to finding-based verdict when Claude provides invalid verdict", async () => {
      const client = createMockClient({
        content: JSON.stringify({
          verdict: "MAYBE",  // Invalid!
          findings: [
            { section: "content", severity: "major", description: "Lacks depth" },
          ],
          revisionInstructions: "Add more detail.",
          summary: "Needs work.",
        }),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      // Should fall back to finding-based: major finding → REVISE
      expect(result.decision.review!.verdict).toBe("REVISE");
    });
  });

  describe("backward compatibility with legacy array format", () => {
    it("handles legacy JSON array response", async () => {
      const client = createMockClient({
        content: JSON.stringify([
          { section: "recommendations", severity: "minor", description: "Lacks specific metrics" },
        ]),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      // Legacy format → verdict derived from findings (minor only → APPROVE)
      expect(result.decision.review!.verdict).toBe("APPROVE");
      const findings = result.decision.review!.findings;
      expect(findings.some((f) => f.description === "Lacks specific metrics")).toBe(true);
    });

    it("handles legacy array with major finding → REVISE", async () => {
      const client = createMockClient({
        content: JSON.stringify([
          { section: "content", severity: "major", description: "Missing competitive analysis" },
        ]),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(result.decision.review!.verdict).toBe("REVISE");
    });
  });

  describe("SKILL.md context loading", () => {
    it("includes SKILL.md content in prompt for deep review with projectRoot", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({
        to: "copywriting",
        next: { type: "director_review" },
      });
      const output = createTestOutput();

      // Use actual project root to load the copywriting SKILL.md
      const projectRoot = process.cwd();
      await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "deep", projectRoot },
      );

      expect(client.calls.length).toBe(1);
      // The system prompt should contain the SKILL.md content
      expect(client.calls[0]!.system).toContain("skill-definition");
      expect(client.calls[0]!.system).toContain("Copywriting");
    });

    it("degrades gracefully when SKILL.md not found", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({
        to: "nonexistent-skill",
        next: { type: "director_review" },
      });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "deep", projectRoot: process.cwd() },
      );

      // Should still work — just without skill context
      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.system).not.toContain("skill-definition");
      expect(result.decision.review!.verdict).toBe("APPROVE");
    });

    it("does not load SKILL.md for standard depth", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({
        to: "copywriting",
        next: { type: "director_review" },
      });
      const output = createTestOutput();

      await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard", projectRoot: process.cwd() },
      );

      expect(client.calls.length).toBe(1);
      // Standard depth should NOT include SKILL.md
      expect(client.calls[0]!.system).not.toContain("skill-definition");
    });
  });

  describe("revision context for re-reviews", () => {
    it("includes revision context in prompt for revision tasks", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({
        revisionCount: 1,
        next: { type: "director_review" },
      });
      const output = createTestOutput();

      await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.system).toContain("revision #1");
      expect(client.calls[0]!.system).toContain("revision feedback has been addressed");
    });

    it("does not include revision context for first-pass tasks", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({
        revisionCount: 0,
        next: { type: "director_review" },
      });
      const output = createTestOutput();

      await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.system).not.toContain("revision #");
    });
  });

  describe("enhanced prompt structure", () => {
    it("prompts for structured JSON verdict response", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      const systemPrompt = client.calls[0]!.system;
      // Should request structured response with verdict
      expect(systemPrompt).toContain('"verdict"');
      expect(systemPrompt).toContain('"findings"');
      expect(systemPrompt).toContain('"revisionInstructions"');
      expect(systemPrompt).toContain('"summary"');
      // Should include the specificity criterion (new)
      expect(systemPrompt).toContain("Specificity");
    });

    it("user message includes task skill and goal", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({
        to: "page-cro",
        goal: "Improve signup conversion",
        next: { type: "director_review" },
      });
      const output = createTestOutput();

      await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      const userMsg = client.calls[0]!.messages[0]!.content;
      expect(userMsg).toContain("page-cro");
      expect(userMsg).toContain("Improve signup conversion");
    });
  });

  describe("review summary from Claude", () => {
    it("uses Claude's summary in the review object", async () => {
      const client = createMockClient({
        content: JSON.stringify({
          verdict: "APPROVE",
          findings: [],
          revisionInstructions: "",
          summary: "Excellent CRO audit with actionable recommendations.",
        }),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(result.decision.review!.summary).toBe(
        "Excellent CRO audit with actionable recommendations.",
      );
    });

    it("falls back to default summary when Claude provides empty summary", async () => {
      const client = createMockClient({
        content: JSON.stringify({
          verdict: "APPROVE",
          findings: [],
          revisionInstructions: "",
          summary: "",
        }),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(result.decision.review!.summary).toBe(
        "Output meets structural and semantic requirements.",
      );
    });
  });

  describe("graceful degradation", () => {
    it("degrades on API error — returns structural-only result", async () => {
      const client: ClaudeClient & { calls: ClaudeMessageParams[] } = {
        calls: [],
        createMessage: async () => {
          throw new Error("API connection failed");
        },
      };
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "deep" },
      );

      // Should not throw — verdict from structural findings (APPROVE for good output)
      expect(result.decision.review!.verdict).toBe("APPROVE");
      expect(result.reviewCost).toBe(0);
    });

    it("handles JSON wrapped in markdown code blocks", async () => {
      const structuredResponse = JSON.stringify({
        verdict: "APPROVE",
        findings: [{ section: "tone", severity: "suggestion", description: "Could be more casual" }],
        revisionInstructions: "",
        summary: "Good output.",
      });
      const client = createMockClient({
        content: `\`\`\`json\n${structuredResponse}\n\`\`\``,
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(result.decision.review!.verdict).toBe("APPROVE");
      const findings = result.decision.review!.findings;
      expect(findings.some((f) => f.description === "Could be more casual")).toBe(true);
    });

    it("handles malformed prose response", async () => {
      const client = createMockClient({
        content: "The output looks great overall! I would approve this with flying colors.",
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      // Should degrade to APPROVE (no findings parsed → no critical/major)
      expect(result.decision.review!.verdict).toBe("APPROVE");
    });

    it("discards findings with unknown severity in structured response", async () => {
      const client = createMockClient({
        content: JSON.stringify({
          verdict: "REVISE",
          findings: [
            { section: "content", severity: "catastrophic", description: "Invalid severity" },
            { section: "format", severity: "major", description: "Valid major finding" },
          ],
          revisionInstructions: "Fix the format.",
          summary: "Needs format fixes.",
        }),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      const findings = result.decision.review!.findings;
      expect(findings.some((f) => f.description === "Valid major finding")).toBe(true);
      expect(findings.some((f) => f.description === "Invalid severity")).toBe(false);
      // Claude's REVISE verdict should still be used
      expect(result.decision.review!.verdict).toBe("REVISE");
    });
  });

  describe("maxResponseTokens config", () => {
    it("passes custom maxResponseTokens to Claude", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard", maxResponseTokens: 2048 },
      );

      expect(client.calls[0]!.maxTokens).toBe(2048);
    });

    it("uses default 4096 when maxResponseTokens not specified", async () => {
      const client = createMockClient();
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(client.calls[0]!.maxTokens).toBe(4096);
    });
  });

  describe("learning entries", () => {
    it("includes Claude's summary in learning actionTaken on approval", async () => {
      const client = createMockClient({
        content: JSON.stringify({
          verdict: "APPROVE",
          findings: [],
          revisionInstructions: "",
          summary: "Strong CRO analysis with data-backed recommendations.",
        }),
      });
      const engine = new ReviewEngine(DEFAULT_DIRECTOR_CONFIG, client);
      const task = createTestTask({ next: { type: "director_review" } });
      const output = createTestOutput();

      const result = await engine.evaluateTaskSemantic(
        task, output, [], undefined,
        { depth: "standard" },
      );

      expect(result.decision.learning).not.toBeNull();
      expect(result.decision.learning!.actionTaken).toBe(
        "Strong CRO analysis with data-backed recommendations.",
      );
    });
  });
});
