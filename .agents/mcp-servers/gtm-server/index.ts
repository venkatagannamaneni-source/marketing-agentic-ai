#!/usr/bin/env bun
/**
 * GTM MCP Server — Google Tag Manager API v2.
 *
 * Exposes tools: list-tags, create-tag, create-trigger, publish-workspace.
 * Receives OAuth2 access token via TOOL_ACCESS_TOKEN env var.
 *
 * Implements MCP stdio transport: JSON-RPC over stdin/stdout.
 */

import { createInterface } from "node:readline";

// ── Constants ──────────────────────────────────────────────────────────────

const GTM_API = "https://tagmanager.googleapis.com/tagmanager/v2";

// ── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list-tags",
    description: "List all tags in a GTM container workspace",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "GTM account ID" },
        container_id: { type: "string", description: "GTM container ID" },
        workspace_id: {
          type: "string",
          description: "Workspace ID (default: 'Default Workspace')",
        },
      },
      required: ["account_id", "container_id"],
    },
  },
  {
    name: "create-tag",
    description:
      "Create a new tag (e.g. GA4 event tag, conversion tag)",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "GTM account ID" },
        container_id: { type: "string", description: "GTM container ID" },
        tag_name: { type: "string", description: "Human-readable tag name" },
        tag_type: {
          type: "string",
          description:
            "Tag type (e.g. 'gaawc' for GA4 config, 'gaawe' for GA4 event)",
        },
        parameters: {
          type: "array",
          description: "Tag parameters as key-value pairs",
        },
        firing_trigger_ids: {
          type: "array",
          items: { type: "string" },
          description: "Trigger IDs that fire this tag",
        },
      },
      required: ["account_id", "container_id", "tag_name", "tag_type"],
    },
  },
  {
    name: "create-trigger",
    description:
      "Create a trigger (pageview, click, form submission, custom event, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "GTM account ID" },
        container_id: { type: "string", description: "GTM container ID" },
        trigger_name: { type: "string", description: "Trigger name" },
        trigger_type: {
          type: "string",
          description:
            "Type: pageview, click, formSubmission, customEvent, etc.",
        },
        filters: {
          type: "array",
          description: "Trigger conditions/filters",
        },
      },
      required: ["account_id", "container_id", "trigger_name", "trigger_type"],
    },
  },
  {
    name: "publish-workspace",
    description:
      "Publish a GTM workspace — creates a new container version and deploys to production",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "GTM account ID" },
        container_id: { type: "string", description: "GTM container ID" },
        workspace_id: {
          type: "string",
          description: "Workspace ID to publish",
        },
        version_name: {
          type: "string",
          description: "Name for the published version",
        },
      },
      required: ["account_id", "container_id", "workspace_id"],
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

function workspacePath(
  accountId: string,
  containerId: string,
  workspaceId?: string,
): string {
  const wsId = workspaceId ?? "1"; // Default workspace ID is typically "1"
  return `accounts/${accountId}/containers/${containerId}/workspaces/${wsId}`;
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
        `GTM API error ${response.status}: ${body.slice(0, 500)}`,
      );
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Tool Handlers ──────────────────────────────────────────────────────────

async function listTags(args: Record<string, unknown>): Promise<string> {
  const path = workspacePath(
    requireString(args, "account_id"),
    requireString(args, "container_id"),
    args.workspace_id as string | undefined,
  );

  const result = await apiRequest(`${GTM_API}/${path}/tags`);
  return JSON.stringify(result, null, 2);
}

async function createTag(args: Record<string, unknown>): Promise<string> {
  const path = workspacePath(
    requireString(args, "account_id"),
    requireString(args, "container_id"),
  );

  const body: Record<string, unknown> = {
    name: requireString(args, "tag_name"),
    type: requireString(args, "tag_type"),
  };

  if (args.parameters) {
    body.parameter = args.parameters;
  }
  if (args.firing_trigger_ids) {
    body.firingTriggerId = args.firing_trigger_ids;
  }

  const result = await apiRequest(`${GTM_API}/${path}/tags`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return JSON.stringify(result, null, 2);
}

async function createTrigger(args: Record<string, unknown>): Promise<string> {
  const path = workspacePath(
    requireString(args, "account_id"),
    requireString(args, "container_id"),
  );

  const body: Record<string, unknown> = {
    name: requireString(args, "trigger_name"),
    type: requireString(args, "trigger_type"),
  };

  if (args.filters) {
    body.filter = args.filters;
  }

  const result = await apiRequest(`${GTM_API}/${path}/triggers`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return JSON.stringify(result, null, 2);
}

async function publishWorkspace(
  args: Record<string, unknown>,
): Promise<string> {
  const path = workspacePath(
    requireString(args, "account_id"),
    requireString(args, "container_id"),
    requireString(args, "workspace_id"),
  );

  const body: Record<string, unknown> = {};
  if (args.version_name && typeof args.version_name === "string") {
    body.name = args.version_name;
  }

  // Create version from workspace
  const version = await apiRequest(
    `${GTM_API}/${path}:create_version`,
    { method: "POST", body: JSON.stringify(body) },
  );

  const versionData = version as {
    containerVersion?: { containerVersionId: string; path: string };
  };

  // Publish the version
  if (versionData.containerVersion?.path) {
    const publishResult = await apiRequest(
      `${GTM_API}/${versionData.containerVersion.path}:publish`,
      { method: "POST" },
    );
    return JSON.stringify(publishResult, null, 2);
  }

  return JSON.stringify(version, null, 2);
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
        serverInfo: { name: "gtm-server", version: "1.0.0" },
      };

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const toolName = params.name as string;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

      try {
        let text: string;
        switch (toolName) {
          case "list-tags":
            text = await listTags(toolArgs);
            break;
          case "create-tag":
            text = await createTag(toolArgs);
            break;
          case "create-trigger":
            text = await createTrigger(toolArgs);
            break;
          case "publish-workspace":
            text = await publishWorkspace(toolArgs);
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
