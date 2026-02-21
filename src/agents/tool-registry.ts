import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

// ── YAML Config Schema ──────────────────────────────────────────────────────

export interface ToolActionData {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

export interface ToolConfigData {
  readonly description: string;
  readonly provider: "stub" | "mcp" | "rest";
  readonly enabled?: boolean;
  readonly credentials_env?: string;
  readonly skills: readonly string[];
  readonly rate_limit?: {
    readonly max_per_minute: number;
  };
  readonly mcp_server?: string;
  readonly actions: readonly ToolActionData[];
}

export interface ToolRegistryData {
  readonly tools: Record<string, ToolConfigData>;
}

// ── Claude Tool Definition ──────────────────────────────────────────────────
// Shape produced for the Anthropic SDK `tools` parameter.

export interface ClaudeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: "object";
    readonly properties?: Record<string, unknown> | null;
    readonly required?: readonly string[] | null;
  };
}

// ── Tool Invocation Result ──────────────────────────────────────────────────

export interface ToolInvocationResult {
  readonly toolName: string;
  readonly actionName: string;
  readonly success: boolean;
  readonly content: string;
  readonly durationMs: number;
  readonly isStub: boolean;
}

// ── Validation Error ────────────────────────────────────────────────────────

export class ToolRegistryError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

// ── Valid Providers ─────────────────────────────────────────────────────────

const VALID_PROVIDERS = ["stub", "mcp", "rest"] as const;

// ── Tool Registry ───────────────────────────────────────────────────────────

/**
 * Configuration-driven tool registry.
 *
 * Loads tool definitions from a YAML config file (`.agents/tools.yaml`).
 * Each tool is bound to specific skills — only authorized skills can
 * discover and invoke a given tool.
 *
 * Follows the SkillRegistry pattern: private constructor, static factories,
 * two-stage validation, frozen properties, custom error class.
 *
 * Phase 3b uses stub invocations. Phase 4 adds real MCP/REST providers.
 */
export class ToolRegistry {
  readonly toolNames: readonly string[];
  private readonly tools: ReadonlyMap<string, ToolConfigData>;
  private readonly skillToolMap: ReadonlyMap<
    string,
    readonly ClaudeToolDefinition[]
  >;
  private readonly toolSkillMap: ReadonlyMap<string, readonly string[]>;

  private constructor(data: ToolRegistryData) {
    const toolNames: string[] = [];
    const tools = new Map<string, ToolConfigData>();
    const skillToolMap = new Map<string, ClaudeToolDefinition[]>();
    const toolSkillMap = new Map<string, string[]>();

    for (const [toolName, config] of Object.entries(data.tools)) {
      toolNames.push(toolName);
      tools.set(toolName, config);

      const isEnabled = config.enabled !== false;
      if (!isEnabled) continue;

      // Build Claude tool definitions for each action
      const toolDefs: ClaudeToolDefinition[] = [];
      for (const action of config.actions) {
        toolDefs.push({
          name: `${toolName}__${action.name}`,
          description: `[${toolName}] ${action.description}`,
          input_schema: {
            type: "object",
            properties: action.parameters.properties ?? null,
            required: action.parameters.required ?? null,
          },
        });
      }

      // Map skills → tool definitions
      for (const skill of config.skills) {
        const existing = skillToolMap.get(skill) ?? [];
        existing.push(...toolDefs);
        skillToolMap.set(skill, existing);
      }

      // Map tool → skills
      toolSkillMap.set(toolName, [...config.skills]);
    }

    this.toolNames = Object.freeze(toolNames);
    this.tools = tools;
    this.skillToolMap = skillToolMap;
    this.toolSkillMap = toolSkillMap;
  }

  // ── Static Factories ────────────────────────────────────────────────────

