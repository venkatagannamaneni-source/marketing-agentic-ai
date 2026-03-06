import type { Task } from "../types/task.ts";
import type {
  ConsistencyDimension,
  ConsistencyFinding,
  FindingSeverity,
} from "../types/review.ts";
import type { DirectorConfig } from "./types.ts";
import type { ClaudeClient } from "../agents/claude-client.ts";
import { MODEL_MAP, estimateCost } from "../agents/claude-client.ts";

// ── Consistency Result ──────────────────────────────────────────────────────

export interface ConsistencyResult {
  readonly pipelineId: string | null;
  readonly findings: readonly ConsistencyFinding[];
  readonly alignmentScore: number; // 0-10, 10 = perfectly consistent
  readonly tasksAnalyzed: readonly string[];
  readonly reviewCost: number;
  readonly checkedAt: string;
}

// ── Tone Markers ────────────────────────────────────────────────────────────

const FORMAL_MARKERS: readonly RegExp[] = [
  /\bfurthermore\b/i,
  /\bmoreover\b/i,
  /\bconsequently\b/i,
  /\bnevertheless\b/i,
  /\bherein\b/i,
  /\bwhereby\b/i,
  /\bnotwithstanding\b/i,
  /\bpertaining\b/i,
  /\butilize\b/i,
  /\bfacilitate\b/i,
  /\bsubsequently\b/i,
  /\baccordingly\b/i,
  /\bplease do not hesitate\b/i,
  /\bwe would like to inform\b/i,
  /\bkindly\b/i,
];

const CASUAL_MARKERS: readonly RegExp[] = [
  /\bhey\b/i,
  /\bawesome\b/i,
  /\bcool\b/i,
  /\bgonna\b/i,
  /\bwanna\b/i,
  /\bgotta\b/i,
  /\byeah\b/i,
  /\bnope\b/i,
  /\bsuper easy\b/i,
  /\bno biggie\b/i,
  /\blet's roll\b/i,
  /\bcheck it out\b/i,
  /\btotally\b/i,
  /\bbtw\b/i,
  /\bfyi\b/i,
  /!\s*$/m,
];

// ── CTA Patterns ────────────────────────────────────────────────────────────

const CTA_PATTERNS: readonly RegExp[] = [
  /\bsign up\b/i,
  /\bstart (?:your |a )?(?:free )?trial\b/i,
  /\bget started\b/i,
  /\bbook (?:a |your )?demo\b/i,
  /\btry (?:it )?(?:for )?free\b/i,
  /\bschedule (?:a |your )?call\b/i,
  /\blearn more\b/i,
  /\bdownload (?:now|free|today)\b/i,
  /\bbuy now\b/i,
  /\bsubscribe\b/i,
  /\bjoin (?:now|today|free|us)\b/i,
  /\brequest (?:a |your )?quote\b/i,
  /\bcontact (?:us|sales)\b/i,
  /\bclaim (?:your |a )?(?:free )?/i,
];

// ── Valid Severities ────────────────────────────────────────────────────────

const VALID_SEVERITIES: ReadonlySet<string> = new Set<string>([
  "critical",
  "major",
  "minor",
  "suggestion",
]);

const VALID_DIMENSIONS: ReadonlySet<string> = new Set<string>([
  "tone",
  "terminology",
  "messaging",
  "style",
]);

// ── Consistency Checker ─────────────────────────────────────────────────────

export class ConsistencyChecker {
  constructor(
    private readonly config: DirectorConfig,
    private readonly client?: ClaudeClient,
  ) {}

  /**
   * Structural consistency check — fast, no API call.
   * Checks tone, terminology, and CTA consistency across outputs.
   */
  checkStructural(outputs: Map<string, string>): readonly ConsistencyFinding[] {
    if (outputs.size <= 1) return [];

    const findings: ConsistencyFinding[] = [];

    findings.push(...this.checkToneConsistency(outputs));
    findings.push(...this.checkTerminologyConsistency(outputs));
    findings.push(...this.checkCTAConsistency(outputs));

    return findings;
  }

