import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeConfig } from "./config.ts";
import { createLogger } from "./observability/logger.ts";
import type { Logger } from "./observability/logger.ts";
import { CostTracker } from "./observability/cost-tracker.ts";
import {
  FileSystemWorkspaceManager,
  type WorkspaceManager,
} from "./workspace/workspace-manager.ts";
import { AnthropicClaudeClient } from "./agents/claude-client.ts";
import { AgentExecutor } from "./agents/executor.ts";
import type { ExecutorConfig } from "./agents/executor.ts";
import { MarketingDirector } from "./director/director.ts";
import { SequentialPipelineEngine } from "./pipeline/pipeline-engine.ts";
import { PipelineFactory } from "./director/pipeline-factory.ts";
import { PIPELINE_TEMPLATES } from "./agents/registry.ts";
import { SkillRegistry } from "./agents/skill-registry.ts";
import { ToolRegistry, ToolRegistryError } from "./agents/tool-registry.ts";
import { TaskQueueManager } from "./queue/task-queue.ts";
import { createRedisConnection } from "./queue/redis-connection.ts";
import type { RedisConnectionManager } from "./queue/redis-connection.ts";
import { createWorkerProcessor } from "./queue/worker.ts";
import { CompletionRouter } from "./queue/completion-router.ts";
import { FailureTracker } from "./queue/failure-tracker.ts";
import {
  BullMQQueueAdapter,
  BullMQWorkerAdapter,
} from "./queue/bullmq-adapter.ts";
import { EventBus } from "./events/event-bus.ts";
import { DEFAULT_EVENT_MAPPINGS } from "./events/default-mappings.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { DEFAULT_SCHEDULES } from "./scheduler/default-schedules.ts";

// ── Application Interface ──────────────────────────────────────────────────

export interface Application {
  readonly config: RuntimeConfig;
  readonly registry: SkillRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly workspace: FileSystemWorkspaceManager;
  readonly client: AnthropicClaudeClient;
  readonly director: MarketingDirector;
  readonly executor: AgentExecutor;
  readonly pipelineEngine: SequentialPipelineEngine;
  readonly queueManager: TaskQueueManager;
  readonly costTracker: CostTracker;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly scheduler: Scheduler;

  start(): Promise<void>;
  shutdown(): Promise<void>;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * Wire all modules together with real implementations.
 * This is the composition root — the single place where dependency injection happens.
 *
 * @param config Runtime configuration (from loadConfig()).
 * @returns Fully wired Application ready to start.
 */
export async function bootstrap(config: RuntimeConfig): Promise<Application> {
  // 1. Logger — first, so all subsequent modules can log
  const logger = createLogger({
    level: config.logging.level,
    format: config.logging.format,
    base: { module: "bootstrap" },
  });

  logger.info("Bootstrapping application", {
    workspaceDir: config.workspace.rootDir,
    redisHost: config.redis.host,
    redisPort: config.redis.port,
    maxParallelAgents: config.maxParallelAgents,
  });

  // 2. Skill Registry — load from .agents/skills.yaml
  //    Registry is propagated to Director, GoalDecomposer, and PipelineFactory
  //    so they read skill metadata (squad map, dependency graph, foundation skill)
  //    from YAML instead of hardcoded defaults.
  const registryPath = resolve(config.projectRoot, ".agents/skills.yaml");
  const registry = await SkillRegistry.fromYaml(registryPath);
  logger.info("Skill registry loaded", {
    skills: registry.skillNames.length,
    squads: registry.squadNames.length,
    foundation: registry.foundationSkill,
  });

  // 2b. Tool Registry — load from .agents/tools.yaml (optional)
  const toolsPath = resolve(config.projectRoot, ".agents/tools.yaml");
  let toolRegistry: ToolRegistry;
  try {
    toolRegistry = await ToolRegistry.fromYaml(toolsPath);
    logger.info("Tool registry loaded", {
      tools: toolRegistry.toolNames.length,
    });
  } catch (err: unknown) {
    if (
      err instanceof ToolRegistryError &&
      err.errors.some((e) => e.includes("not found"))
    ) {
      toolRegistry = ToolRegistry.empty();
      logger.info("No tools.yaml found, using empty tool registry");
    } else {
      throw err;
    }
  }

  // 3. Workspace
  const workspace = new FileSystemWorkspaceManager({
    rootDir: config.workspace.rootDir,
  });
  await workspace.init();
  logger.info("Workspace initialized", { rootDir: config.workspace.rootDir });

  // 4. Claude client (Anthropic SDK auto-reads ANTHROPIC_API_KEY from env)
  const client = new AnthropicClaudeClient(undefined, logger);

  // 5. Executor config
  const executorConfig: ExecutorConfig = {
    projectRoot: config.projectRoot,
    defaultModel: "sonnet",
    defaultTimeoutMs: 120_000,
    defaultMaxTokens: 8192,
    maxRetries: 3,
    maxContextTokens: 150_000,
  };

  // 6. Agent Executor
  const executor = new AgentExecutor(client, workspace, executorConfig, logger, toolRegistry);

  // 7. Cost Tracker (replaces closure-based budgetProvider)
  const costTracker = new CostTracker({
    budget: {
      totalMonthly: config.budget.totalMonthly,
      warningPercent: 80,
      throttlePercent: 90,
      criticalPercent: 95,
    },
  });

  // 8. Marketing Director
  const director = new MarketingDirector(
    workspace,
    {
      budget: {
        totalMonthly: config.budget.totalMonthly,
        warningPercent: 80,
        throttlePercent: 90,
        criticalPercent: 95,
      },
    },
    client,
    executorConfig,
    undefined,
    logger,
    registry,
  );

  // 9. Pipeline Engine
  const pipelineFactory = new PipelineFactory(PIPELINE_TEMPLATES, registry);
  const pipelineEngine = new SequentialPipelineEngine(
    pipelineFactory,
    executor,
    workspace,
    logger,
  );

  // 10. Redis connection (lazy connect — no TCP until first operation)
  const redis: RedisConnectionManager = await createRedisConnection({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: 3,
    connectTimeout: 5_000,
    lazyConnect: true,
  });
  logger.info("Redis connection created (lazy — will connect on first use)");

  // 11. Worker processor
  const completionRouter = new CompletionRouter(workspace, director, logger);
  const failureTracker = new FailureTracker();
  const processor = createWorkerProcessor({
    workspace,
    executor,
    budgetProvider: () => costTracker.toBudgetState(),
    failureTracker,
    completionRouter,
    logger,
  });

  // 12. BullMQ adapters (real queue and worker)
  const redisConnectionOpts = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: 3,
  };
  const queueName = "marketing-tasks";

