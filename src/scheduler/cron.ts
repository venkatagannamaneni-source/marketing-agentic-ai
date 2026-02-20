// ── Cron Expression Parser ──────────────────────────────────────────────────
//
// Lightweight 5-field standard cron parser.
// Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7)
// Supports: *, literals, ranges (1-5), steps (*/15, 1-5/2), lists (1,3,5)
// Day-of-week: 0 and 7 both mean Sunday.

// ── Types ───────────────────────────────────────────────────────────────────

export interface CronFields {
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dayOfMonth: readonly number[];
  readonly month: readonly number[];
  readonly dayOfWeek: readonly number[];
}

// ── Error ───────────────────────────────────────────────────────────────────

export class CronParseError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "CronParseError";
  }
}

// ── Field Definitions ───────────────────────────────────────────────────────

interface FieldDef {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const FIELD_DEFS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
];

// ── Parse ───────────────────────────────────────────────────────────────────

/**
 * Parse a 5-field cron expression into its component fields.
 * Throws CronParseError for invalid expressions.
 */
export function parseCron(expression: string): CronFields {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new CronParseError("Empty cron expression", expression);
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `Expected 5 fields, got ${parts.length}`,
      expression,
    );
  }

  const parsed = parts.map((part, i) => {
    const def = FIELD_DEFS[i]!;
    return parseField(part!, def, expression);
  });

  // Normalize day-of-week: map 7 → 0 (both mean Sunday)
  const normalizedDow = [...new Set(parsed[4]!.map((v) => (v === 7 ? 0 : v)))].sort(
    (a, b) => a - b,
  );

  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: normalizedDow,
  };
}

/**
 * Parse a single cron field.
 */
function parseField(
  field: string,
  def: FieldDef,
  expression: string,
): readonly number[] {
  const values = new Set<number>();

  // Split on comma for lists
  const parts = field.split(",");
  for (const part of parts) {
    if (!part) {
      throw new CronParseError(
        `Empty value in field "${def.name}"`,
        expression,
        def.name,
      );
    }
    parseFieldPart(part, def, expression, values);
  }

  return [...values].sort((a, b) => a - b);
}

function parseFieldPart(
  part: string,
  def: FieldDef,
  expression: string,
  values: Set<number>,
): void {
  // Check for step: "*/2", "1-5/3", "10/5"
  const stepParts = part.split("/");
  if (stepParts.length > 2) {
    throw new CronParseError(
      `Invalid step expression "${part}" in field "${def.name}"`,
      expression,
      def.name,
    );
  }

  const step = stepParts.length === 2 ? parsePositiveInt(stepParts[1]!, def, expression) : null;
  if (step !== null && step <= 0) {
    throw new CronParseError(
      `Step value must be positive in field "${def.name}", got ${step}`,
      expression,
      def.name,
    );
  }

  const base = stepParts[0]!;

  if (base === "*") {
    // Wildcard: all values, optionally with step
    const effectiveStep = step ?? 1;
    for (let v = def.min; v <= def.max; v += effectiveStep) {
      values.add(v);
    }
    return;
  }

  // Check for range: "1-5"
  if (base.includes("-")) {
    const rangeParts = base.split("-");
    if (rangeParts.length !== 2) {
      throw new CronParseError(
        `Invalid range "${base}" in field "${def.name}"`,
        expression,
        def.name,
      );
    }
    const start = parseIntInRange(rangeParts[0]!, def, expression);
    const end = parseIntInRange(rangeParts[1]!, def, expression);
    if (start > end) {
      throw new CronParseError(
        `Range start ${start} > end ${end} in field "${def.name}"`,
        expression,
        def.name,
      );
    }
    const effectiveStep = step ?? 1;
    for (let v = start; v <= end; v += effectiveStep) {
      values.add(v);
    }
    return;
  }

  // Single value, optionally with step
  const value = parseIntInRange(base, def, expression);
  if (step !== null) {
    // Step from value to max
    for (let v = value; v <= def.max; v += step) {
      values.add(v);
    }
  } else {
    values.add(value);
  }
}

function parseIntInRange(
  raw: string,
  def: FieldDef,
  expression: string,
): number {
  const value = parsePositiveInt(raw, def, expression);
  if (value < def.min || value > def.max) {
    throw new CronParseError(
      `Value ${value} out of range [${def.min}-${def.max}] in field "${def.name}"`,
      expression,
      def.name,
    );
  }
  return value;
}

function parsePositiveInt(
  raw: string,
  def: FieldDef,
  expression: string,
): number {
  if (!/^\d+$/.test(raw)) {
    throw new CronParseError(
      `Non-numeric value "${raw}" in field "${def.name}"`,
      expression,
      def.name,
    );
  }
  return parseInt(raw, 10);
}

// ── Match ───────────────────────────────────────────────────────────────────

/**
 * Check whether a given Date matches a parsed cron schedule.
 */
export function cronMatches(fields: CronFields, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const dayOfWeek = date.getDay(); // 0 = Sunday

  return (
    fields.minute.includes(minute) &&
    fields.hour.includes(hour) &&
    fields.dayOfMonth.includes(dayOfMonth) &&
    fields.month.includes(month) &&
    fields.dayOfWeek.includes(dayOfWeek)
  );
}

// ── Previous Match ──────────────────────────────────────────────────────────

/**
 * Find the most recent Date before `before` that matches the cron.
 * Returns null if no match exists within the lookback window.
 *
 * Uses structured descent: iterate days → hours → minutes for efficiency.
 */
export function previousCronMatch(
  fields: CronFields,
  before: Date,
  lookbackDays: number = 31,
): Date | null {
  // Start from the minute before `before`
  const start = new Date(before);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() - 1);

  const cutoff = new Date(before);
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  // Walk backward day by day, then hour by hour, then minute by minute
  const candidate = new Date(start);

  while (candidate >= cutoff) {
    const month = candidate.getMonth() + 1;
    const dayOfMonth = candidate.getDate();
    const dayOfWeek = candidate.getDay();

    // Check if this day is a potential match
    if (
      fields.month.includes(month) &&
      fields.dayOfMonth.includes(dayOfMonth) &&
      fields.dayOfWeek.includes(dayOfWeek)
    ) {
      // This day matches — find the latest matching hour:minute
      const match = findLatestTimeOnDay(fields, candidate, start);
      if (match) {
        return match;
      }
    }

    // Move to the end of the previous day
    candidate.setDate(candidate.getDate() - 1);
    candidate.setHours(23, 59, 0, 0);
  }

  return null;
}

/**
 * Find the latest matching hour:minute on a given day that is <= upperBound.
 */
function findLatestTimeOnDay(
  fields: CronFields,
  day: Date,
  upperBound: Date,
): Date | null {
  // Iterate hours in descending order
  const sortedHours = [...fields.hour].sort((a, b) => b - a);
  const sortedMinutes = [...fields.minute].sort((a, b) => b - a);

  for (const hour of sortedHours) {
    for (const minute of sortedMinutes) {
      const candidate = new Date(day);
      candidate.setHours(hour, minute, 0, 0);

      if (candidate <= upperBound) {
        return candidate;
      }
    }
  }

  return null;
}
