#!/usr/bin/env bun
/**
 * Configuration validation CLI.
 *
 * Verifies integrity of all YAML config files in .agents/:
 * - skills.yaml  → SkillRegistry
 * - routing.yaml → RoutingRegistry (cross-references skills/squads)
 * - schedules.yaml → ScheduleRegistry
 * - events.yaml → EventRegistry
 * - pipelines.yaml → PipelineTemplateRegistry (cross-references skills)
 * - Each skill has a SKILL.md file
 *
 * Usage: bun run validate-config
 */

import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { SkillRegistry } from "./agents/skill-registry.ts";
import { ToolRegistry } from "./agents/tool-registry.ts";
import { RoutingRegistry } from "./director/routing-registry.ts";
import { ScheduleRegistry } from "./scheduler/schedule-registry.ts";
import { EventRegistry } from "./events/event-registry.ts";
import { PipelineTemplateRegistry } from "./agents/pipeline-template-registry.ts";

const projectRoot = resolve(import.meta.dir, "..");
const agentsDir = resolve(projectRoot, ".agents");

interface ValidationResult {
  file: string;
  status: "ok" | "warning" | "error";
  message: string;
  details?: string[];
}

const results: ValidationResult[] = [];

function ok(file: string, message: string): void {
  results.push({ file, status: "ok", message });
}

function warn(file: string, message: string, details?: string[]): void {
  results.push({ file, status: "warning", message, details });
}

function fail(file: string, message: string, details?: string[]): void {
  results.push({ file, status: "error", message, details });
}

// ── 1. Skills Registry ────────────────────────────────────────────────────────

let registry: SkillRegistry | null = null;
const skillsPath = resolve(agentsDir, "skills.yaml");
try {
  registry = await SkillRegistry.fromYaml(skillsPath);
  ok("skills.yaml", `${registry.skillNames.length} skills, ${registry.squadNames.length} squads loaded`);
} catch (err: unknown) {
  fail("skills.yaml", err instanceof Error ? err.message : String(err));
}

// ── 2. SKILL.md files ────────────────────────────────────────────────────────

if (registry) {
  const missing: string[] = [];
  for (const skill of registry.skillNames) {
    const skillMdPath = resolve(agentsDir, "skills", skill, "SKILL.md");
    try {
      await access(skillMdPath);
    } catch {
      missing.push(skill);
    }
  }
  if (missing.length === 0) {
    ok("SKILL.md", `All ${registry.skillNames.length} skills have SKILL.md files`);
  } else {
    fail("SKILL.md", `${missing.length} skills missing SKILL.md`, missing);
  }
}

// ── 3. Tools Registry ─────────────────────────────────────────────────────────

const toolsPath = resolve(agentsDir, "tools.yaml");
try {
  const toolReg = await ToolRegistry.fromYaml(toolsPath);
  ok("tools.yaml", `${toolReg.toolNames.length} tools loaded`);
} catch (err: unknown) {
  if (err instanceof Error && err.message.includes("not found")) {
    warn("tools.yaml", "Not found (optional — no tool integrations configured)");
  } else {
    fail("tools.yaml", err instanceof Error ? err.message : String(err));
  }
}

// ── 4. Routing Registry ──────────────────────────────────────────────────────

const routingPath = resolve(agentsDir, "routing.yaml");
try {
  const routingReg = await RoutingRegistry.fromYaml(routingPath);
  ok("routing.yaml", `${routingReg.categories.length} goal categories configured`);

  // Cross-validate against skill registry
  if (registry) {
    try {
      routingReg.validateAgainst(
        [...registry.skillNames],
        [...registry.squadNames],
      );
      ok("routing.yaml", "Cross-validation against skills.yaml passed");
    } catch (err: unknown) {
      if (err instanceof Error && "errors" in err) {
        fail("routing.yaml", "Cross-validation failed", (err as any).errors);
      } else {
        fail("routing.yaml", err instanceof Error ? err.message : String(err));
      }
    }
  }
} catch (err: unknown) {
  if (err instanceof Error && err.message.includes("not found")) {
    warn("routing.yaml", "Not found (using hardcoded ROUTING_RULES fallback)");
  } else {
    fail("routing.yaml", err instanceof Error ? err.message : String(err));
  }
}

// ── 5. Schedules Registry ────────────────────────────────────────────────────

const schedulesPath = resolve(agentsDir, "schedules.yaml");
try {
  const schedReg = await ScheduleRegistry.fromYaml(schedulesPath);
  ok("schedules.yaml", `${schedReg.schedules.length} schedules loaded`);
} catch (err: unknown) {
  if (err instanceof Error && err.message.includes("not found")) {
    warn("schedules.yaml", "Not found (using DEFAULT_SCHEDULES fallback)");
  } else {
    fail("schedules.yaml", err instanceof Error ? err.message : String(err));
  }
}

// ── 6. Events Registry ──────────────────────────────────────────────────────

const eventsPath = resolve(agentsDir, "events.yaml");
try {
  const eventReg = await EventRegistry.fromYaml(eventsPath);
  ok("events.yaml", `${eventReg.mappings.length} event mappings loaded`);
} catch (err: unknown) {
  if (err instanceof Error && err.message.includes("not found")) {
    warn("events.yaml", "Not found (using DEFAULT_EVENT_MAPPINGS fallback)");
  } else {
    fail("events.yaml", err instanceof Error ? err.message : String(err));
  }
}

// ── 7. Pipelines Registry ──────────────────────────────────────────────────

const pipelinesPath = resolve(agentsDir, "pipelines.yaml");
try {
  const validSkills = registry
    ? new Set(registry.skillNames as string[])
    : undefined;
  const pipeReg = await PipelineTemplateRegistry.fromYaml(pipelinesPath, validSkills);
  ok("pipelines.yaml", `${pipeReg.templates.length} pipeline templates loaded`);

  if (registry) {
    ok("pipelines.yaml", "Skill references validated against skills.yaml");
  }
} catch (err: unknown) {
  if (err instanceof Error && err.message.includes("not found")) {
    warn("pipelines.yaml", "Not found (using PIPELINE_TEMPLATES fallback)");
  } else {
    fail("pipelines.yaml", err instanceof Error ? err.message : String(err));
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("\n=== Configuration Validation ===\n");

const icons = { ok: "\u2713", warning: "!", error: "\u2717" };

for (const r of results) {
  const icon = icons[r.status];
  const prefix = r.status === "error" ? "ERROR" : r.status === "warning" ? "WARN " : "OK   ";
  console.log(`  ${icon} [${prefix}] ${r.file}: ${r.message}`);
  if (r.details) {
    for (const d of r.details) {
      console.log(`           - ${d}`);
    }
  }
}

const errors = results.filter((r) => r.status === "error");
const warnings = results.filter((r) => r.status === "warning");
const oks = results.filter((r) => r.status === "ok");

console.log(`\n  ${oks.length} passed, ${warnings.length} warnings, ${errors.length} errors\n`);

if (errors.length > 0) {
  process.exit(1);
}
