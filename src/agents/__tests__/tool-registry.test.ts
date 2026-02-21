import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  ToolRegistry,
  ToolRegistryError,
  type ToolRegistryData,
  type ToolConfigData,
} from "../tool-registry.ts";

// ── Test Data ────────────────────────────────────────────────────────────────

const MINIMAL_TOOL: ToolConfigData = {
  description: "A test tool for unit testing",
  provider: "stub",
  skills: ["page-cro", "analytics-tracking"],
  actions: [
    {
      name: "query-data",
      description: "Query test data",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The query" },
        },
        required: ["query"],
      },
    },
    {
      name: "write-data",
      description: "Write test data",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
      },
    },
  ],
};

const SECOND_TOOL: ToolConfigData = {
  description: "Another tool for testing",
  provider: "stub",
  skills: ["analytics-tracking", "ab-test-setup"],
  actions: [
    {
      name: "run-report",
      description: "Run analytics report",
      parameters: {
        type: "object",
        properties: {
          report_id: { type: "string" },
        },
        required: ["report_id"],
      },
    },
  ],
};

const DISABLED_TOOL: ToolConfigData = {
  description: "A disabled tool",
  provider: "stub",
  enabled: false,
  skills: ["page-cro"],
  actions: [
    {
      name: "disabled-action",
      description: "Should not appear",
      parameters: { type: "object" },
    },
  ],
};

const MINIMAL_DATA: ToolRegistryData = {
  tools: {
    "test-tool": MINIMAL_TOOL,
  },
};

const MULTI_TOOL_DATA: ToolRegistryData = {
  tools: {
    "test-tool": MINIMAL_TOOL,
    "analytics-tool": SECOND_TOOL,
  },
};

const WITH_DISABLED_DATA: ToolRegistryData = {
  tools: {
    "test-tool": MINIMAL_TOOL,
    "disabled-tool": DISABLED_TOOL,
  },
};

// ── fromData ─────────────────────────────────────────────────────────────────

describe("ToolRegistry.fromData", () => {
  it("creates registry with correct tool count", () => {
    const registry = ToolRegistry.fromData(MINIMAL_DATA);
    expect(registry.toolNames).toHaveLength(1);
  });

  it("creates registry with multiple tools", () => {
    const registry = ToolRegistry.fromData(MULTI_TOOL_DATA);
    expect(registry.toolNames).toHaveLength(2);
    expect(registry.toolNames).toContain("test-tool");
    expect(registry.toolNames).toContain("analytics-tool");
  });

  it("creates empty registry", () => {
    const registry = ToolRegistry.fromData({ tools: {} });
    expect(registry.toolNames).toHaveLength(0);
  });

  it("includes disabled tools in toolNames", () => {
    const registry = ToolRegistry.fromData(WITH_DISABLED_DATA);
    expect(registry.toolNames).toContain("disabled-tool");
  });

  it("builds correct skill-tool mappings", () => {
    const registry = ToolRegistry.fromData(MINIMAL_DATA);
    const tools = registry.getToolsForSkill("page-cro");
    expect(tools).toHaveLength(2); // query-data + write-data
  });

  it("builds correct tool-skill mappings", () => {
    const registry = ToolRegistry.fromData(MINIMAL_DATA);
    const skills = registry.getToolSkills("test-tool");
    expect(skills).toContain("page-cro");
    expect(skills).toContain("analytics-tracking");
  });
});

// ── empty ───────────────────────────────────────────────────────────────────

describe("ToolRegistry.empty", () => {
  it("returns a registry with no tools", () => {
    const registry = ToolRegistry.empty();
    expect(registry.toolNames).toHaveLength(0);
  });

  it("getToolsForSkill returns empty for any skill", () => {
    const registry = ToolRegistry.empty();
    expect(registry.getToolsForSkill("page-cro")).toEqual([]);
  });

  it("hasToolsForSkill returns false for any skill", () => {
    const registry = ToolRegistry.empty();
    expect(registry.hasToolsForSkill("page-cro")).toBe(false);
  });
});

