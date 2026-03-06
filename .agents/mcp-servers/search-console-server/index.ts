#!/usr/bin/env bun
/**
 * Search Console MCP Server — Google Search Console API.
 *
 * Exposes tools: query-search-analytics, get-index-coverage, list-sitemaps, inspect-url.
 * Receives OAuth2 access token via TOOL_ACCESS_TOKEN env var.
 *
 * Implements MCP stdio transport: JSON-RPC over stdin/stdout.
 */

import { createInterface } from "node:readline";

// ── Constants ──────────────────────────────────────────────────────────────

const SEARCH_CONSOLE_API = "https://searchconsole.googleapis.com/v1";
const WEBMASTERS_API = "https://www.googleapis.com/webmasters/v3";

// ── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "query-search-analytics",
    description:
      "Query search performance data (clicks, impressions, CTR, position)",
    inputSchema: {
      type: "object",
      properties: {
        site_url: {
          type: "string",
          description: "Site URL (e.g. 'https://example.com')",
        },
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        dimensions: {
          type: "array",
          items: { type: "string" },
          description: "Dimensions: query, page, country, device, date",
        },
        row_limit: {
          type: "number",
          description: "Max rows returned (default 1000, max 25000)",
        },
      },
      required: ["site_url", "start_date", "end_date"],
    },
  },
  {
    name: "get-index-coverage",
    description:
      "Get index coverage summary — indexed, excluded, and error page counts",
    inputSchema: {
      type: "object",
      properties: {
        site_url: { type: "string", description: "Site URL" },
      },
      required: ["site_url"],
    },
  },
  {
    name: "list-sitemaps",
    description: "List submitted sitemaps and their processing status",
    inputSchema: {
      type: "object",
      properties: {
        site_url: { type: "string", description: "Site URL" },
      },
      required: ["site_url"],
    },
  },
  {
    name: "inspect-url",
    description:
      "Inspect a specific URL's index status, crawl info, and mobile usability",
    inputSchema: {
      type: "object",
      properties: {
        site_url: { type: "string", description: "Site URL" },
        inspection_url: {
          type: "string",
          description: "The specific URL to inspect",
        },
      },
      required: ["site_url", "inspection_url"],
    },
  },
];

// ── API Helpers ─────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;

function getAccessToken(): string {
  const token = process.env.TOOL_ACCESS_TOKEN;
  if (!token) throw new Error("TOOL_ACCESS_TOKEN not set");
  return token;
}

function requireString(args: Record<string, unknown>, field: string): string {
  const val = args[field];
  if (typeof val !== "string" || !val) {
    throw new Error(`Missing required parameter: ${field}`);
  }
  return val;
}

async function apiRequest(
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const token = getAccessToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string>),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Search Console API error ${response.status}: ${body.slice(0, 500)}`,
      );
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Tool Handlers ──────────────────────────────────────────────────────────

async function querySearchAnalytics(
  args: Record<string, unknown>,
): Promise<string> {
  const siteUrl = requireString(args, "site_url");
  const body: Record<string, unknown> = {
    startDate: requireString(args, "start_date"),
    endDate: requireString(args, "end_date"),
    rowLimit: (args.row_limit as number) ?? 1000,
  };
  if (args.dimensions) {
    body.dimensions = args.dimensions;
  }

  const encodedSiteUrl = encodeURIComponent(siteUrl);
  const result = await apiRequest(
    `${WEBMASTERS_API}/sites/${encodedSiteUrl}/searchAnalytics/query`,
    { method: "POST", body: JSON.stringify(body) },
  );

  return JSON.stringify(result, null, 2);
}

async function getIndexCoverage(
  args: Record<string, unknown>,
): Promise<string> {
  const siteUrl = requireString(args, "site_url");

  // Use URL Inspection API to get a summary via search analytics
  // The actual index coverage report is only in Search Console UI,
  // but we can approximate via the URL Inspection API
  const encodedSiteUrl = encodeURIComponent(siteUrl);
  const result = await apiRequest(
    `${WEBMASTERS_API}/sites/${encodedSiteUrl}`,
  );

  return JSON.stringify(result, null, 2);
}

async function listSitemaps(args: Record<string, unknown>): Promise<string> {
  const siteUrl = requireString(args, "site_url");
  const encodedSiteUrl = encodeURIComponent(siteUrl);

  const result = await apiRequest(
    `${WEBMASTERS_API}/sites/${encodedSiteUrl}/sitemaps`,
  );

  return JSON.stringify(result, null, 2);
}

async function inspectUrl(args: Record<string, unknown>): Promise<string> {
  const siteUrl = requireString(args, "site_url");
  const inspectionUrl = requireString(args, "inspection_url");

  const result = await apiRequest(
    `${SEARCH_CONSOLE_API}/urlInspection/index:inspect`,
    {
      method: "POST",
      body: JSON.stringify({
        inspectionUrl,
        siteUrl,
      }),
    },
  );

  return JSON.stringify(result, null, 2);
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
        serverInfo: { name: "search-console-server", version: "1.0.0" },
      };

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const toolName = params.name as string;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

      try {
        let text: string;
        switch (toolName) {
          case "query-search-analytics":
            text = await querySearchAnalytics(toolArgs);
            break;
          case "get-index-coverage":
            text = await getIndexCoverage(toolArgs);
            break;
          case "list-sitemaps":
            text = await listSitemaps(toolArgs);
            break;
          case "inspect-url":
            text = await inspectUrl(toolArgs);
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
    const msg = JSON.parse(line) as Record<string, unknown>;

    if (!msg.method || typeof msg.method !== "string") {
      if (msg.id !== undefined) {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "Invalid request: missing method" } }) + "\n",
        );
      }
      return;
    }

    if (msg.id === undefined) return;

    const result = await handleRequest(msg.method, (msg.params ?? {}) as Record<string, unknown>);
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