  /**
   * Semantic consistency check — uses Claude to analyze cross-output consistency.
   * Returns structured findings with cost tracking.
   */
  async checkSemantic(
    outputs: Map<string, string>,
    goalDescription: string,
  ): Promise<{ findings: readonly ConsistencyFinding[]; cost: number }> {
    if (!this.client || outputs.size <= 1) {
      return { findings: [], cost: 0 };
    }

    const systemPrompt = `You are the Marketing Director reviewing multiple agent outputs for cross-output consistency.

These outputs were all produced as part of a single marketing goal. They must be consistent with each other in:
1. **Messaging**: Core value proposition, key claims, and positioning must align
2. **Tone**: All outputs should use a consistent voice (formal/casual/professional)
3. **Terminology**: Product names, feature names, and technical terms must be spelled and used consistently
4. **Style**: Formatting conventions, capitalization patterns, and structural approaches should be cohesive

Respond with ONLY a JSON array of findings. Each finding must have:
- "dimension": one of "tone", "terminology", "messaging", "style"
- "severity": one of "critical", "major", "minor", "suggestion"
- "description": a specific description of the inconsistency
- "affectedOutputs": array of output identifiers that have the inconsistency

If all outputs are perfectly consistent, respond with an empty array: []

Example response:
[{"dimension":"messaging","severity":"major","description":"Landing page claims '99.9% uptime' while email says '99.99% uptime'","affectedOutputs":["page-cro","email-sequence"]}]`;

    const outputSections = Array.from(outputs.entries())
      .map(([name, content]) => `=== Output: ${name} ===\n${content}`)
      .join("\n\n");

    const userMessage = `Goal: ${goalDescription}

Outputs to check for consistency:

${outputSections}`;

    try {
      const result = await this.client.createMessage({
        model: MODEL_MAP.sonnet,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        maxTokens: 4096,
        timeoutMs: 60_000,
      });

      const cost = estimateCost(
        "sonnet",
        result.inputTokens,
        result.outputTokens,
      );

      const findings = this.parseSemanticFindings(result.content);
      return { findings, cost };
    } catch {
      // Graceful degradation — return empty findings with zero cost
      return { findings: [], cost: 0 };
    }
  }

  /**
   * Pipeline consistency check — orchestrates structural + semantic checks.
   * Runs structural first, then semantic if ClaudeClient is available
   * and no critical structural issues found.
   */
  async checkPipelineConsistency(
    tasks: Task[],
    outputContents: Map<string, string>,
    goalDescription: string,
  ): Promise<ConsistencyResult> {
    const pipelineId = tasks.length > 0 ? (tasks[0]!.pipelineId ?? null) : null;
    const tasksAnalyzed = tasks.map((t) => t.id);
    const checkedAt = new Date().toISOString();

    // 1. Run structural checks
    const structuralFindings = this.checkStructural(outputContents);

    // 2. Determine if we should run semantic checks
    const hasCriticalStructural = structuralFindings.some(
      (f) => f.severity === "critical",
    );

    let semanticFindings: readonly ConsistencyFinding[] = [];
    let reviewCost = 0;

    if (this.client && !hasCriticalStructural) {
      const result = await this.checkSemantic(outputContents, goalDescription);
      semanticFindings = result.findings;
      reviewCost = result.cost;
    }

    // 3. Merge findings (deduplicate by dimension + description)
    const allFindings = this.mergeFindings(structuralFindings, semanticFindings);

    // 4. Calculate alignment score
    const alignmentScore = this.calculateAlignmentScore(allFindings);

    return {
      pipelineId,
      findings: allFindings,
      alignmentScore,
      tasksAnalyzed,
      reviewCost,
      checkedAt,
    };
  }

  // ── Private: Tone Consistency ───────────────────────────────────────────────