// ── Query Methods ────────────────────────────────────────────────────────────

describe("ToolRegistry query methods", () => {
  const registry = ToolRegistry.fromData(MULTI_TOOL_DATA);

  it("getToolsForSkill returns correct tool definitions", () => {
    const tools = registry.getToolsForSkill("page-cro");
    expect(tools).toHaveLength(2); // test-tool has 2 actions
    expect(tools[0]!.name).toBe("test-tool__query-data");
    expect(tools[1]!.name).toBe("test-tool__write-data");
  });

  it("getToolsForSkill merges tools from multiple sources", () => {
    const tools = registry.getToolsForSkill("analytics-tracking");
    expect(tools).toHaveLength(3); // 2 from test-tool + 1 from analytics-tool
    const names = tools.map((t) => t.name);
    expect(names).toContain("test-tool__query-data");
    expect(names).toContain("test-tool__write-data");
    expect(names).toContain("analytics-tool__run-report");
  });

  it("getToolsForSkill returns empty for skill with no tools", () => {
    expect(registry.getToolsForSkill("copywriting")).toEqual([]);
  });

  it("getToolsForSkill excludes disabled tools", () => {
    const reg = ToolRegistry.fromData(WITH_DISABLED_DATA);
    const tools = reg.getToolsForSkill("page-cro");
    // Only test-tool actions, not disabled-tool
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("disabled-tool__disabled-action");
  });

  it("getToolSkills returns correct skills", () => {
    expect(registry.getToolSkills("test-tool")).toContain("page-cro");
    expect(registry.getToolSkills("test-tool")).toContain("analytics-tracking");
  });

  it("getToolSkills returns empty for unknown tool", () => {
    expect(registry.getToolSkills("nonexistent")).toEqual([]);
  });

  it("getToolSkills returns empty for disabled tools", () => {
    const reg = ToolRegistry.fromData(WITH_DISABLED_DATA);
    // disabled tools don't get wired into toolSkillMap
    expect(reg.getToolSkills("disabled-tool")).toEqual([]);
  });

  it("getToolConfig returns config for known tool", () => {
    const config = registry.getToolConfig("test-tool");
    expect(config).toBeDefined();
    expect(config!.description).toBe("A test tool for unit testing");
    expect(config!.provider).toBe("stub");
  });

  it("getToolConfig returns undefined for unknown tool", () => {
    expect(registry.getToolConfig("nonexistent")).toBeUndefined();
  });

  it("isToolEnabled returns true for enabled tool", () => {
    expect(registry.isToolEnabled("test-tool")).toBe(true);
  });

  it("isToolEnabled returns true for tool with no explicit enabled field", () => {
    // MINIMAL_TOOL has no enabled field — should default to true
    expect(registry.isToolEnabled("test-tool")).toBe(true);
  });

  it("isToolEnabled returns false for disabled tool", () => {
    const reg = ToolRegistry.fromData(WITH_DISABLED_DATA);
    expect(reg.isToolEnabled("disabled-tool")).toBe(false);
  });

  it("isToolEnabled returns false for nonexistent tool", () => {
    expect(registry.isToolEnabled("nonexistent")).toBe(false);
  });

  it("hasToolsForSkill returns true for skills with tools", () => {
    expect(registry.hasToolsForSkill("page-cro")).toBe(true);
    expect(registry.hasToolsForSkill("analytics-tracking")).toBe(true);
  });

  it("hasToolsForSkill returns false for skills without tools", () => {
    expect(registry.hasToolsForSkill("copywriting")).toBe(false);
  });
});

// ── Claude Tool Definition Format ────────────────────────────────────────────

