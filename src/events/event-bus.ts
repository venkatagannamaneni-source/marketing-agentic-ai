import type { SystemEvent, EventType } from "../types/events.ts";
import type { Priority, Task } from "../types/task.ts";

// ── Event Emitter Callback ──────────────────────────────────────────────────
// Used by BudgetGate and FailureTracker to emit events without importing EventBus.

export type EventEmitter = (event: SystemEvent) => void;

// ── Event Mapping ───────────────────────────────────────────────────────────

export interface EventMapping {
  readonly eventType: EventType;
  readonly pipelineTemplate: string;
  readonly priority: Priority;
  readonly condition?: (event: SystemEvent) => boolean;
  readonly cooldownMs?: number;
}

// ── Dependency Interfaces ───────────────────────────────────────────────────
// Minimal interfaces for DI — avoids importing full MarketingDirector/TaskQueueManager.

export interface EventBusDirector {
  startPipeline(
    templateName: string,
    goalDescription: string,
    priority?: Priority,
  ): Promise<{
    readonly tasks: readonly Task[];
    readonly run: { readonly id: string };
  }>;
}

export interface EventBusQueueManager {
  enqueueBatch(tasks: readonly Task[]): Promise<void>;
}

export interface EventBusLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface EventBusDeps {
  readonly director: EventBusDirector;
  readonly queueManager: EventBusQueueManager;
  readonly logger?: EventBusLogger;
}

// ── Emit Result ─────────────────────────────────────────────────────────────

export interface EmitResult {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly pipelinesTriggered: number;
  readonly pipelineIds: readonly string[];
  readonly skippedReasons: readonly string[];
}

// ── Null Logger ─────────────────────────────────────────────────────────────

const NULL_LOGGER: EventBusLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── EventBus ────────────────────────────────────────────────────────────────

export class EventBus {
  private mappings: EventMapping[];
  private readonly cooldownTimestamps = new Map<string, number>();
  private readonly processedEventIds = new Map<string, number>();
  private readonly director: EventBusDirector;
  private readonly queueManager: EventBusQueueManager;
  private readonly logger: EventBusLogger;

  constructor(mappings: readonly EventMapping[], deps: EventBusDeps) {
    this.mappings = [...mappings];
    this.director = deps.director;
    this.queueManager = deps.queueManager;
    this.logger = deps.logger ?? NULL_LOGGER;
  }

  /**
   * Emit a system event. Finds matching mappings, evaluates conditions,
   * checks cooldowns, and triggers pipelines via the Director.
   */
  async emit(event: SystemEvent): Promise<EmitResult> {
    const pipelineIds: string[] = [];
    const skippedReasons: string[] = [];

    // Event ID deduplication — skip if we've already processed this exact event ID
    if (this.processedEventIds.has(event.id)) {
      this.logger.info("Event already processed, skipping", {
        eventId: event.id,
        eventType: event.type,
      });
      return {
        eventId: event.id,
        eventType: event.type,
        pipelinesTriggered: 0,
        pipelineIds: [],
        skippedReasons: [`Duplicate event ID: ${event.id}`],
      };
    }

    // Find all mappings matching this event type
    const matchingMappings = this.mappings.filter(
      (m) => m.eventType === event.type,
    );

    if (matchingMappings.length === 0) {
      this.logger.info("No mappings for event type", {
        eventType: event.type,
      });
      return {
        eventId: event.id,
        eventType: event.type,
        pipelinesTriggered: 0,
        pipelineIds: [],
        skippedReasons: [],
      };
    }

    for (const mapping of matchingMappings) {
      // Check cooldown
      if (mapping.cooldownMs !== undefined) {
        const lastEmit = this.cooldownTimestamps.get(event.type);
        if (lastEmit !== undefined && Date.now() - lastEmit < mapping.cooldownMs) {
          const reason = `Cooldown active for ${event.type} (${mapping.cooldownMs}ms)`;
          this.logger.info(reason, { eventType: event.type });
          skippedReasons.push(reason);
          continue;
        }
      }

      // Evaluate condition
      if (mapping.condition) {
        try {
          const shouldTrigger = mapping.condition(event);
          if (!shouldTrigger) {
            const reason = `Condition not met for ${event.type} → ${mapping.pipelineTemplate}`;
            this.logger.info(reason, { eventType: event.type });
            skippedReasons.push(reason);
            continue;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const reason = `Condition error for ${event.type} → ${mapping.pipelineTemplate}: ${message}`;
          this.logger.warn(reason, { eventType: event.type, error: message });
          skippedReasons.push(reason);
          continue;
        }
      }

      // Trigger pipeline via Director
      const goalDescription = `[Event: ${event.type}] ${JSON.stringify(event.data)}`;
      try {
        const result = await this.director.startPipeline(
          mapping.pipelineTemplate,
          goalDescription,
          mapping.priority,
        );

        // Enqueue the resulting tasks
        if (result.tasks.length > 0) {
          try {
            await this.queueManager.enqueueBatch(result.tasks);
          } catch (enqueueErr: unknown) {
            const message = enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
            this.logger.error(
              `Failed to enqueue tasks for ${mapping.pipelineTemplate}`,
              { eventType: event.type, error: message },
            );
          }
        }

        pipelineIds.push(result.run.id);

        // Update cooldown timestamp after successful trigger
        this.cooldownTimestamps.set(event.type, Date.now());

        this.logger.info("Pipeline triggered", {
          eventType: event.type,
          pipelineTemplate: mapping.pipelineTemplate,
          runId: result.run.id,
          taskCount: result.tasks.length,
        });
      } catch (pipelineErr: unknown) {
        const message = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
        const reason = `Pipeline start failed for ${mapping.pipelineTemplate}: ${message}`;
        this.logger.error(reason, { eventType: event.type, error: message });
        skippedReasons.push(reason);
      }
    }

    // Record this event ID as processed
    this.processedEventIds.set(event.id, Date.now());

    return {
      eventId: event.id,
      eventType: event.type,
      pipelinesTriggered: pipelineIds.length,
      pipelineIds,
      skippedReasons,
    };
  }

  /**
   * Add a new event mapping. Multiple mappings per event type are allowed.
   */
  addMapping(mapping: EventMapping): void {
    this.mappings.push(mapping);
  }

  /**
   * Remove ALL mappings for the given event type.
   */
  removeMappingByEvent(eventType: EventType): void {
    this.mappings = this.mappings.filter((m) => m.eventType !== eventType);
  }

  /**
   * Get current mappings (for inspection/testing).
   */
  getMappings(): readonly EventMapping[] {
    return this.mappings;
  }

  /**
   * Reset all cooldown and deduplication state.
   */
  clearCooldowns(): void {
    this.cooldownTimestamps.clear();
    this.processedEventIds.clear();
  }
}