  private checkToneConsistency(
    outputs: Map<string, string>,
  ): ConsistencyFinding[] {
    const findings: ConsistencyFinding[] = [];
    const toneScores = new Map<string, { formal: number; casual: number }>();

    for (const [name, content] of outputs) {
      let formal = 0;
      let casual = 0;

      for (const marker of FORMAL_MARKERS) {
        const matches = content.match(new RegExp(marker.source, "gi"));
        if (matches) formal += matches.length;
      }

      for (const marker of CASUAL_MARKERS) {
        const matches = content.match(new RegExp(marker.source, "gi"));
        if (matches) casual += matches.length;
      }

      toneScores.set(name, { formal, casual });
    }

    // Classify each output as formal, casual, or neutral
    const classifications = new Map<string, "formal" | "casual" | "neutral">();
    for (const [name, scores] of toneScores) {
      if (scores.formal > 0 && scores.casual === 0) {
        classifications.set(name, "formal");
      } else if (scores.casual > 0 && scores.formal === 0) {
        classifications.set(name, "casual");
      } else if (scores.formal > scores.casual * 2) {
        classifications.set(name, "formal");
      } else if (scores.casual > scores.formal * 2) {
        classifications.set(name, "casual");
      } else {
        classifications.set(name, "neutral");
      }
    }

    // Check for mixed tones (some formal, some casual)
    const toneGroups = new Map<string, string[]>();
    for (const [name, tone] of classifications) {
      if (!toneGroups.has(tone)) toneGroups.set(tone, []);
      toneGroups.get(tone)!.push(name);
    }

    const hasFormal = toneGroups.has("formal") && toneGroups.get("formal")!.length > 0;
    const hasCasual = toneGroups.has("casual") && toneGroups.get("casual")!.length > 0;

    if (hasFormal && hasCasual) {
      const formalOutputs = toneGroups.get("formal")!;
      const casualOutputs = toneGroups.get("casual")!;

      findings.push({
        dimension: "tone",
        severity: "major",
        description: `Tone mismatch detected: ${formalOutputs.join(", ")} use${formalOutputs.length === 1 ? "s" : ""} formal tone while ${casualOutputs.join(", ")} use${casualOutputs.length === 1 ? "s" : ""} casual tone`,
        affectedOutputs: [...formalOutputs, ...casualOutputs],
      });
    }

    return findings;
  }

  // ── Private: Terminology Consistency ────────────────────────────────────────

  private checkTerminologyConsistency(
    outputs: Map<string, string>,
  ): ConsistencyFinding[] {
    const findings: ConsistencyFinding[] = [];

    // Extract capitalized terms (likely product/feature names) from each output
    const termsByOutput = new Map<string, Set<string>>();

    for (const [name, content] of outputs) {
      const terms = this.extractCapitalizedTerms(content);
      termsByOutput.set(name, terms);
    }

    // Find terms that appear in multiple outputs with different casing/spelling
    const allTermsLower = new Map<string, Map<string, string[]>>(); // lowercase → {variant → [outputs]}

    for (const [outputName, terms] of termsByOutput) {
      for (const term of terms) {
        const lower = term.toLowerCase();
        if (!allTermsLower.has(lower)) allTermsLower.set(lower, new Map());
        const variants = allTermsLower.get(lower)!;
        if (!variants.has(term)) variants.set(term, []);
        variants.get(term)!.push(outputName);
      }
    }

    // Report terms with multiple spelling variants across outputs
    for (const [_lowerTerm, variants] of allTermsLower) {
      if (variants.size > 1) {
        const variantList = Array.from(variants.keys());
        const affectedOutputs = new Set<string>();
        for (const outputs of variants.values()) {
          for (const o of outputs) affectedOutputs.add(o);
        }

        // Only flag if variants appear in different outputs
        const outputSets = Array.from(variants.values());
        const allSameOutput = outputSets.every(
          (os) =>
            os.length === 1 &&
            outputSets.every((other) => other[0] === os[0]),
        );
        if (allSameOutput) continue;

        findings.push({
          dimension: "terminology",
          severity: "minor",
          description: `Inconsistent terminology: "${variantList.join('", "')}" used across outputs`,
          affectedOutputs: Array.from(affectedOutputs),
        });
      }
    }

    return findings;
  }

  // ── Private: CTA Consistency ────────────────────────────────────────────────

  private checkCTAConsistency(
    outputs: Map<string, string>,
  ): ConsistencyFinding[] {
    const findings: ConsistencyFinding[] = [];
    const ctasByOutput = new Map<string, string[]>();

    for (const [name, content] of outputs) {
      const ctas: string[] = [];
      for (const pattern of CTA_PATTERNS) {
        const matches = content.match(new RegExp(pattern.source, "gi"));
        if (matches) {
          for (const match of matches) {
            ctas.push(match.toLowerCase().trim());
          }
        }
      }
      if (ctas.length > 0) {
        ctasByOutput.set(name, ctas);
      }
    }

    // Check for contradictory CTAs across outputs
    if (ctasByOutput.size >= 2) {
      const allCTAs = new Map<string, string[]>(); // normalized CTA → [outputs]
      for (const [outputName, ctas] of ctasByOutput) {
        for (const cta of ctas) {
          if (!allCTAs.has(cta)) allCTAs.set(cta, []);
          allCTAs.get(cta)!.push(outputName);
        }
      }

      // Check for conflicting CTAs (e.g., "sign up free" vs "start your trial")
      const ctaCategories = this.categorizeCTAs(allCTAs);
      if (ctaCategories.size > 1) {
        const affectedOutputs = new Set<string>();
        const ctaDescriptions: string[] = [];
        for (const [category, entries] of ctaCategories) {
          for (const { outputs: ctaOutputs } of entries) {
            for (const o of ctaOutputs) affectedOutputs.add(o);
          }
          ctaDescriptions.push(
            `${entries.map((e) => `"${e.cta}"`).join(", ")} (${category})`,
          );
        }

        findings.push({
          dimension: "messaging",
          severity: "major",
          description: `Contradictory CTAs detected: ${ctaDescriptions.join(" vs ")}`,
          affectedOutputs: Array.from(affectedOutputs),
        });
      }
    }

    return findings;
  }

