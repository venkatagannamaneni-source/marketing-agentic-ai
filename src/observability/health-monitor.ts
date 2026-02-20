import type {
  SystemHealth,
  SystemState,
  DegradationLevel,
  ComponentHealth,
} from "../types/health.ts";
import type { BudgetState } from "../director/types.ts";

// ── Health Check Function ───────────────────────────────────────────────────

export type HealthCheckFn = () => Promise<ComponentHealth> | ComponentHealth;

// ── Health Monitor Config ───────────────────────────────────────────────────

export interface HealthMonitorConfig {
  readonly maxParallelAgents: number;
  readonly healthCheckTimeoutMs: number;
}

export const DEFAULT_HEALTH_MONITOR_CONFIG: HealthMonitorConfig = {
  maxParallelAgents: 3,
  healthCheckTimeoutMs: 5_000,
};

// ── Internal Helpers ────────────────────────────────────────────────────────

function createOfflineComponent(
  name: string,
  errorMessage: string,
): ComponentHealth {
  return {
    name,
    status: "offline",
    lastCheckedAt: new Date().toISOString(),
    details: { error: errorMessage },
  };
}

function deriveDegradationLevel(
  components: Record<string, ComponentHealth>,
  budgetState?: BudgetState,
): DegradationLevel {
  const componentValues = Object.values(components);

  // No registered components: healthy (nothing is broken)
  if (componentValues.length === 0) {
    return applyBudgetAdjustment(0, budgetState);
  }

  let offlineCount = 0;
  let degradedCount = 0;

  for (const component of componentValues) {
    if (component.status === "offline") {
      offlineCount += 1;
    } else if (component.status === "degraded") {
      degradedCount += 1;
    }
  }

  let level: DegradationLevel = 0;

  // All components offline
  if (offlineCount === componentValues.length) {
    level = 4;
  } else if (offlineCount >= 2) {
    level = 3;
  } else if (offlineCount === 1) {
    level = 2;
  } else if (degradedCount > 0) {
    level = 1;
  }

  return applyBudgetAdjustment(level, budgetState);
}

function applyBudgetAdjustment(
  currentLevel: DegradationLevel,
  budgetState?: BudgetState,
): DegradationLevel {
  if (!budgetState) return currentLevel;

  let adjusted = currentLevel;

  if (budgetState.level === "exhausted") {
    adjusted = Math.max(adjusted, 3) as DegradationLevel;
  } else if (budgetState.level === "critical") {
    adjusted = Math.max(adjusted, 2) as DegradationLevel;
  }

  return adjusted;
}

function degradationToState(level: DegradationLevel): SystemState {
  switch (level) {
    case 0:
      return "HEALTHY";
    case 1:
    case 2:
      return "DEGRADED";
    case 3:
      return "PAUSED";
    case 4:
      return "OFFLINE";
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── HealthMonitor ───────────────────────────────────────────────────────────

export class HealthMonitor {
  private readonly checks = new Map<string, HealthCheckFn>();
  private readonly config: HealthMonitorConfig;

  constructor(config?: Partial<HealthMonitorConfig>) {
    this.config = {
      ...DEFAULT_HEALTH_MONITOR_CONFIG,
      ...config,
    };
  }

  // ── Registration ────────────────────────────────────────────────────────

  registerComponent(name: string, healthCheck: HealthCheckFn): void {
    this.checks.set(name, healthCheck);
  }

  unregisterComponent(name: string): boolean {
    return this.checks.delete(name);
  }

  getRegisteredComponents(): readonly string[] {
    return [...this.checks.keys()];
  }

  // ── Health Check ────────────────────────────────────────────────────────

  async checkHealth(
    activeAgents: number = 0,
    queueDepth: number = 0,
    budgetState?: BudgetState,
  ): Promise<SystemHealth> {
    const components: Record<string, ComponentHealth> = {};

    if (this.checks.size > 0) {
      const entries = [...this.checks.entries()];

      const results = await Promise.allSettled(
        entries.map(([name, checkFn]) => {
          // Wrap in a promise to handle synchronous throws
          const promise = new Promise<ComponentHealth>((resolve, reject) => {
            try {
              const result = checkFn();
              if (result instanceof Promise) {
                result.then(resolve, reject);
              } else {
                resolve(result);
              }
            } catch (err) {
              reject(err);
            }
          });

          return withTimeout(
            promise,
            this.config.healthCheckTimeoutMs,
            "Health check timed out",
          ).then(
            (health): [string, ComponentHealth] => [name, health],
            (err): [string, ComponentHealth] => [
              name,
              createOfflineComponent(
                name,
                err instanceof Error ? err.message : String(err),
              ),
            ],
          );
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === "fulfilled") {
          const [name, health] = result.value;
          components[name] = health;
        } else {
          // Defensive: should not happen since .then() catches all errors,
          // but never silently lose a component in production
          const [name] = entries[i]!;
          components[name] = createOfflineComponent(
            name,
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          );
        }
      }
    }

    const degradationLevel = deriveDegradationLevel(components, budgetState);
    const state = degradationToState(degradationLevel);

    return {
      state,
      degradationLevel,
      components,
      activeAgents,
      maxParallelAgents: this.config.maxParallelAgents,
      queueDepth,
      lastUpdatedAt: new Date().toISOString(),
    };
  }
}
