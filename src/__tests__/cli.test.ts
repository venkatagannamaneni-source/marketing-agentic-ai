import { describe, expect, it } from "bun:test";
import { parseArgs } from "../cli.ts";

describe("parseArgs", () => {
  // ── Basic Modes ────────────────────────────────────────────────────────

  it("parses empty args", () => {
    const args = parseArgs([]);
    expect(args.goal).toBeNull();
    expect(args.daemon).toBe(false);
    expect(args.pipeline).toBeNull();
    expect(args.dryRun).toBe(false);
    expect(args.priority).toBe("P2");
    expect(args.help).toBe(false);
  });

  it("parses positional goal string", () => {
    const args = parseArgs(["Increase signup conversion by 20%"]);
    expect(args.goal).toBe("Increase signup conversion by 20%");
  });

  it("parses --daemon flag", () => {
    const args = parseArgs(["--daemon"]);
    expect(args.daemon).toBe(true);
    expect(args.goal).toBeNull();
  });

  it("parses --pipeline with template name", () => {
    const args = parseArgs(["--pipeline", "Content Production"]);
    expect(args.pipeline).toBe("Content Production");
    expect(args.goal).toBeNull();
  });

  it("parses --help flag", () => {
    const args = parseArgs(["--help"]);
    expect(args.help).toBe(true);
  });

  it("parses -h flag", () => {
    const args = parseArgs(["-h"]);
    expect(args.help).toBe(true);
  });

  // ── Options ────────────────────────────────────────────────────────────

  it("parses --dry-run flag", () => {
    const args = parseArgs(["--dry-run", "Create content strategy"]);
    expect(args.dryRun).toBe(true);
    expect(args.goal).toBe("Create content strategy");
  });

  it("parses --priority P0", () => {
    const args = parseArgs(["--priority", "P0", "Critical goal"]);
    expect(args.priority).toBe("P0");
    expect(args.goal).toBe("Critical goal");
  });

  it("parses --priority P1", () => {
    const args = parseArgs(["--priority", "P1", "Goal"]);
    expect(args.priority).toBe("P1");
  });

  it("parses --priority P3", () => {
    const args = parseArgs(["--priority", "P3", "Goal"]);
    expect(args.priority).toBe("P3");
  });

  // ── Combined Flags ─────────────────────────────────────────────────────

  it("parses multiple flags together", () => {
    const args = parseArgs([
      "--priority",
      "P1",
      "--dry-run",
      "Optimize landing page",
    ]);
    expect(args.priority).toBe("P1");
    expect(args.dryRun).toBe(true);
    expect(args.goal).toBe("Optimize landing page");
  });

  // ── Error Cases ────────────────────────────────────────────────────────

  it("throws for --pipeline without template name", () => {
    expect(() => parseArgs(["--pipeline"])).toThrow(
      "--pipeline requires a template name argument",
    );
  });

  it("throws for --pipeline followed by a flag", () => {
    expect(() => parseArgs(["--pipeline", "--dry-run"])).toThrow(
      "--pipeline requires a template name argument",
    );
  });

  it("throws for --priority without value", () => {
    expect(() => parseArgs(["--priority"])).toThrow(
      "--priority must be one of:",
    );
  });

  it("throws for invalid priority value", () => {
    expect(() => parseArgs(["--priority", "P5"])).toThrow(
      "--priority must be one of:",
    );
  });

  it("throws for --priority with non-priority string", () => {
    expect(() => parseArgs(["--priority", "high"])).toThrow(
      "--priority must be one of:",
    );
  });

  it("throws for unknown flag", () => {
    expect(() => parseArgs(["--verbose"])).toThrow("Unknown flag: --verbose");
  });

  it("throws for unknown double-dash flag", () => {
    expect(() => parseArgs(["--output", "file.json"])).toThrow(
      "Unknown flag: --output",
    );
  });
});