describe("Claude tool definition format", () => {
  const registry = ToolRegistry.fromData(MINIMAL_DATA);

  it("uses qualified name format: toolName__actionName", () => {
    const tools = registry.getToolsForSkill("page-cro");
    expect(tools[0]!.name).toBe("test-tool__query-data");
    expect(tools[1]!.name).toBe("test-tool__write-data");
  });

  it("includes bracketed tool name in description", () => {
    const tools = registry.getToolsForSkill("page-cro");
    expect(tools[0]!.description).toBe("[test-tool] Query test data");
    expect(tools[1]!.description).toBe("[test-tool] Write test data");
  });

  it("has correct input_schema with type: object", () => {
    const tools = registry.getToolsForSkill("page-cro");
    expect(tools[0]!.input_schema.type).toBe("object");
  });

  it("passes through properties from action parameters", () => {
    const tools = registry.getToolsForSkill("page-cro");
    const props = tools[0]!.input_schema.properties as Record<string, unknown>;
    expect(props).toBeDefined();
    expect(props["query"]).toBeDefined();
  });

  it("passes through required from action parameters", () => {
    const tools = registry.getToolsForSkill("page-cro");
    expect(tools[0]!.input_schema.required).toEqual(["query"]);
  });

  it("handles actions with no properties or required", () => {
    const data: ToolRegistryData = {
      tools: {
        "bare-tool": {
          description: "Minimal",
          provider: "stub",
          skills: ["page-cro"],
          actions: [
            {
              name: "simple",
              description: "No params",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    const reg = ToolRegistry.fromData(data);
    const tools = reg.getToolsForSkill("page-cro");
    expect(tools[0]!.input_schema.properties).toBeNull();
    expect(tools[0]!.input_schema.required).toBeNull();
  });
});

// ── registerTool ─────────────────────────────────────────────────────────────

describe("ToolRegistry.registerTool", () => {
  it("returns new registry with additional tool", () => {
    const original = ToolRegistry.fromData(MINIMAL_DATA);
    const extended = original.registerTool("new-tool", SECOND_TOOL);
    expect(extended.toolNames).toContain("new-tool");
    expect(extended.toolNames).toHaveLength(2);
  });

  it("original registry is unchanged (immutability)", () => {
    const original = ToolRegistry.fromData(MINIMAL_DATA);
    original.registerTool("new-tool", SECOND_TOOL);
    expect(original.toolNames).toHaveLength(1);
    expect(original.toolNames).not.toContain("new-tool");
  });

  it("rejects duplicate tool name", () => {
    const registry = ToolRegistry.fromData(MINIMAL_DATA);
    expect(() => registry.registerTool("test-tool", SECOND_TOOL)).toThrow(
      ToolRegistryError,
    );
    expect(() => registry.registerTool("test-tool", SECOND_TOOL)).toThrow(
      /already registered/,
    );
  });

  it("validates new tool config", () => {
    const registry = ToolRegistry.fromData(MINIMAL_DATA);
    const badTool: ToolConfigData = {
      description: "Bad",
      provider: "stub",
      skills: ["page-cro"],
      actions: [
        { name: "dup", description: "A", parameters: { type: "object" } },
        { name: "dup", description: "B", parameters: { type: "object" } },
      ],
    };
    expect(() => registry.registerTool("bad-tool", badTool)).toThrow(
      ToolRegistryError,
    );
  });

  it("new registry has tools accessible for the right skills", () => {
    const original = ToolRegistry.fromData(MINIMAL_DATA);
    const extended = original.registerTool("analytics-tool", SECOND_TOOL);
    const tools = extended.getToolsForSkill("ab-test-setup");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("analytics-tool__run-report");
  });
});

// ── invokeTool ───────────────────────────────────────────────────────────────

describe("ToolRegistry.invokeTool", () => {
  const registry = ToolRegistry.fromData(MINIMAL_DATA);

  it("stub invocation returns success", async () => {
    const result = await registry.invokeTool("test-tool__query-data", {
      query: "test",
    });
    expect(result.success).toBe(true);
    expect(result.isStub).toBe(true);
  });

  it("returns correct toolName and actionName", async () => {
    const result = await registry.invokeTool("test-tool__write-data", {
      key: "k",
      value: "v",
    });
    expect(result.toolName).toBe("test-tool");
    expect(result.actionName).toBe("write-data");
  });

  it("returns JSON content with stub metadata", async () => {
    const result = await registry.invokeTool("test-tool__query-data", {
      query: "test",
    });
    const parsed = JSON.parse(result.content as string);
    expect(parsed.stub).toBe(true);
    expect(parsed.tool).toBe("test-tool");
    expect(parsed.action).toBe("query-data");
    expect(parsed.params).toEqual({ query: "test" });
  });

  it("has non-negative durationMs", async () => {
    const result = await registry.invokeTool("test-tool__query-data", {
      query: "test",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects invalid qualified name (no __)", async () => {
    await expect(
      registry.invokeTool("test-tool-query-data", {}),
    ).rejects.toThrow(ToolRegistryError);
    await expect(
      registry.invokeTool("test-tool-query-data", {}),
    ).rejects.toThrow(/expected format/);
  });

  it("rejects unknown tool", async () => {
    await expect(
      registry.invokeTool("nonexistent__action", {}),
    ).rejects.toThrow(ToolRegistryError);
    await expect(
      registry.invokeTool("nonexistent__action", {}),
    ).rejects.toThrow(/not found/);
  });

  it("rejects disabled tool", async () => {
    const reg = ToolRegistry.fromData(WITH_DISABLED_DATA);
    await expect(
      reg.invokeTool("disabled-tool__disabled-action", {}),
    ).rejects.toThrow(ToolRegistryError);
    await expect(
      reg.invokeTool("disabled-tool__disabled-action", {}),
    ).rejects.toThrow(/disabled/);
  });

  it("rejects unknown action on valid tool", async () => {
    await expect(
      registry.invokeTool("test-tool__nonexistent", {}),
    ).rejects.toThrow(ToolRegistryError);
    await expect(
      registry.invokeTool("test-tool__nonexistent", {}),
    ).rejects.toThrow(/not found/);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("ToolRegistry validation", () => {
  it("rejects duplicate action names within a tool", () => {
    const bad: ToolRegistryData = {
      tools: {
        "dup-tool": {
          description: "Tool with duplicate actions",
          provider: "stub",
          skills: ["page-cro"],
          actions: [
            {
              name: "do-thing",
              description: "First",
              parameters: { type: "object" },
            },
            {
              name: "do-thing",
              description: "Duplicate",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    expect(() => ToolRegistry.fromData(bad)).toThrow(ToolRegistryError);
    expect(() => ToolRegistry.fromData(bad)).toThrow(/duplicate action name/);
  });

  it("rejects negative rate_limit.max_per_minute", () => {
    const bad: ToolRegistryData = {
      tools: {
        "bad-rate": {
          description: "Bad rate limit",
          provider: "stub",
          skills: ["page-cro"],
          rate_limit: { max_per_minute: -1 },
          actions: [
            {
              name: "action",
              description: "A",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    expect(() => ToolRegistry.fromData(bad)).toThrow(ToolRegistryError);
    expect(() => ToolRegistry.fromData(bad)).toThrow(/max_per_minute/);
  });

  it("rejects zero rate_limit.max_per_minute", () => {
    const bad: ToolRegistryData = {
      tools: {
        "zero-rate": {
          description: "Zero rate limit",
          provider: "stub",
          skills: ["page-cro"],
          rate_limit: { max_per_minute: 0 },
          actions: [
            {
              name: "action",
              description: "A",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    expect(() => ToolRegistry.fromData(bad)).toThrow(ToolRegistryError);
  });

  it("accepts valid tool config with rate_limit", () => {
    const good: ToolRegistryData = {
      tools: {
        "good-rate": {
          description: "Good rate limit",
          provider: "stub",
          skills: ["page-cro"],
          rate_limit: { max_per_minute: 60 },
          actions: [
            {
              name: "action",
              description: "A",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    expect(() => ToolRegistry.fromData(good)).not.toThrow();
  });

  it("accepts valid empty registry", () => {
    expect(() => ToolRegistry.fromData({ tools: {} })).not.toThrow();
  });

  it("collects multiple validation errors", () => {
    const bad: ToolRegistryData = {
      tools: {
        "tool-a": {
          description: "A",
          provider: "stub",
          skills: ["page-cro"],
          rate_limit: { max_per_minute: -5 },
          actions: [
            {
              name: "dup",
              description: "X",
              parameters: { type: "object" },
            },
            {
              name: "dup",
              description: "Y",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    try {
      ToolRegistry.fromData(bad);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolRegistryError);
      const err = e as ToolRegistryError;
      expect(err.errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ── Schema Validation (via YAML) ─────────────────────────────────────────────

describe("ToolRegistry schema validation", () => {
  it("rejects YAML with non-object root", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "tool-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, "just a string\n");
    try {
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        ToolRegistryError,
      );
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        /expected an object/,
      );
    } finally {
      await unlink(path);
    }
  });

  it("rejects YAML with missing tools key", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "tool-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, "foo: bar\n");
    try {
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        ToolRegistryError,
      );
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        /Invalid YAML schema/,
      );
    } finally {
      await unlink(path);
    }
  });

  it("rejects tool with missing description", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "tool-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(
      path,
      'tools:\n  bad:\n    provider: stub\n    skills: [a]\n    actions:\n      - name: x\n        description: "y"\n        parameters:\n          type: object\n',
    );
    try {
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        ToolRegistryError,
      );
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        /description/,
      );
    } finally {
      await unlink(path);
    }
  });

  it("rejects tool with invalid provider", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "tool-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(
      path,
      'tools:\n  bad:\n    description: "B"\n    provider: invalid\n    skills: [a]\n    actions:\n      - name: x\n        description: "y"\n        parameters:\n          type: object\n',
    );
    try {
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        ToolRegistryError,
      );
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(/provider/);
    } finally {
      await unlink(path);
    }
  });

  it("rejects action with missing name", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "tool-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(
      path,
      'tools:\n  bad:\n    description: "B"\n    provider: stub\n    skills: [a]\n    actions:\n      - description: "no name"\n        parameters:\n          type: object\n',
    );
    try {
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        ToolRegistryError,
      );
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(/name/);
    } finally {
      await unlink(path);
    }
  });

  it("rejects action with invalid parameters type", async () => {
    const { writeFile, mkdtemp, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "tool-reg-"));
    const path = join(dir, "bad.yaml");
    await writeFile(
      path,
      'tools:\n  bad:\n    description: "B"\n    provider: stub\n    skills: [a]\n    actions:\n      - name: x\n        description: "y"\n        parameters:\n          type: array\n',
    );
    try {
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        ToolRegistryError,
      );
      await expect(ToolRegistry.fromYaml(path)).rejects.toThrow(
        /parameters\.type/,
      );
    } finally {
      await unlink(path);
    }
  });
});

// ── YAML Loading ─────────────────────────────────────────────────────────────

describe("ToolRegistry.fromYaml", () => {
  const yamlPath = resolve(
    import.meta.dir,
    "../../../.agents/tools.yaml",
  );

  it("loads .agents/tools.yaml successfully (empty default)", async () => {
    const registry = await ToolRegistry.fromYaml(yamlPath);
    expect(registry.toolNames).toHaveLength(0);
  });

  it("throws ToolRegistryError for missing file", async () => {
    await expect(
      ToolRegistry.fromYaml("/nonexistent/path/tools.yaml"),
    ).rejects.toThrow(ToolRegistryError);
    await expect(
      ToolRegistry.fromYaml("/nonexistent/path/tools.yaml"),
    ).rejects.toThrow(/not found/);
  });

  it("loads a YAML with real tool definitions", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "tool-reg-"));
    const path = join(dir, "tools.yaml");
    const yaml = `tools:
  ga4:
    description: "Google Analytics 4"
    provider: stub
    skills: [analytics-tracking]
    actions:
      - name: query-events
        description: "Query GA4 event data"
        parameters:
          type: object
          properties:
            start_date: { type: string }
          required: [start_date]
  search-console:
    description: "Google Search Console"
    provider: stub
    skills: [seo-audit]
    actions:
      - name: get-rankings
        description: "Get keyword rankings"
        parameters:
          type: object
`;
    await writeFile(path, yaml);
    try {
      const registry = await ToolRegistry.fromYaml(path);
      expect(registry.toolNames).toHaveLength(2);
      expect(registry.toolNames).toContain("ga4");
      expect(registry.toolNames).toContain("search-console");

      const ga4Tools = registry.getToolsForSkill("analytics-tracking");
      expect(ga4Tools).toHaveLength(1);
      expect(ga4Tools[0]!.name).toBe("ga4__query-events");

      const seoTools = registry.getToolsForSkill("seo-audit");
      expect(seoTools).toHaveLength(1);
      expect(seoTools[0]!.name).toBe("search-console__get-rankings");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Immutability ─────────────────────────────────────────────────────────────

describe("ToolRegistry immutability", () => {
  it("toolNames is frozen", () => {
    const registry = ToolRegistry.fromData(MINIMAL_DATA);
    expect(() => {
      (registry.toolNames as string[]).push("injected");
    }).toThrow();
  });

  it("registerTool produces new instance", () => {
    const original = ToolRegistry.fromData(MINIMAL_DATA);
    const extended = original.registerTool("analytics-tool", SECOND_TOOL);
    expect(original).not.toBe(extended);
    expect(original.toolNames).toHaveLength(1);
    expect(extended.toolNames).toHaveLength(2);
  });
});

// ── Optional fields ──────────────────────────────────────────────────────────

describe("ToolRegistry optional fields", () => {
  it("handles tool with credentials_env", () => {
    const data: ToolRegistryData = {
      tools: {
        ga4: {
          description: "GA4",
          provider: "stub",
          credentials_env: "GA4_CREDENTIALS",
          skills: ["analytics-tracking"],
          actions: [
            {
              name: "query",
              description: "Q",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    const registry = ToolRegistry.fromData(data);
    const config = registry.getToolConfig("ga4");
    expect(config!.credentials_env).toBe("GA4_CREDENTIALS");
  });

  it("handles tool with mcp_server", () => {
    const data: ToolRegistryData = {
      tools: {
        ga4: {
          description: "GA4",
          provider: "mcp",
          mcp_server: "@anthropic/ga4-mcp",
          skills: ["analytics-tracking"],
          actions: [
            {
              name: "query",
              description: "Q",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    const registry = ToolRegistry.fromData(data);
    const config = registry.getToolConfig("ga4");
    expect(config!.mcp_server).toBe("@anthropic/ga4-mcp");
  });

  it("handles tool with rate_limit", () => {
    const data: ToolRegistryData = {
      tools: {
        ga4: {
          description: "GA4",
          provider: "stub",
          skills: ["analytics-tracking"],
          rate_limit: { max_per_minute: 120 },
          actions: [
            {
              name: "query",
              description: "Q",
              parameters: { type: "object" },
            },
          ],
        },
      },
    };
    const registry = ToolRegistry.fromData(data);
    const config = registry.getToolConfig("ga4");
    expect(config!.rate_limit!.max_per_minute).toBe(120);
  });

  it("handles all three provider types", () => {
    for (const provider of ["stub", "mcp", "rest"] as const) {
      const data: ToolRegistryData = {
        tools: {
          tool: {
            description: "Tool",
            provider,
            skills: ["page-cro"],
            actions: [
              {
                name: "act",
                description: "A",
                parameters: { type: "object" },
              },
            ],
          },
        },
      };
      expect(() => ToolRegistry.fromData(data)).not.toThrow();
    }
  });
});
