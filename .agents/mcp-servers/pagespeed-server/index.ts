#!/usr/bin/env bun
/**
 * PageSpeed Insights MCP Server — Google PageSpeed Insights API v5.
 *
 * Exposes tools: run-audit, get-core-web-vitals.
 * Receives API key via TOOL_API_KEY env var.
 *
 * Implements MCP stdio transport: JSON-RPC over stdin/stdout.
 */

import { createInterface } from "node:readline";

// ── Constants ──────────────────────────────────────────────────────────────

const PSI_API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

// ── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "run-audit",
    description:
      "Run a full Lighthouse audit on a URL (performance, accessibility, SEO, best practices)",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to audit" },
        strategy: {
          type: "string",
          description: "'mobile' or 'desktop' (default: mobile)",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description:
            "Categories: performance, accessibility, seo, best-practices, pwa",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "get-core-web-vitals",
    description:
      "Get Core Web Vitals field data (LCP, INP, CLS) from Chrome UX Report",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to check" },
        form_factor: {
          type: "string",
          description: "'PHONE', 'DESKTOP', or 'ALL' (default: ALL)",
        },
      },
      required: ["url"],
    },
  },
];

// ── API Helpers ─────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.TOOL_API_KEY;
  if (!key) throw new Error("TOOL_API_KEY not set");
  return key;
}

// ── Tool Handlers ──────────────────────────────────────────────────────────

async function runAudit(args: Record<string, unknown>): Promise<string> {
  const apiKey = getApiKey();
  const url = args.url as string;
  const strategy = (args.strategy as string) ?? "mobile";
  const categories = (args.categories as string[]) ?? [
    "performance",
    "accessibility",
    "seo",
    "best-practices",
  ];

  const params = new URLSearchParams({
    url,
    key: apiKey,
    strategy: strategy.toUpperCase() === "DESKTOP" ? "DESKTOP" : "MOBILE",
  });

  for (const cat of categories) {
    params.append("category", cat.toUpperCase().replace(/-/g, "_"));
  }

  const response = await fetch(`${PSI_API}?${params.toString()}`);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `PageSpeed API error ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as {
    lighthouseResult?: {
      categories?: Record<
        string,
        { id: string; title: string; score: number }
      >;
      audits?: Record<
        string,
        {
          id: string;
          title: string;
          score: number | null;
          displayValue?: string;
        }
      >;
    };
    loadingExperience?: Record<string, unknown>;
  };

  // Extract summary scores and key audits
  const summary: Record<string, unknown> = { url, strategy };

  if (data.lighthouseResult?.categories) {
    summary.scores = Object.fromEntries(
      Object.entries(data.lighthouseResult.categories).map(([key, cat]) => [
        key,
        { title: cat.title, score: Math.round(cat.score * 100) },
      ]),
    );
  }

  // Include key performance audits
  if (data.lighthouseResult?.audits) {
    const keyAudits = [
      "first-contentful-paint",
      "largest-contentful-paint",
      "total-blocking-time",
      "cumulative-layout-shift",
      "speed-index",
      "interactive",
    ];

    summary.keyAudits = Object.fromEntries(
      keyAudits
        .filter((id) => data.lighthouseResult!.audits![id])
        .map((id) => {
          const audit = data.lighthouseResult!.audits![id];
          return [
            id,
            {
              title: audit.title,
              score: audit.score,
              displayValue: audit.displayValue,
            },
          ];
        }),
    );
  }

  if (data.loadingExperience) {
    summary.fieldData = data.loadingExperience;
  }

  return JSON.stringify(summary, null, 2);
}

async function getCoreWebVitals(
  args: Record<string, unknown>,
): Promise<string> {
  const apiKey = getApiKey();
  const url = args.url as string;
  const formFactor = (args.form_factor as string) ?? "ALL";

  // Use CrUX API directly for field data
  const cruxUrl = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

  const body: Record<string, unknown> = {
    url,
    formFactor: formFactor.toUpperCase(),
  };

  const response = await fetch(`${cruxUrl}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Fall back to PSI API for CWV data
    const params = new URLSearchParams({
      url,
      key: apiKey,
      category: "PERFORMANCE",
      strategy:
        formFactor.toUpperCase() === "PHONE" ? "MOBILE" : "DESKTOP",
    });

    const psiResponse = await fetch(`${PSI_API}?${params.toString()}`);
    if (!psiResponse.ok) {
      const errorBody = await psiResponse.text();
      throw new Error(
        `PageSpeed API error ${psiResponse.status}: ${errorBody.slice(0, 500)}`,
      );
    }

    const psiData = (await psiResponse.json()) as {
      loadingExperience?: {
        metrics?: Record<
          string,
          { percentile: number; category: string }
        >;
        overall_category?: string;
      };
    };

    const metrics = psiData.loadingExperience?.metrics ?? {};
    return JSON.stringify(
      {
        url,
        formFactor,
        source: "pagespeed-insights",
        overallCategory: psiData.loadingExperience?.overall_category,
        metrics: {
          LCP: metrics.LARGEST_CONTENTFUL_PAINT_MS,
          INP: metrics.INTERACTION_TO_NEXT_PAINT,
          CLS: metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE,
          FCP: metrics.FIRST_CONTENTFUL_PAINT_MS,
          TTFB: metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE,
        },
      },
      null,
      2,
    );
  }

  const cruxData = await response.json();
  return JSON.stringify(
    { url, formFactor, source: "crux", ...cruxData },
    null,
    2,
  );
}

// ── MCP Protocol Handler ───────────────────────────────────────────────────

async function handleRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pagespeed-server", version: "1.0.0" },
      };

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const toolName = params.name as string;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

      try {
        let text: string;
        switch (toolName) {
          case "run-audit":
            text = await runAudit(toolArgs);
            break;
          case "get-core-web-vitals":
            text = await getCoreWebVitals(toolArgs);
            break;
          default:
            return {
              content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
              isError: true,
            };
        }
        return { content: [{ type: "text", text }] };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      return undefined;
  }
}

// ── Stdio Transport ────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line: string) => {
  if (!line.trim()) return;

  try {
    const msg = JSON.parse(line) as {
      jsonrpc: string;
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };

    if (msg.id === undefined) return;

    const result = await handleRequest(msg.method, msg.params ?? {});
    if (result !== undefined) {
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result,
      });
      process.stdout.write(response + "\n");
    }
  } catch (err: unknown) {
    console.error(
      `MCP server error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});
