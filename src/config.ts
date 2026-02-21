import { resolve } from "node:path";
import { LOG_LEVELS, LOG_FORMATS } from "./observability/logger.ts";
import type { LogLevel, LogFormat } from "./observability/logger.ts";

// ── Runtime Configuration ──────────────────────────────────────────────────

export interface RuntimeConfig {
  readonly anthropicApiKey: string;
  readonly redis: {
    readonly host: string;
    readonly port: number;
    readonly password: string | undefined;
  };
  readonly workspace: {
    readonly rootDir: string;
  };
  readonly projectRoot: string;
  readonly budget: {
    readonly totalMonthly: number;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly format: LogFormat;
  };
  readonly maxParallelAgents: number;
  readonly maxToolIterations: number;
}

// ── Config Error ───────────────────────────────────────────────────────────

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

// ── Load Config ────────────────────────────────────────────────────────────

/**
 * Load runtime configuration from environment variables.
 *
 * @param envOverrides Optional env-var-style overrides for testing.
 *   Keys are env var names (e.g. "ANTHROPIC_API_KEY"), values are strings.
 * @returns Frozen RuntimeConfig object.
 * @throws ConfigError if required fields are missing or invalid.
 */
export function loadConfig(
  envOverrides?: Record<string, string | undefined>,
): RuntimeConfig {
  const env = (key: string): string | undefined =>
    envOverrides?.[key] ?? process.env[key];

  // ── Required: ANTHROPIC_API_KEY ────────────────────────────────────────
  const anthropicApiKey = env("ANTHROPIC_API_KEY")?.trim();
  if (!anthropicApiKey) {
    throw new ConfigError(
      "ANTHROPIC_API_KEY is required. Set it in .env or as an environment variable.",
      "ANTHROPIC_API_KEY",
    );
  }

  // ── Redis ──────────────────────────────────────────────────────────────
  const redisHost = env("REDIS_HOST")?.trim() || "localhost";

  const redisPortRaw = env("REDIS_PORT");
  let redisPort = 6379;
  if (redisPortRaw !== undefined && redisPortRaw !== "") {
    redisPort = parseInt(redisPortRaw, 10);
    if (!Number.isFinite(redisPort) || redisPort <= 0) {
      throw new ConfigError(
        `REDIS_PORT must be a positive integer, got "${redisPortRaw}".`,
        "REDIS_PORT",
      );
    }
  }

  const redisPasswordRaw = env("REDIS_PASSWORD");
  const redisPassword =
    redisPasswordRaw !== undefined && redisPasswordRaw !== ""
      ? redisPasswordRaw
      : undefined;

  // ── Workspace ──────────────────────────────────────────────────────────
  const workspaceDir = env("WORKSPACE_DIR")?.trim() || "./workspace";
  const rootDir = resolve(process.cwd(), workspaceDir);

  // ── Project Root ───────────────────────────────────────────────────────
  const projectRootRaw = env("PROJECT_ROOT")?.trim();
  const projectRoot = projectRootRaw
    ? resolve(process.cwd(), projectRootRaw)
    : resolve(import.meta.dir, "..");

  // ── Budget ─────────────────────────────────────────────────────────────
  const budgetMonthlyRaw = env("BUDGET_MONTHLY");
  let budgetMonthly = 1000;
  if (budgetMonthlyRaw !== undefined && budgetMonthlyRaw !== "") {
    budgetMonthly = parseFloat(budgetMonthlyRaw);
    if (!Number.isFinite(budgetMonthly) || budgetMonthly <= 0) {
      throw new ConfigError(
        `BUDGET_MONTHLY must be a positive number, got "${budgetMonthlyRaw}".`,
        "BUDGET_MONTHLY",
      );
    }
  }

  // ── Logging ────────────────────────────────────────────────────────────
  const logLevelRaw = (env("LOG_LEVEL") || "info").trim();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new ConfigError(
      `LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}. Got "${logLevelRaw}".`,
      "LOG_LEVEL",
    );
  }
  const logLevel = logLevelRaw as LogLevel;

  const logFormatRaw = (env("LOG_FORMAT") || "pretty").trim();
  if (!LOG_FORMATS.includes(logFormatRaw as LogFormat)) {
    throw new ConfigError(
      `LOG_FORMAT must be one of: ${LOG_FORMATS.join(", ")}. Got "${logFormatRaw}".`,
      "LOG_FORMAT",
    );
  }
  const logFormat = logFormatRaw as LogFormat;

  // ── Concurrency ────────────────────────────────────────────────────────
  const maxParallelRaw = env("MAX_PARALLEL_AGENTS");
  let maxParallelAgents = 3;
  if (maxParallelRaw !== undefined && maxParallelRaw !== "") {
    maxParallelAgents = parseInt(maxParallelRaw, 10);
    if (!Number.isFinite(maxParallelAgents) || maxParallelAgents < 1) {
      throw new ConfigError(
        `MAX_PARALLEL_AGENTS must be a positive integer (>= 1), got "${maxParallelRaw}".`,
        "MAX_PARALLEL_AGENTS",
      );
    }
  }

  // ── Tool Iterations ──────────────────────────────────────────────────
  const maxToolIterRaw = env("MAX_TOOL_ITERATIONS");
  let maxToolIterations = 10;
  if (maxToolIterRaw !== undefined && maxToolIterRaw !== "") {
    maxToolIterations = parseInt(maxToolIterRaw, 10);
    if (!Number.isFinite(maxToolIterations) || maxToolIterations < 1) {
      throw new ConfigError(
        `MAX_TOOL_ITERATIONS must be a positive integer (>= 1), got "${maxToolIterRaw}".`,
        "MAX_TOOL_ITERATIONS",
      );
    }
  }

  // ── Build and freeze ──────────────────────────────────────────────────
  const config: RuntimeConfig = {
    anthropicApiKey,
    redis: {
      host: redisHost,
      port: redisPort,
      password: redisPassword,
    },
    workspace: {
      rootDir,
    },
    projectRoot,
    budget: {
      totalMonthly: budgetMonthly,
    },
    logging: {
      level: logLevel,
      format: logFormat,
    },
    maxParallelAgents,
    maxToolIterations,
  };

  return Object.freeze({
    ...config,
    redis: Object.freeze(config.redis),
    workspace: Object.freeze(config.workspace),
    budget: Object.freeze(config.budget),
    logging: Object.freeze(config.logging),
  });
}