  // ── Private: Helpers ────────────────────────────────────────────────────────

  private extractCapitalizedTerms(content: string): Set<string> {
    const terms = new Set<string>();
    // Match multi-word capitalized terms (e.g., "Marketing Pro", "Content Suite")
    const multiWordPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    let match: RegExpExecArray | null;

    while ((match = multiWordPattern.exec(content)) !== null) {
      terms.add(match[1]!);
    }

    // Also match single capitalized words that appear mid-sentence (likely product names)
    // Skip words at start of sentences
    const singleWordPattern = /(?<=[.!?]\s+\w+\s+|,\s+)([A-Z][a-z]{2,})\b/g;
    while ((match = singleWordPattern.exec(content)) !== null) {
      terms.add(match[1]!);
    }

    return terms;
  }

  private categorizeCTAs(
    allCTAs: Map<string, string[]>,
  ): Map<string, { cta: string; outputs: string[] }[]> {
    const categories = new Map<string, { cta: string; outputs: string[] }[]>();

    for (const [cta, outputs] of allCTAs) {
      let category: string;
      if (/sign up/i.test(cta)) category = "signup";
      else if (/trial/i.test(cta)) category = "trial";
      else if (/demo/i.test(cta)) category = "demo";
      else if (/buy|purchase/i.test(cta)) category = "purchase";
      else if (/download/i.test(cta)) category = "download";
      else if (/subscribe/i.test(cta)) category = "subscribe";
      else if (/contact/i.test(cta)) category = "contact";
      else if (/learn more/i.test(cta)) category = "learn-more";
      else category = "other";

      if (!categories.has(category)) categories.set(category, []);
      categories.get(category)!.push({ cta, outputs });
    }

    return categories;
  }

  private parseSemanticFindings(content: string): ConsistencyFinding[] {
    try {
      let jsonStr = content.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1]!.trim();
      }

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [];

      const findings: ConsistencyFinding[] = [];
      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          typeof item.dimension === "string" &&
          typeof item.severity === "string" &&
          typeof item.description === "string" &&
          Array.isArray(item.affectedOutputs) &&
          VALID_DIMENSIONS.has(item.dimension) &&
          VALID_SEVERITIES.has(item.severity)
        ) {
          findings.push({
            dimension: item.dimension as ConsistencyDimension,
            severity: item.severity as FindingSeverity,
            description: item.description,
            affectedOutputs: item.affectedOutputs.filter(
              (o: unknown) => typeof o === "string",
            ),
          });
        }
      }
      return findings;
    } catch {
      // Graceful degradation
      return [];
    }
  }

  private mergeFindings(
    structural: readonly ConsistencyFinding[],
    semantic: readonly ConsistencyFinding[],
  ): ConsistencyFinding[] {
    const seen = new Set<string>();
    const merged: ConsistencyFinding[] = [];

    for (const f of structural) {
      const key = `${f.dimension}::${f.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(f);
      }
    }

    for (const f of semantic) {
      const key = `${f.dimension}::${f.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(f);
      }
    }

    return merged;
  }

  private calculateAlignmentScore(
    findings: readonly ConsistencyFinding[],
  ): number {
    if (findings.length === 0) return 10;

    let deductions = 0;
    for (const f of findings) {
      switch (f.severity) {
        case "critical":
          deductions += 4;
          break;
        case "major":
          deductions += 2;
          break;
        case "minor":
          deductions += 1;
          break;
        case "suggestion":
          deductions += 0.5;
          break;
      }
    }

    return Math.max(0, Math.round((10 - deductions) * 10) / 10);
  }
}
