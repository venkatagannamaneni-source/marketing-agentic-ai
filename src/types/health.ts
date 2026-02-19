// ── System State ─────────────────────────────────────────────────────────────

export const SYSTEM_STATES = [
  "HEALTHY",
  "DEGRADED",
  "PAUSED",
  "OFFLINE",
] as const;

export type SystemState = (typeof SYSTEM_STATES)[number];

// ── Degradation Levels ───────────────────────────────────────────────────────

export const DEGRADATION_LEVELS = [0, 1, 2, 3, 4] as const;
export type DegradationLevel = (typeof DEGRADATION_LEVELS)[number];

export const DEGRADATION_DESCRIPTIONS: Record<DegradationLevel, string> = {
  0: "Full operation",
  1: "Reduced capacity",
  2: "Essential only",
  3: "Director only",
  4: "Offline",
};

// ── Component Health ─────────────────────────────────────────────────────────

export const COMPONENT_STATUSES = ["healthy", "degraded", "offline"] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export interface ComponentHealth {
  readonly name: string;
  readonly status: ComponentStatus;
  readonly lastCheckedAt: string;
  readonly details: Record<string, unknown>;
}

// ── System Health ────────────────────────────────────────────────────────────

export interface SystemHealth {
  readonly state: SystemState;
  readonly degradationLevel: DegradationLevel;
  readonly components: Record<string, ComponentHealth>;
  readonly activeAgents: number;
  readonly maxParallelAgents: number;
  readonly queueDepth: number;
  readonly lastUpdatedAt: string;
}