  /**
   * Load registry from a YAML config file.
   * Parses the file, validates shape and semantics.
   */
  static async fromYaml(yamlPath: string): Promise<ToolRegistry> {
    let content: string;
    try {
      content = await readFile(yamlPath, "utf-8");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new ToolRegistryError(
          `Tool registry file not found: ${yamlPath}`,
          [`File not found: ${yamlPath}`],
        );
      }
      throw new ToolRegistryError(
        `Failed to read tool registry: ${yamlPath}`,
        [err instanceof Error ? err.message : String(err)],
      );
    }
    const raw = parseYaml(content);
    ToolRegistry.validateShape(raw);
    const registry = new ToolRegistry(raw);
    registry.validate();
    return registry;
  }

  /**
   * Create registry from in-memory data (useful for tests).
   * Validates semantics on construction.
   */
  static fromData(data: ToolRegistryData): ToolRegistry {
    const registry = new ToolRegistry(data);
    registry.validate();
    return registry;
  }

  /**
   * Returns an empty registry with no tools.
   * Used as the default when no tools.yaml exists.
   */
  static empty(): ToolRegistry {
    return new ToolRegistry({ tools: {} });
  }

  // ── Query Methods ───────────────────────────────────────────────────────

  /**
   * Get Claude API tool definitions for all enabled tools assigned to a skill.
   * Returns empty array if the skill has no tools.
   */
  getToolsForSkill(skillName: string): readonly ClaudeToolDefinition[] {
    return this.skillToolMap.get(skillName) ?? [];
  }

  /**
   * Get which skills can use a tool.
   */
  getToolSkills(toolName: string): readonly string[] {
    return this.toolSkillMap.get(toolName) ?? [];
  }

  /**
   * Look up raw config for a tool.
   */
  getToolConfig(toolName: string): ToolConfigData | undefined {
    return this.tools.get(toolName);
  }

  /**
   * Check if a tool exists and is enabled.
   */
  isToolEnabled(toolName: string): boolean {
    const config = this.tools.get(toolName);
    if (!config) return false;
    return config.enabled !== false;
  }

  /**
   * Quick check — returns true if getToolsForSkill would return non-empty.
   */
  hasToolsForSkill(skillName: string): boolean {
    const tools = this.skillToolMap.get(skillName);
    return tools !== undefined && tools.length > 0;
  }

  // ── Dynamic Registration ────────────────────────────────────────────────

  /**
   * Register a new tool and return a NEW ToolRegistry instance (immutable pattern).
   * The original registry is not modified.
   */
  registerTool(name: string, config: ToolConfigData): ToolRegistry {
    if (this.tools.has(name)) {
      throw new ToolRegistryError(`Tool "${name}" is already registered`, [
        `Duplicate tool name: ${name}`,
      ]);
    }
    const newData: ToolRegistryData = {
      tools: {
        ...Object.fromEntries(this.tools.entries()),
        [name]: config,
      },
    };
    const registry = new ToolRegistry(newData);
    registry.validate();
    return registry;
  }

  // ── Tool Invocation ─────────────────────────────────────────────────────

  /**
   * Invoke a tool by its qualified name ("{toolName}__{actionName}").
   *
   * Phase 3b: Always returns stub results.
   * Phase 4: Will switch on provider type (mcp, rest, stub).
   */
  async invokeTool(
    qualifiedName: string,
    params: Record<string, unknown>,
  ): Promise<ToolInvocationResult> {
    const startTime = Date.now();

    // Parse qualified name
    const separatorIndex = qualifiedName.indexOf("__");
    if (separatorIndex === -1) {
      throw new ToolRegistryError(
        `Invalid qualified tool name: "${qualifiedName}" (expected format: "toolName__actionName")`,
        [`Invalid qualified name: ${qualifiedName}`],
      );
    }

    const toolName = qualifiedName.slice(0, separatorIndex);
    const actionName = qualifiedName.slice(separatorIndex + 2);

    const config = this.tools.get(toolName);
    if (!config) {
      throw new ToolRegistryError(`Tool "${toolName}" not found`, [
        `Unknown tool: ${toolName}`,
      ]);
    }

    if (config.enabled === false) {
      throw new ToolRegistryError(`Tool "${toolName}" is disabled`, [
        `Disabled tool: ${toolName}`,
      ]);
    }

    const action = config.actions.find((a) => a.name === actionName);
    if (!action) {
      throw new ToolRegistryError(
        `Action "${actionName}" not found on tool "${toolName}"`,
        [`Unknown action: ${toolName}__${actionName}`],
      );
    }

    // Phase 3b: Stub invocation
    const durationMs = Date.now() - startTime;
    return {
      toolName,
      actionName,
      success: true,
      content: JSON.stringify({
        stub: true,
        tool: toolName,
        action: actionName,
        params,
        message: `Stub invocation of ${toolName}/${actionName}. Real implementation in Phase 4.`,
      }),
      durationMs,
      isStub: true,
    };
  }

  // ── Validation ──────────────────────────────────────────────────────────

  /**
   * Validate the raw YAML shape before constructing a registry.
   */
  private static validateShape(
    data: unknown,
  ): asserts data is ToolRegistryData {
    const errors: string[] = [];
    if (!data || typeof data !== "object") {
      throw new ToolRegistryError(
        "Invalid YAML: expected an object at root",
        ["Root must be an object"],
      );
    }
    const d = data as Record<string, unknown>;
    if (!d.tools || typeof d.tools !== "object" || Array.isArray(d.tools)) {
      errors.push("Missing or invalid 'tools' key (expected an object)");
    }

    // Validate each tool entry
    if (d.tools && typeof d.tools === "object" && !Array.isArray(d.tools)) {
      const tools = d.tools as Record<string, unknown>;
      for (const [toolName, toolConfig] of Object.entries(tools)) {
        if (!toolConfig || typeof toolConfig !== "object") {
          errors.push(`Tool "${toolName}": must be an object`);
          continue;
        }
        const tc = toolConfig as Record<string, unknown>;
        if (typeof tc.description !== "string") {
          errors.push(`Tool "${toolName}": missing or invalid 'description' (expected string)`);
        }
        if (
          typeof tc.provider !== "string" ||
          !VALID_PROVIDERS.includes(tc.provider as (typeof VALID_PROVIDERS)[number])
        ) {
          errors.push(
            `Tool "${toolName}": missing or invalid 'provider' (expected one of: ${VALID_PROVIDERS.join(", ")})`,
          );
        }
        if (!Array.isArray(tc.skills)) {
          errors.push(`Tool "${toolName}": missing or invalid 'skills' (expected array)`);
        }
        if (!Array.isArray(tc.actions)) {
          errors.push(`Tool "${toolName}": missing or invalid 'actions' (expected array)`);
        } else {
          for (let i = 0; i < tc.actions.length; i++) {
            const action = tc.actions[i] as Record<string, unknown> | undefined;
            if (!action || typeof action !== "object") {
              errors.push(`Tool "${toolName}" action[${i}]: must be an object`);
              continue;
            }
            if (typeof action.name !== "string") {
              errors.push(
                `Tool "${toolName}" action[${i}]: missing or invalid 'name' (expected string)`,
              );
            }
            if (typeof action.description !== "string") {
              errors.push(
                `Tool "${toolName}" action[${i}]: missing or invalid 'description' (expected string)`,
              );
            }
            if (
              !action.parameters ||
              typeof action.parameters !== "object"
            ) {
              errors.push(
                `Tool "${toolName}" action[${i}]: missing or invalid 'parameters' (expected object)`,
              );
            } else {
              const params = action.parameters as Record<string, unknown>;
              if (params.type !== "object") {
                errors.push(
                  `Tool "${toolName}" action[${i}]: parameters.type must be "object"`,
                );
              }
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new ToolRegistryError(
        `Invalid YAML schema: ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }

  /**
   * Validate the registry configuration semantically.
   */
  private validate(): void {
    const errors: string[] = [];

    // 1. Action names must be unique within each tool
    for (const [toolName, config] of this.tools.entries()) {
      const actionNames = new Set<string>();
      for (const action of config.actions) {
        if (actionNames.has(action.name)) {
          errors.push(
            `Tool "${toolName}": duplicate action name "${action.name}"`,
          );
        }
        actionNames.add(action.name);
      }
    }

    // 2. Qualified names must be globally unique
    const qualifiedNames = new Set<string>();
    for (const [toolName, config] of this.tools.entries()) {
      for (const action of config.actions) {
        const qn = `${toolName}__${action.name}`;
        if (qualifiedNames.has(qn)) {
          errors.push(`Duplicate qualified tool name: "${qn}"`);
        }
        qualifiedNames.add(qn);
      }
    }

    // 3. rate_limit.max_per_minute must be positive if present
    for (const [toolName, config] of this.tools.entries()) {
      if (config.rate_limit !== undefined) {
        if (
          typeof config.rate_limit.max_per_minute !== "number" ||
          config.rate_limit.max_per_minute <= 0
        ) {
          errors.push(
            `Tool "${toolName}": rate_limit.max_per_minute must be a positive number`,
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new ToolRegistryError(
        `Tool registry validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        errors,
      );
    }
  }
}