  const queueAdapter = new BullMQQueueAdapter(queueName, redisConnectionOpts);
  const workerAdapter = new BullMQWorkerAdapter(
    queueName,
    processor,
    redisConnectionOpts,
    config.maxParallelAgents,
  );

  // 13. Task Queue Manager
  const queueManager = new TaskQueueManager({
    workspace,
    director,
    executor,
    budgetProvider: () => costTracker.toBudgetState(),
    queue: queueAdapter,
    worker: workerAdapter,
    redis,
    config: {
      maxParallelAgents: config.maxParallelAgents,
      fallbackDir: `${config.workspace.rootDir}/queue-fallback`,
    },
    logger,
  });

  // 14. EventBus (needs child logger here — EventBusLogger interface has no .child())
  const eventBus = new EventBus(DEFAULT_EVENT_MAPPINGS, {
    director,
    queueManager,
    logger: logger.child({ module: "event-bus" }),
  });

  // 15. Scheduler
  const scheduler = new Scheduler({
    director,
    workspace,
    logger,
    budgetProvider: () => costTracker.toBudgetState(),
  });

  // 16. Shutdown guard
  let shuttingDown = false;

  // 17. Build Application object
  const app: Application = {
    config,
    registry,
    toolRegistry,
    workspace,
    client,
    director,
    executor,
    pipelineEngine,
    queueManager,
    costTracker,
    logger,
    eventBus,
    scheduler,

    async start(): Promise<void> {
      logger.info("Starting application");
      await queueManager.start();
      logger.info("Queue manager started");
      await scheduler.start(DEFAULT_SCHEDULES);
      logger.info("Scheduler started");
    },

    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("Shutting down application");

      // 1. Stop scheduler first (prevents new work being created)
      try {
        await scheduler.stop();
        logger.info("Scheduler stopped");
      } catch (err: unknown) {
        logger.error("Error stopping scheduler", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. Stop queue manager (stops health checks, closes worker and queue)
      try {
        await queueManager.stop();
        logger.info("Queue manager stopped");
      } catch (err: unknown) {
        logger.error("Error stopping queue manager", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 3. Flush cost data to workspace
      try {
        const metricsDir = `${config.workspace.rootDir}/metrics`;
        await costTracker.flush(metricsDir, {
          mkdir: async (dir: string) => {
            await mkdir(dir, { recursive: true });
          },
          writeFile: async (path: string, content: string) => {
            await writeFile(path, content, "utf-8");
          },
        });
        logger.info("Cost data flushed");
      } catch (err: unknown) {
        logger.error("Error flushing cost data", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 4. Close Redis connection
      try {
        await redis.close();
        logger.info("Redis connection closed");
      } catch (err: unknown) {
        logger.error("Error closing Redis", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 5. Remove signal handlers to prevent accumulation
      process.removeListener("SIGTERM", sigtermHandler);
      process.removeListener("SIGINT", sigintHandler);

      logger.info("Shutdown complete");
    },
  };

  // 18. Signal handlers for graceful shutdown (with dedup guard)
  let signalHandled = false;
  const onSignal = async (signal: string) => {
    if (signalHandled) return;
    signalHandled = true;
    logger.info(`Received ${signal}, initiating graceful shutdown`);
    await app.shutdown();
    process.exit(0);
  };

  const sigtermHandler = () => {
    onSignal("SIGTERM");
  };
  const sigintHandler = () => {
    onSignal("SIGINT");
  };
  process.on("SIGTERM", sigtermHandler);
  process.on("SIGINT", sigintHandler);

  return app;
}
