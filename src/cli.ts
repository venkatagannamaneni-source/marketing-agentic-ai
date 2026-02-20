import { loadConfig, ConfigError } from "./config.ts";
import { bootstrap } from "./bootstrap.ts";
import { runGoal } from "./runtime/run-goal.ts";
import type { Priority } from "./types/task.ts";
import { PRIORITIES } from "./types/task.ts";

// ── Parsed CLI Arguments ───────────────────────────────────────────────────

export interface ParsedArgs {
  goal: string | null;
  daemon: boolean;
  pipeline: string | null;
  dryRun: boolean;
  priority: Priority;
  help: boolean;
}

// ── Argument Parser ────────────────────────────────────────────────────────

/**
 * Parse CLI arguments into a structured ParsedArgs object.
 *
 * @param argv Arguments after the script name (e.g. process.argv.slice(2))
 * @throws Error if arguments are invalid
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    goal: null,
    daemon: false,
    pipeline: null,
    dryRun: false,
    priority: "P2",
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
    } else if (arg === "--daemon") {
      result.daemon = true;
      i++;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
      i++;
    } else if (arg === "--pipeline") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--pipeline requires a template name argument");
      }
      result.pipeline = value;
      i += 2;
    } else if (arg === "--priority") {
      const value = argv[i + 1];
      if (!value || !(PRIORITIES as readonly string[]).includes(value)) {
        throw new Error(
          `--priority must be one of: ${PRIORITIES.join(", ")}`,
        );
      }
      result.priority = value as Priority;
      i += 2;
    } else if (!arg.startsWith("--")) {
      // Positional argument = goal string
      result.goal = arg;
      i++;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return result;
}

// ── Help Text ──────────────────────────────────────────────────────────────

const HELP_TEXT = `
Marketing Agentic AI — Phase 2 Runtime

Usage:
  bun run start "goal description"           Run a single goal to completion
  bun run start --pipeline "Template Name"   Run a named pipeline template
  bun run start --daemon                     Start 24/7 runtime

Options:
  --priority P0|P1|P2|P3    Set goal priority (default: P2)
  --dry-run                  Show plan without executing
  --help, -h                 Show this help message

Examples:
  bun run start "Increase signup conversion by 20%"
  bun run start --pipeline "Content Production" --priority P1
  bun run start "Create SEO audit" --dry-run
`.trim();

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse arguments
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("Run with --help for usage information.");
    process.exit(1);
    return;
  }

  // Help mode
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
    return;
  }

  // Validate exactly one mode is selected
  const modes = [
    args.goal !== null,
    args.daemon,
    args.pipeline !== null,
  ].filter(Boolean);

  if (modes.length === 0) {
    console.error(
      "Error: Provide a goal string, --pipeline, or --daemon",
    );
    console.error(HELP_TEXT);
    process.exit(1);
    return;
  }

  if (modes.length > 1) {
    console.error(
      "Error: Cannot combine goal, --pipeline, and --daemon. Choose one.",
    );
    process.exit(1);
    return;
  }

  // Load config
  let config;
  try {
    config = loadConfig();
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
    } else {
      console.error(
        `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exit(1);
    return;
  }

  // Bootstrap application
  const app = await bootstrap(config);

  try {
    // ── Daemon Mode ──────────────────────────────────────────────────────
    if (args.daemon) {
      app.logger.info(
        "Starting in daemon mode (queue worker foreground). Scheduler + EventBus deferred to WS3/WS4.",
      );
      await app.start();
      app.logger.info("Worker running. Press Ctrl+C to stop.");
      // BullMQ Worker keeps the event loop alive.
      return;
    }

    // ── Pipeline Mode ────────────────────────────────────────────────────
    if (args.pipeline) {
      app.logger.info("Starting pipeline", {
        template: args.pipeline,
        priority: args.priority,
      });
      await app.start();

      try {
        const result = await app.director.startPipeline(
          args.pipeline,
          `Run pipeline: ${args.pipeline}`,
          args.priority,
        );

        app.logger.info("Pipeline started", {
          definitionId: result.definition.id,
          runId: result.run.id,
          taskCount: result.tasks.length,
        });

        // Enqueue tasks for processing
        await app.queueManager.enqueueBatch(result.tasks);
        app.logger.info("Pipeline tasks enqueued. Worker will process them.");
      } catch (err: unknown) {
        app.logger.error("Pipeline failed", {
          template: args.pipeline,
          error: err instanceof Error ? err.message : String(err),
        });
        await app.shutdown();
        process.exit(1);
        return;
      }

      await app.shutdown();
      process.exit(0);
      return;
    }

    // ── Single Goal Mode ─────────────────────────────────────────────────
    if (args.goal) {
      app.logger.info("Running goal", {
        goal: args.goal,
        priority: args.priority,
        dryRun: args.dryRun,
      });
      await app.start();

      const result = await runGoal(app, args.goal, {
        priority: args.priority,
        dryRun: args.dryRun,
      });

      // Structured log
      app.logger.info("Goal completed", {
        goalId: result.goalId,
        status: result.status,
        tasksCompleted: result.tasksCompleted,
        tasksFailed: result.tasksFailed,
        totalCost: `$${result.totalCost.toFixed(4)}`,
        phases: result.phases,
        durationMs: result.durationMs,
      });

      // Human-readable summary
      console.log("\n=== Goal Result ===");
      console.log(`Goal ID:    ${result.goalId}`);
      console.log(`Status:     ${result.status}`);
      console.log(
        `Tasks:      ${result.tasksCompleted} completed, ${result.tasksFailed} failed`,
      );
      console.log(`Cost:       $${result.totalCost.toFixed(4)}`);
      console.log(`Phases:     ${result.phases}`);
      console.log(`Duration:   ${(result.durationMs / 1000).toFixed(1)}s`);
      if (result.error) {
        console.log(`Error:      ${result.error}`);
      }

      await app.shutdown();
      process.exit(result.status === "completed" ? 0 : 1);
      return;
    }
  } catch (err: unknown) {
    app.logger.error("Unhandled error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await app.shutdown();
    process.exit(1);
  }
}

// Run only when executed as the entry point (not when imported for testing)
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(
      "Fatal: Failed to start —",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
