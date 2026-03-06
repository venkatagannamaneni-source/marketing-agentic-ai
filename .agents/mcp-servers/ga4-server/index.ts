#!/usr/bin/env bun
/**
 * GA4 MCP Server — Google Analytics 4 Data API.
 *
 * Exposes tools: query-report, get-realtime, list-events, get-conversion-events.
 * Receives OAuth2 access token via TOOL_ACCESS_TOKEN env var.
 *
 * Implements MCP stdio transport: JSON-RPC over stdin/stdout.
 */

import { createInterface } from "node:readline";

// ── Constants ──────────────────────────────────────────────────────────────

const GA4_DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const GA4_ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";

// ── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "query-report",
    description:
      "Run a GA4 report query with metrics and dimensions over a date range",
    inputSchema: {
      type: "object",
      properties: {
        property_id: {
          type: "string",
          description: "GA4 property ID (e.g. 'properties/12345')",
        },
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        metrics: {
          type: "array",
          items: { type: "string" },
          description: "Metrics to query (e.g. ['sessions', 'conversions'])",
        },
        dimensions: {
          type: "array",
          items: { type: "string" },
          description: "Dimensions to group by (e.g. ['pagePath', 'source'])",
        },
      },
      required: ["property_id", "start_date", "end_date", "metrics"],
    },
  },
  {
    name: "get-realtime",
    description: "Get real-time active users and events",
    inputSchema: {
      type: "object",
      properties: {
        property_id: {
          type: "string",
          description: "GA4 property ID",
        },
      },
      required: ["property_id"],
    },
  },
  {
    name: "list-events",
    description: "List custom event definitions and custom dimensions/metrics",
    inputSchema: {
      type: "object",
      properties: {
        property_id: {
          type: "string",
          description: "GA4 property ID",
        },
      },
      required: ["property_id"],
    },
  },
  {
    name: "get-conversion-events",
    description: "List events marked as conversions (key events)",
    inputSchema: {
      type: "object",
      properties: {
        property_id: {
          type: "string",
          description: "GA4 property ID",
        },
      },
      required: ["property_id"],
    },
  },
];

// ── API Helpers ─────────────────────────────────────────────────────────────

function getAccessToken(): string {
  const token = process.env.TOOL_ACCESS_TOKEN;
  if (!token) throw new Error("TOOL_ACCESS_TOKEN not set");
  return token;
}

function normalizePropertyId(id: string): string {
  return id.startsWith("properties/") ? id : `properties/${id}`;
}

async function apiRequest(
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const token = getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GA4 API error ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  return response.json();
}

// ── Tool Handlers ──────────────────────────────────────────────────────────

async function queryReport(args: Record<string, unknown>): Promise<string> {
  const propertyId = normalizePropertyId(args.property_id as string);
  const metrics = (args.metrics as string[]).map((name) => ({ name }));
  const dimensions = (args.dimensions as string[] | undefined)?.map((name) => ({
    name,
  }));

  const body: Record<string, unknown> = {
    dateRanges: [
      { startDate: args.start_date as string, endDate: args.end_date as string },
    ],
    metrics,
  };
  if (dimensions?.length) body.dimensions = dimensions;

  const result = await apiRequest(
    `${GA4_DATA_API}/${propertyId}:runReport`,
    { method: "POST", body: JSON.stringify(body) },
  );

  return JSON.stringify(result, null, 2);
}

async function getRealtime(args: Record<string, unknown>): Promise<string> {
  const propertyId = normalizePropertyId(args.property_id as string);

  const result = await apiRequest(
    `${GA4_DATA_API}/${propertyId}:runRealtimeReport`,
    {
      method: "POST",
      body: JSON.stringify({
        metrics: [{ name: "activeUsers" }],
        dimensions: [{ name: "unifiedScreenName" }],
      }),
    },
  );

  return JSON.stringify(result, null, 2);
}

async function listEvents(args: Record<string, unknown>): Promise<string> {
  const propertyId = normalizePropertyId(args.property_id as string);

  const [customDimensions, customMetrics] = await Promise.all([
    apiRequest(`${GA4_ADMIN_API}/${propertyId}/customDimensions`),
    apiRequest(`${GA4_ADMIN_API}/${propertyId}/customMetrics`),
  ]);

  return JSON.stringify({ customDimensions, customMetrics }, null, 2);
}

async function getConversionEvents(
  args: Record<string, unknown>,
): Promise<string> {
  const propertyId = normalizePropertyId(args.property_id as string);

  const result = await apiRequest(
    `${GA4_ADMIN_API}/${propertyId}/keyEvents`,
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
        serverInfo: { name: "ga4-server", version: "1.0.0" },
      };

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const toolName = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      try {
        let text: string;
        switch (toolName) {
          case "query-report":
            text = await queryReport(args);
            break;
          case "get-realtime":
            text = await getRealtime(args);
            break;
          case "list-events":
            text = await listEvents(args);
            break;
          case "get-conversion-events":
            text = await getConversionEvents(args);
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
      // Ignore notifications and unknown methods
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

    // Notifications (no id) — no response needed
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
    // Parse error or handler error
    console.error(
      `MCP server error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});
