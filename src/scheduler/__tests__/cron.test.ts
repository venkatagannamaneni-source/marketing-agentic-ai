import { describe, expect, it } from "bun:test";
import {
  parseCron,
  cronMatches,
  previousCronMatch,
  CronParseError,
} from "../cron.ts";

// ── parseCron ───────────────────────────────────────────────────────────────

describe("parseCron", () => {
  it("parses every-minute wildcard", () => {
    const fields = parseCron("* * * * *");
    expect(fields.minute).toHaveLength(60);
    expect(fields.hour).toHaveLength(24);
    expect(fields.dayOfMonth).toHaveLength(31);
    expect(fields.month).toHaveLength(12);
    expect(fields.dayOfWeek).toHaveLength(7); // 0-7 with 7→0 dedup = 7 values
  });

  it("parses every-minute wildcard with correct dayOfWeek dedup (0 and 7 → 0)", () => {
    const fields = parseCron("* * * * *");
    // 0-7 range produces 0,1,2,3,4,5,6,7 → 7 mapped to 0 → dedup = 0,1,2,3,4,5,6
    expect(fields.dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("parses daily-social cron: 0 6 * * *", () => {
    const fields = parseCron("0 6 * * *");
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([6]);
    expect(fields.dayOfMonth).toHaveLength(31);
    expect(fields.month).toHaveLength(12);
    expect(fields.dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("parses daily-review cron: 0 9 * * *", () => {
    const fields = parseCron("0 9 * * *");
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([9]);
  });

  it("parses weekly-content cron: 0 0 * * 1 (Monday midnight)", () => {
    const fields = parseCron("0 0 * * 1");
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([0]);
    expect(fields.dayOfWeek).toEqual([1]);
  });

  it("parses weekly-seo cron: 0 0 * * 3 (Wednesday midnight)", () => {
    const fields = parseCron("0 0 * * 3");
    expect(fields.dayOfWeek).toEqual([3]);
  });

  it("parses monthly-cro cron: 0 0 1 * * (1st of month)", () => {
    const fields = parseCron("0 0 1 * *");
    expect(fields.dayOfMonth).toEqual([1]);
  });

  it("parses monthly-review cron: 0 0 15 * * (15th of month)", () => {
    const fields = parseCron("0 0 15 * *");
    expect(fields.dayOfMonth).toEqual([15]);
  });

  // Ranges
  it("parses range: 1-5 in day-of-week", () => {
    const fields = parseCron("0 0 * * 1-5");
    expect(fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses range: 9-17 in hours", () => {
    const fields = parseCron("0 9-17 * * *");
    expect(fields.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  // Steps
  it("parses step: */15 in minutes", () => {
    const fields = parseCron("*/15 * * * *");
    expect(fields.minute).toEqual([0, 15, 30, 45]);
  });

  it("parses step: */5 in minutes", () => {
    const fields = parseCron("*/5 * * * *");
    expect(fields.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it("parses range with step: 1-5/2 in day-of-week", () => {
    const fields = parseCron("0 0 * * 1-5/2");
    expect(fields.dayOfWeek).toEqual([1, 3, 5]);
  });

  it("parses range with step: 0-30/10 in minutes", () => {
    const fields = parseCron("0-30/10 * * * *");
    expect(fields.minute).toEqual([0, 10, 20, 30]);
  });

  // Lists
  it("parses list: 1,3,5 in day-of-week", () => {
    const fields = parseCron("0 0 * * 1,3,5");
    expect(fields.dayOfWeek).toEqual([1, 3, 5]);
  });

  it("parses list: 0,30 in minutes", () => {
    const fields = parseCron("0,30 * * * *");
    expect(fields.minute).toEqual([0, 30]);
  });

  // Combined pattern
  it("parses complex: 0,30 9-17 * * 1-5", () => {
    const fields = parseCron("0,30 9-17 * * 1-5");
    expect(fields.minute).toEqual([0, 30]);
    expect(fields.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  // Day-of-week 7 → 0
  it("treats day-of-week 7 as Sunday (0)", () => {
    const fields = parseCron("0 0 * * 7");
    expect(fields.dayOfWeek).toEqual([0]);
  });

  it("deduplicates when both 0 and 7 present", () => {
    const fields = parseCron("0 0 * * 0,7");
    expect(fields.dayOfWeek).toEqual([0]);
  });

  // Step from single value
  it("parses step from single value: 10/5 in minutes", () => {
    const fields = parseCron("10/5 * * * *");
    // 10, 15, 20, 25, ..., 55
    expect(fields.minute).toEqual([10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  // Month field
  it("parses specific months: 1,6,12", () => {
    const fields = parseCron("0 0 1 1,6,12 *");
    expect(fields.month).toEqual([1, 6, 12]);
  });

  // Whitespace handling
  it("handles extra whitespace", () => {
    const fields = parseCron("  0   6   *   *   *  ");
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([6]);
  });

  // ── Error Cases ───────────────────────────────────────────────────────────

  it("throws on empty expression", () => {
    expect(() => parseCron("")).toThrow(CronParseError);
  });

  it("throws on whitespace-only expression", () => {
    expect(() => parseCron("   ")).toThrow(CronParseError);
  });

  it("throws on too few fields", () => {
    expect(() => parseCron("0 6 *")).toThrow(CronParseError);
    try {
      parseCron("0 6 *");
    } catch (err) {
      expect(err).toBeInstanceOf(CronParseError);
      expect((err as CronParseError).message).toContain("Expected 5 fields, got 3");
    }
  });

  it("throws on too many fields", () => {
    expect(() => parseCron("0 6 * * * *")).toThrow(CronParseError);
  });

  it("throws on out-of-range minute", () => {
    expect(() => parseCron("60 * * * *")).toThrow(CronParseError);
  });

  it("throws on out-of-range hour", () => {
    expect(() => parseCron("0 24 * * *")).toThrow(CronParseError);
  });

  it("throws on out-of-range day-of-month (0)", () => {
    expect(() => parseCron("0 0 0 * *")).toThrow(CronParseError);
  });

  it("throws on out-of-range day-of-month (32)", () => {
    expect(() => parseCron("0 0 32 * *")).toThrow(CronParseError);
  });

  it("throws on out-of-range month (0)", () => {
    expect(() => parseCron("0 0 * 0 *")).toThrow(CronParseError);
  });

  it("throws on out-of-range month (13)", () => {
    expect(() => parseCron("0 0 * 13 *")).toThrow(CronParseError);
  });

  it("throws on out-of-range day-of-week (8)", () => {
    expect(() => parseCron("0 0 * * 8")).toThrow(CronParseError);
  });

  it("throws on non-numeric value", () => {
    expect(() => parseCron("abc * * * *")).toThrow(CronParseError);
  });

  it("throws on negative value", () => {
    expect(() => parseCron("-1 * * * *")).toThrow(CronParseError);
  });

  it("throws on inverted range", () => {
    expect(() => parseCron("0 0 * * 5-1")).toThrow(CronParseError);
  });

  it("throws on empty list element", () => {
    expect(() => parseCron("0,,5 * * * *")).toThrow(CronParseError);
  });

  it("preserves expression in error", () => {
    try {
      parseCron("bad cron expr here x");
    } catch (err) {
      expect(err).toBeInstanceOf(CronParseError);
      expect((err as CronParseError).expression).toBe("bad cron expr here x");
    }
  });

  it("preserves field name in error", () => {
    try {
      parseCron("0 25 * * *");
    } catch (err) {
      expect(err).toBeInstanceOf(CronParseError);
      expect((err as CronParseError).field).toBe("hour");
    }
  });
});

// ── cronMatches ─────────────────────────────────────────────────────────────

describe("cronMatches", () => {
  it("matches daily-social at 6:00 AM", () => {
    const fields = parseCron("0 6 * * *");
    // Monday Feb 17 2026 at 6:00 AM
    expect(cronMatches(fields, new Date(2026, 1, 17, 6, 0))).toBe(true);
  });

  it("does not match daily-social at 6:01 AM", () => {
    const fields = parseCron("0 6 * * *");
    expect(cronMatches(fields, new Date(2026, 1, 17, 6, 1))).toBe(false);
  });

  it("does not match daily-social at 7:00 AM", () => {
    const fields = parseCron("0 6 * * *");
    expect(cronMatches(fields, new Date(2026, 1, 17, 7, 0))).toBe(false);
  });

  it("matches weekly-content on Monday at midnight", () => {
    const fields = parseCron("0 0 * * 1");
    // Monday Feb 16 2026 at 00:00
    const monday = new Date(2026, 1, 16, 0, 0);
    expect(monday.getDay()).toBe(1); // Verify it's Monday
    expect(cronMatches(fields, monday)).toBe(true);
  });

  it("does not match weekly-content on Tuesday", () => {
    const fields = parseCron("0 0 * * 1");
    const tuesday = new Date(2026, 1, 17, 0, 0);
    expect(tuesday.getDay()).toBe(2);
    expect(cronMatches(fields, tuesday)).toBe(false);
  });

  it("matches monthly-cro on 1st at midnight", () => {
    const fields = parseCron("0 0 1 * *");
    expect(cronMatches(fields, new Date(2026, 2, 1, 0, 0))).toBe(true); // March 1
  });

  it("does not match monthly-cro on 2nd", () => {
    const fields = parseCron("0 0 1 * *");
    expect(cronMatches(fields, new Date(2026, 2, 2, 0, 0))).toBe(false);
  });

  it("matches monthly-review on 15th at midnight", () => {
    const fields = parseCron("0 0 15 * *");
    expect(cronMatches(fields, new Date(2026, 1, 15, 0, 0))).toBe(true);
  });

  it("matches at midnight", () => {
    const fields = parseCron("0 0 * * *");
    expect(cronMatches(fields, new Date(2026, 0, 1, 0, 0))).toBe(true);
  });

  it("matches at 23:59", () => {
    const fields = parseCron("59 23 * * *");
    expect(cronMatches(fields, new Date(2026, 0, 1, 23, 59))).toBe(true);
  });

  it("matches every-minute wildcard at any time", () => {
    const fields = parseCron("* * * * *");
    expect(cronMatches(fields, new Date(2026, 5, 15, 14, 33))).toBe(true);
  });

  it("matches Sunday with dayOfWeek=0", () => {
    const fields = parseCron("0 0 * * 0");
    const sunday = new Date(2026, 1, 15, 0, 0); // Feb 15, 2026 is Sunday
    expect(sunday.getDay()).toBe(0);
    expect(cronMatches(fields, sunday)).toBe(true);
  });

  it("matches February 28", () => {
    const fields = parseCron("0 0 28 2 *");
    expect(cronMatches(fields, new Date(2026, 1, 28, 0, 0))).toBe(true);
  });

  it("does not match February 29 in non-leap year", () => {
    const fields = parseCron("0 0 29 2 *");
    // Feb 29, 2026 doesn't exist; Date wraps to March 1
    const date = new Date(2026, 1, 29, 0, 0);
    // In JS, new Date(2026, 1, 29) wraps to March 1 since 2026 is not leap year
    expect(cronMatches(fields, date)).toBe(false);
  });
});

// ── previousCronMatch ───────────────────────────────────────────────────────

describe("previousCronMatch", () => {
  it("finds previous daily match (yesterday)", () => {
    const fields = parseCron("0 6 * * *");
    // Current time: Feb 20, 2026 at 10:00
    const now = new Date(2026, 1, 20, 10, 0);
    const match = previousCronMatch(fields, now);
    expect(match).not.toBeNull();
    expect(match!.getFullYear()).toBe(2026);
    expect(match!.getMonth()).toBe(1); // February
    expect(match!.getDate()).toBe(20);
    expect(match!.getHours()).toBe(6);
    expect(match!.getMinutes()).toBe(0);
  });

  it("finds same-day earlier match", () => {
    const fields = parseCron("0 6 * * *");
    // Current time: Feb 20, 2026 at 6:01 — should find 6:00 today
    const now = new Date(2026, 1, 20, 6, 1);
    const match = previousCronMatch(fields, now);
    expect(match).not.toBeNull();
    expect(match!.getDate()).toBe(20);
    expect(match!.getHours()).toBe(6);
    expect(match!.getMinutes()).toBe(0);
  });

  it("finds previous weekly match (last Monday)", () => {
    const fields = parseCron("0 0 * * 1");
    // Current time: Wednesday Feb 18, 2026 — should find Monday Feb 16
    const wed = new Date(2026, 1, 18, 12, 0);
    expect(wed.getDay()).toBe(3); // Wednesday
    const match = previousCronMatch(fields, wed);
    expect(match).not.toBeNull();
    expect(match!.getDate()).toBe(16);
    expect(match!.getDay()).toBe(1); // Monday
    expect(match!.getHours()).toBe(0);
    expect(match!.getMinutes()).toBe(0);
  });

  it("finds previous monthly match", () => {
    const fields = parseCron("0 0 1 * *");
    // Current time: Feb 20, 2026 — should find Feb 1
    const now = new Date(2026, 1, 20, 12, 0);
    const match = previousCronMatch(fields, now);
    expect(match).not.toBeNull();
    expect(match!.getMonth()).toBe(1); // February
    expect(match!.getDate()).toBe(1);
  });

  it("returns null when no match in lookback window", () => {
    const fields = parseCron("0 0 1 * *"); // 1st of month
    // Current time: Jan 2, 2026, lookback only 0 days
    const now = new Date(2026, 0, 2, 12, 0);
    const match = previousCronMatch(fields, now, 0);
    expect(match).toBeNull();
  });

  it("respects lookback limit", () => {
    const fields = parseCron("0 0 15 * *"); // 15th of month
    // Current time: Feb 1, 2026 — last 15th was Jan 15 (17 days ago)
    const now = new Date(2026, 1, 1, 12, 0);
    const match7 = previousCronMatch(fields, now, 7); // 7-day lookback won't find it
    expect(match7).toBeNull();

    const match31 = previousCronMatch(fields, now, 31); // 31-day lookback will
    expect(match31).not.toBeNull();
    expect(match31!.getDate()).toBe(15);
    expect(match31!.getMonth()).toBe(0); // January
  });

  it("handles every-minute cron (finds previous minute)", () => {
    const fields = parseCron("* * * * *");
    const now = new Date(2026, 1, 20, 10, 30);
    const match = previousCronMatch(fields, now);
    expect(match).not.toBeNull();
    expect(match!.getMinutes()).toBe(29);
  });

  it("handles 15-minute step cron", () => {
    const fields = parseCron("*/15 * * * *");
    // Current time: 10:32 — previous matches are 10:30, 10:15, 10:00
    const now = new Date(2026, 1, 20, 10, 32);
    const match = previousCronMatch(fields, now);
    expect(match).not.toBeNull();
    expect(match!.getHours()).toBe(10);
    expect(match!.getMinutes()).toBe(30);
  });

  it("handles boundary: match is exactly at before minus 1 minute", () => {
    const fields = parseCron("0 6 * * *");
    // Before = 6:01 → should match 6:00
    const before = new Date(2026, 1, 20, 6, 1);
    const match = previousCronMatch(fields, before);
    expect(match).not.toBeNull();
    expect(match!.getHours()).toBe(6);
    expect(match!.getMinutes()).toBe(0);
  });

  it("does not return the exact same time as before", () => {
    const fields = parseCron("0 6 * * *");
    // Before = exactly 6:00 → should find yesterday's 6:00, not today's
    const before = new Date(2026, 1, 20, 6, 0);
    const match = previousCronMatch(fields, before);
    expect(match).not.toBeNull();
    expect(match!.getDate()).toBe(19); // Yesterday
    expect(match!.getHours()).toBe(6);
    expect(match!.getMinutes()).toBe(0);
  });
});
