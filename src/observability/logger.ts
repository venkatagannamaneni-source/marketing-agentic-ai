import pino from "pino";

// ── Log Level ───────────────────────────────────────────────────────────────

export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

// ── Log Format ──────────────────────────────────────────────────────────────

export const LOG_FORMATS = ["json", "pretty"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

// ── Logger Config ───────────────────────────────────────────────────────────

export interface LoggerConfig {
  readonly level: LogLevel;
  readonly format: LogFormat;
  readonly base?: Record<string, unknown>;
}

export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  level: "info",
  format: "json",
};

// ── Logger Interface ────────────────────────────────────────────────────────

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ── Log Entry (for BufferLogger) ────────────────────────────────────────────

export interface LogEntry {
  readonly level: LogLevel;
  readonly msg: string;
  readonly data?: Record<string, unknown>;
  readonly timestamp: string;
}

// ── PinoAdapter (wraps pino instance) ───────────────────────────────────────

class PinoAdapter implements Logger {
  constructor(private readonly pinoInstance: pino.Logger) {}

  trace(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pinoInstance.trace(data, msg);
    } else {
      this.pinoInstance.trace(msg);
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pinoInstance.debug(data, msg);
    } else {
      this.pinoInstance.debug(msg);
    }
  }

  info(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pinoInstance.info(data, msg);
    } else {
      this.pinoInstance.info(msg);
    }
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pinoInstance.warn(data, msg);
    } else {
      this.pinoInstance.warn(msg);
    }
  }

  error(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pinoInstance.error(data, msg);
    } else {
      this.pinoInstance.error(msg);
    }
  }

  fatal(msg: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pinoInstance.fatal(data, msg);
    } else {
      this.pinoInstance.fatal(msg);
    }
  }

  child(bindings: Record<string, unknown>): Logger {
    return new PinoAdapter(this.pinoInstance.child(bindings));
  }
}

// ── createLogger Factory ────────────────────────────────────────────────────

export function createLogger(config?: Partial<LoggerConfig>): Logger {
  const merged: LoggerConfig = {
    ...DEFAULT_LOGGER_CONFIG,
    ...config,
  };

  const pinoOptions: pino.LoggerOptions = {
    level: merged.level,
    base: merged.base ?? undefined,
  };

  let instance: pino.Logger;

  if (merged.format === "pretty") {
    instance = pino(pinoOptions, pino.transport({ target: "pino-pretty" }));
  } else {
    instance = pino(pinoOptions);
  }

  return new PinoAdapter(instance);
}

// ── BufferLogger (for testing) ──────────────────────────────────────────────

export class BufferLogger implements Logger {
  readonly entries: LogEntry[] = [];
  private readonly bindings: Record<string, unknown>;

  constructor(bindings?: Record<string, unknown>) {
    this.bindings = bindings ?? {};
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const merged = Object.keys(this.bindings).length > 0
      ? { ...this.bindings, ...data }
      : data;

    this.entries.push({
      level,
      msg,
      data: merged,
      timestamp: new Date().toISOString(),
    });
  }

  trace(msg: string, data?: Record<string, unknown>): void {
    this.log("trace", msg, data);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  fatal(msg: string, data?: Record<string, unknown>): void {
    this.log("fatal", msg, data);
  }

  child(bindings: Record<string, unknown>): BufferLogger {
    const childLogger = new BufferLogger({ ...this.bindings, ...bindings });
    // Share the same entries array so parent can see child's logs
    (childLogger as { entries: LogEntry[] }).entries = this.entries;
    return childLogger;
  }

  clear(): void {
    this.entries.length = 0;
  }

  getByLevel(level: LogLevel): readonly LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  has(level: LogLevel, msgSubstring: string): boolean {
    return this.entries.some(
      (e) => e.level === level && e.msg.includes(msgSubstring),
    );
  }
}
