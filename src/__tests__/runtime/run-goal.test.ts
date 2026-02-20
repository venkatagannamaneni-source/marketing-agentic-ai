import { describe, expect, it } from "bun:test";
import { inferCategory } from "../../runtime/run-goal.ts";

describe("inferCategory", () => {
  // ── Content ───────────────────────────────────────────────────────────────
  it('maps "Create content strategy" to content', () => {
    expect(inferCategory("Create content strategy")).toBe("content");
  });

  it('maps "Write blog posts" to content', () => {
    expect(inferCategory("Write blog posts about AI")).toBe("content");
  });

  it('maps "Write article about marketing" to content', () => {
    expect(inferCategory("Write article about marketing trends")).toBe("content");
  });

  it('maps "Improve copy quality" to content', () => {
    // \bcopy\b matches "copy" as a standalone word
    expect(inferCategory("Improve the copy for our homepage")).toBe("content");
  });

  // ── Optimization ──────────────────────────────────────────────────────────
  it('maps "Optimize signup flow" to optimization', () => {
    expect(inferCategory("Optimize the signup flow")).toBe("optimization");
  });

  it('maps "Landing page optimization" to optimization', () => {
    expect(inferCategory("Landing page optimization")).toBe("optimization");
  });

  it('maps "CRO sprint" to optimization', () => {
    expect(inferCategory("Run a CRO sprint")).toBe("optimization");
  });

  it('maps "Signup form improvements" to optimization', () => {
    expect(inferCategory("Improve the signup form")).toBe("optimization");
  });

  // ── Retention ─────────────────────────────────────────────────────────────
  it('maps "Reduce churn" to retention', () => {
    expect(inferCategory("Reduce churn rate")).toBe("retention");
  });

  it('maps "Activation metrics" to retention', () => {
    expect(inferCategory("Improve activation metrics")).toBe("retention");
  });

  it('maps "Email sequence" to retention', () => {
    expect(inferCategory("Create email sequence for new users")).toBe("retention");
  });

  it('maps "Referral program" to retention', () => {
    expect(inferCategory("Build referral program")).toBe("retention");
  });

  it('maps "Retain users" to retention', () => {
    expect(inferCategory("Retain users after trial expires")).toBe("retention");
  });

  // ── Competitive ───────────────────────────────────────────────────────────
  it('maps "Competitor analysis" to competitive', () => {
    expect(inferCategory("Analyze competitor pricing")).toBe("competitive");
  });

  it('maps "Alternative to Hubspot" to competitive', () => {
    // Use a string without "page" to avoid hitting optimization first
    expect(inferCategory("Create alternative to Hubspot")).toBe("competitive");
  });

  it('maps "Product vs competitor" to competitive', () => {
    // "vs" as a word boundary match
    expect(inferCategory("Compare our product vs Mailchimp")).toBe("competitive");
  });

  it('maps "Competitive positioning" to competitive', () => {
    expect(inferCategory("Review competitive positioning")).toBe("competitive");
  });

  // ── Measurement ───────────────────────────────────────────────────────────
  it('maps "Set up analytics" to measurement', () => {
    expect(inferCategory("Set up analytics tracking")).toBe("measurement");
  });

  it('maps "SEO audit" to measurement', () => {
    expect(inferCategory("Run an SEO audit")).toBe("measurement");
  });

  it('maps "A/B test" to measurement', () => {
    // Avoid "page" which triggers optimization first
    expect(inferCategory("Set up A/B test on pricing")).toBe("measurement");
  });

  it('maps "Track conversions" to measurement', () => {
    expect(inferCategory("Track conversions in GA4")).toBe("measurement");
  });

  // ── Strategic (default) ───────────────────────────────────────────────────
  it("defaults to strategic for unrecognized goals", () => {
    expect(inferCategory("General marketing goal")).toBe("strategic");
  });

  it("defaults to strategic for abstract goals", () => {
    expect(inferCategory("Grow the business")).toBe("strategic");
  });

  // ── Case insensitivity ────────────────────────────────────────────────────
  it("is case-insensitive", () => {
    expect(inferCategory("CREATE CONTENT STRATEGY")).toBe("content");
    expect(inferCategory("REDUCE CHURN")).toBe("retention");
  });
});
