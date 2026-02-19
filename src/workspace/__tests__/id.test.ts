import { describe, expect, it } from "bun:test";
import { generateTaskId, generateReviewId, generateRunId } from "../id.ts";

describe("generateTaskId", () => {
  it("includes skill name in the ID", () => {
    const id = generateTaskId("copywriting");
    expect(id).toMatch(/^copywriting-/);
  });

  it("includes date in YYYYMMDD format", () => {
    const id = generateTaskId("page-cro");
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(id).toContain(dateStr);
  });

  it("ends with 6-char hex suffix", () => {
    const id = generateTaskId("seo-audit");
    expect(id).toMatch(/-[0-9a-f]{6}$/);
  });

  it("matches full pattern: {skill}-{YYYYMMDD}-{hex}", () => {
    const id = generateTaskId("competitor-alternatives");
    expect(id).toMatch(/^competitor-alternatives-\d{8}-[0-9a-f]{6}$/);
  });

  it("generates unique IDs across multiple calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTaskId("copywriting"));
    }
    expect(ids.size).toBe(100);
  });

  it("works with all skill names containing hyphens", () => {
    const id = generateTaskId("paywall-upgrade-cro");
    expect(id).toMatch(/^paywall-upgrade-cro-\d{8}-[0-9a-f]{6}$/);
  });
});

describe("generateReviewId", () => {
  it("generates review ID with task ID and index", () => {
    const id = generateReviewId("copywriting-20260219-a1b2c3", 0);
    expect(id).toBe("review-copywriting-20260219-a1b2c3-0");
  });

  it("increments index for multiple reviews", () => {
    const id1 = generateReviewId("task-123", 0);
    const id2 = generateReviewId("task-123", 1);
    expect(id1).toBe("review-task-123-0");
    expect(id2).toBe("review-task-123-1");
  });
});

describe("generateRunId", () => {
  it("includes pipeline ID and timestamp", () => {
    const id = generateRunId("content-production");
    expect(id).toMatch(/^run-content-production-\d+$/);
  });

  it("generates unique IDs (timestamp-based)", () => {
    const id1 = generateRunId("test");
    const id2 = generateRunId("test");
    // Same millisecond is possible but unlikely in practice
    expect(id1.startsWith("run-test-")).toBe(true);
    expect(id2.startsWith("run-test-")).toBe(true);
  });
});
