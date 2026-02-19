# Phase 1 Design: Director + Orchestration Engine

> **Status:** RFC (Request for Comments)
> **Scope:** Weeks 1-4 of the implementation roadmap
> **Deliverable:** A working system where you give the Director a marketing goal and it orchestrates agents to deliver results.

---

## Table of Contents

1. [Goals and Non-Goals](#1-goals-and-non-goals)
2. [Architecture Overview](#2-architecture-overview)
3. [Dependencies](#3-dependencies)
4. [Source Layout](#4-source-layout)
5. [Shared Workspace](#5-shared-workspace)
6. [Core Types](#6-core-types)
7. [Module: Skill Loader](#7-module-skill-loader)
8. [Module: Agent Executor](#8-module-agent-executor)
9. [Module: Workspace Manager](#9-module-workspace-manager)
10. [Module: Pipeline Engine](#10-module-pipeline-engine)
11. [Module: Task Queue](#11-module-task-queue)
12. [Module: Marketing Director](#12-module-marketing-director)
13. [Predefined Pipelines](#13-predefined-pipelines)
14. [Mock Product Context](#14-mock-product-context)
15. [Testing Strategy](#15-testing-strategy)
16. [Build Order (Week-by-Week)](#16-build-order)
17. [Migration to Phase 2](#17-migration-to-phase-2)

---

## 1. Goals and Non-Goals

### Goals

- **G1:** Programmatically invoke any of the 26 marketing skills via the Anthropic TypeScript SDK.
- **G2:** A Marketing Director agent that decomposes high-level goals into phased task plans.
- **G3:** Sequential and parallel pipeline execution — agents chain together and run concurrently where the dependency graph allows.
- **G4:** A priority task queue (P0-P3) with an in-memory implementation that migrates cleanly to BullMQ+Redis.
- **G5:** A Director review loop — read agent outputs, decide approve/revise/reject, iterate or advance.
- **G6:** A file-based shared workspace where agents read each other's outputs.
- **G7:** End-to-end test: goal in → Director plans → agents execute → Director reviews → final output.

### Non-Goals (deferred to Phase 2+)

- **No cron scheduler or event bus** — those are Phase 2 (24/7 runtime).
- **No PostgreSQL** — file-based workspace + in-memory queue is sufficient for Phase 1.
- **No external integrations** — no GA4, CMS, email, or ad platform MCP servers.
- **No web dashboard or API** — CLI-only operation.
- **No Playwright page analysis** — agents produce recommendations, not live page audits.
- **No production deployment** — runs locally via `bun run`.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI ENTRY POINT                          │
│   bun run src/index.ts --goal "Increase signup conversions 20%" │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MARKETING DIRECTOR                           │
│                                                                  │
│  1. Read workspace context (product-marketing-context, memory)  │
│  2. Decompose goal into phased task plan                        │
│  3. For each phase: submit tasks to queue                       │
│  4. Review outputs: approve / revise / reject                   │
│  5. Advance to next phase or iterate                            │
│  6. Write final results + learnings                             │
│                                                                  │
│  Model: claude-opus-4-20250514                                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
         ┌──────────────┐  ┌──────────────┐
         │  TASK QUEUE   │  │  PIPELINE    │
         │  (Priority)   │  │  ENGINE      │
         │               │  │              │
         │  P0 ──────►   │  │  Sequential  │
         │  P1 ──────►   │  │  + Parallel  │
         │  P2 ──────►   │  │  DAG runner  │
         │  P3 ──────►   │  │              │
         └──────┬───────┘  └──────┬───────┘
                │                  │
                └────────┬─────────┘
                         ▼
         ┌─────────────────────────────┐
         │       AGENT EXECUTOR         │
         │                              │
         │  1. Load SKILL.md + refs     │
         │  2. Load product context     │
         │  3. Load task inputs         │
         │  4. Build prompt             │
         │  5. Call Claude API          │
         │  6. Validate output (Zod)    │
         │  7. Write to workspace       │
         │                              │
         │  Model: claude-sonnet-4-20250514│
         └──────────────┬──────────────┘
                        │
                        ▼
         ┌─────────────────────────────┐
         │      SHARED WORKSPACE        │
         │                              │
         │  context/   tasks/   outputs/│
         │  reviews/   metrics/ memory/ │
         └─────────────────────────────┘
```

### Data flow for a single goal

```
1. User provides goal string via CLI
2. Director reads workspace context (product-marketing-context.md, memory/learnings.md)
3. Director calls Claude Opus to decompose goal into a phased plan
4. Director validates the plan against the agent registry
5. For each phase:
   a. Director creates Task objects and submits to queue
   b. Pipeline engine processes tasks (sequential within phase, parallel where allowed)
   c. For each task: Executor loads skill, builds prompt, calls API, writes output
   d. Director reads outputs and reviews each one
   e. If REVISE: re-queue with feedback. If REJECT: re-plan.
   f. If all APPROVED: advance to next phase
6. After all phases complete:
   a. Director writes summary to outputs/
   b. Director appends learnings to memory/learnings.md
   c. Exit with results
```

---

## 3. Dependencies

> **Full rationale:** See [infrastructure-decisions.md](infrastructure-decisions.md) for detailed comparisons and elimination reasoning.

### Production — Install at Phase 1 start

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | `^0.39` | Claude API client |
| `drizzle-orm` | `^0.38` | Type-safe ORM (SQLite now, PostgreSQL later — same schema) |
| `zod` | `^3.24` | Schema validation for agent outputs and task contracts |
| `nanoid` | `^5` | Generate short, URL-safe task IDs |

### Dev — Install at Phase 1 start

| Package | Version | Purpose |
|---------|---------|---------|
| `@types/bun` | latest | Bun type definitions (already installed) |
| `typescript` | `^5` | TypeScript compiler (already peer dep) |
| `drizzle-kit` | latest | Schema migrations and DB push |

### Deferred to Week 3

| Package | Purpose |
|---------|---------|
| `bullmq` | Production task queue (replaces in-memory queue) |
| `ioredis` | Redis client required by BullMQ |

### Database strategy

- **Phase 1:** SQLite via `bun:sqlite` (built-in, zero infrastructure). Drizzle ORM provides the abstraction layer.
- **Phase 2+:** PostgreSQL via `postgres` (postgres.js) or `Bun.sql` (built-in). One-line import change in Drizzle config.
- **Phase 5:** Evaluate Supabase (PostgreSQL + auth + storage + realtime) if the all-in-one platform fits.

### What we do NOT need in Phase 1

- **No Elysia/Hono** — no HTTP server in Phase 1 (CLI-only). Elysia enters in Phase 2 for event bus.
- **No node-cron** — no scheduler in Phase 1
- **No Redis** — in-memory queue for Weeks 1-2, BullMQ+Redis in Week 3
- **No Better Auth** — auth is Phase 5
- **No Stripe** — billing is Phase 5

---

## 4. Source Layout

```
src/
├── types.ts                 # Shared types used across all modules
├── db/
│   ├── schema.ts            # Drizzle schema (tasks, outputs, reviews, metrics, memory)
│   ├── index.ts             # Database connection (bun:sqlite now, postgres later)
│   └── seed.ts              # Seed mock product context for testing
├── config/
│   ├── agents.ts            # Agent registry: 26 agents, squads, model assignment
│   └── pipelines.ts         # 8 predefined pipeline templates
├── workspace/
│   ├── manager.ts           # CRUD operations on workspace (files + DB)
│   └── init.ts              # Create workspace dirs + DB tables on first run
├── skills/
│   └── loader.ts            # Parse SKILL.md frontmatter + body + references/
├── executor/
│   ├── index.ts             # Agent executor: skill + context + task → Claude → output
│   └── prompt-builder.ts    # Assemble the full prompt from skill + context + task
├── director/
│   ├── index.ts             # Director orchestration loop
│   ├── planner.ts           # Goal → phased task plan (calls Claude Opus)
│   └── reviewer.ts          # Output → approve/revise/reject (calls Claude Opus)
├── pipeline/
│   ├── engine.ts            # Run a pipeline: sequential phases, parallel tasks within
│   └── types.ts             # Pipeline and step definitions
├── queue/
│   ├── memory.ts            # In-memory priority queue (Weeks 1-2)
│   ├── bullmq.ts            # BullMQ adapter (Week 3) — same interface
│   └── interface.ts         # Queue interface both implementations satisfy
└── index.ts                 # CLI entry point

drizzle/                     # Generated migrations (from drizzle-kit)
```

### Hybrid storage model

- **SQLite (via Drizzle):** Structured data — task records, execution metrics, reviews, goal plans. Queryable, typed, relational.
- **Filesystem (workspace/):** Markdown content — agent outputs, product context, learnings. Human-readable, diffable, inspectable.
- **Why both?** Task metadata belongs in a database (filter by status, sort by priority, aggregate metrics). Agent outputs are large markdown documents best stored as files (easy to read, diff, and version-control).

---

## 5. Shared Workspace

### Directory structure

```
workspace/
├── context/
│   └── product-marketing-context.md     # Foundation doc (25 agents read this)
├── tasks/
│   └── {task-id}.md                     # Active task assignments
├── outputs/
│   ├── strategy/
│   │   ├── content-strategy/
│   │   ├── pricing-strategy/
│   │   ├── launch-strategy/
│   │   ├── marketing-ideas/
│   │   ├── marketing-psychology/
│   │   └── competitor-alternatives/
│   ├── creative/
│   │   ├── copywriting/
│   │   ├── copy-editing/
│   │   ├── social-content/
│   │   ├── cold-email/
│   │   ├── paid-ads/
│   │   ├── programmatic-seo/
│   │   └── schema-markup/
│   ├── convert/
│   │   ├── page-cro/
│   │   ├── form-cro/
│   │   ├── signup-flow-cro/
│   │   ├── popup-cro/
│   │   └── free-tool-strategy/
│   ├── activate/
│   │   ├── onboarding-cro/
│   │   ├── email-sequence/
│   │   ├── paywall-upgrade-cro/
│   │   └── referral-program/
│   └── measure/
│       ├── analytics-tracking/
│       ├── ab-test-setup/
│       └── seo-audit/
├── reviews/
│   └── {task-id}-review.md              # Agent feedback on each other
├── metrics/
│   └── {date}-report.md                 # Execution metrics
└── memory/
    └── learnings.md                     # Accumulated learnings (append-only)
```

### Storage mapping

| Data | Storage | Rationale |
|------|---------|-----------|
| **Task records** | SQLite (Drizzle) | Queryable — filter by status, priority, agent. Joins with metrics. |
| **Goal plans** | SQLite (Drizzle) | Structured JSON, needs querying by status. |
| **Reviews** | SQLite (Drizzle) | Structured verdicts, needs aggregation (approval rate). |
| **Execution metrics** | SQLite (Drizzle) | Numeric data, needs aggregation (total tokens, cost). |
| **Agent outputs** | Filesystem (markdown) | Large text, human-readable, diffable, inspectable. |
| **Product context** | Filesystem (markdown) | Read by agents as prompt content. Human-editable. |
| **Learnings** | Filesystem (markdown) | Append-only text. Human-readable history. |

### Conventions

- **Output files** are named `{task-id}.md` inside `outputs/{squad}/{skill}/`.
- **Learnings** file is append-only. Each entry is timestamped and attributed.
- **All workspace files are markdown** — human-readable, diffable, version-controllable.
- **SQLite database** lives at `workspace/marketing-agents.db`. Drizzle schema in `src/db/schema.ts`.

---

## 6. Core Types

```typescript
// src/types.ts

import { z } from "zod";

// ─── Agent Registry ───

export type Squad = "strategy" | "creative" | "convert" | "activate" | "measure";

export type AgentId =
  | "content-strategy" | "pricing-strategy" | "launch-strategy"
  | "marketing-ideas" | "marketing-psychology" | "competitor-alternatives"
  | "copywriting" | "copy-editing" | "social-content" | "cold-email"
  | "paid-ads" | "programmatic-seo" | "schema-markup"
  | "page-cro" | "form-cro" | "signup-flow-cro" | "popup-cro" | "free-tool-strategy"
  | "onboarding-cro" | "email-sequence" | "paywall-upgrade-cro" | "referral-program"
  | "analytics-tracking" | "ab-test-setup" | "seo-audit"
  | "product-marketing-context";

export interface AgentConfig {
  id: AgentId;
  squad: Squad | "foundation";
  model: "claude-opus-4-20250514" | "claude-sonnet-4-20250514";
  skillPath: string;        // Relative path to SKILL.md
  referencePaths: string[]; // Relative paths to references/*.md
  description: string;      // From SKILL.md frontmatter
}

// ─── Task Contract (Inter-Agent Protocol) ───

export type Priority = "P0" | "P1" | "P2" | "P3";
export type TaskStatus = "pending" | "queued" | "running" | "completed" | "failed" | "revision_requested";

export const TaskSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  status: z.enum(["pending", "queued", "running", "completed", "failed", "revision_requested"]),

  // Assignment
  assignedBy: z.string(),           // "director" or another agent ID
  goalId: z.string(),               // Parent goal this task belongs to

  // Context
  goal: z.string(),                 // Human-readable goal description
  requirements: z.string(),         // Specific requirements for this task
  inputFiles: z.array(z.string()),  // Paths to files this agent should read
  revisionFeedback: z.string().optional(), // Feedback from Director if revision requested

  // Output
  outputPath: z.string().optional(),   // Where the agent wrote its output
  completedAt: z.string().optional(),  // ISO timestamp

  // Metadata
  createdAt: z.string(),            // ISO timestamp
  pipelineId: z.string().optional(), // Pipeline this task belongs to
  phase: z.number().optional(),      // Phase within the pipeline (0-indexed)
  attempt: z.number().default(1),    // Retry count
  maxAttempts: z.number().default(3),
});

export type Task = z.infer<typeof TaskSchema>;

// ─── Director's Goal Plan ───

export interface GoalPlan {
  goalId: string;
  goal: string;
  phases: PlanPhase[];
  createdAt: string;
}

export interface PlanPhase {
  phase: number;          // 0-indexed
  name: string;           // e.g., "AUDIT", "CREATE", "TEST"
  description: string;    // What this phase accomplishes
  tasks: TaskSpec[];       // Tasks to execute (parallel within phase)
}

export interface TaskSpec {
  agentId: AgentId;
  requirements: string;
  priority: Priority;
  inputFiles: string[];    // Paths relative to workspace/
  dependsOn?: string[];    // Task IDs within the same phase that must complete first
}

// ─── Review Protocol ───

export type ReviewVerdict = "APPROVE" | "REVISE" | "REJECT";

export interface Review {
  taskId: string;
  reviewerId: string;     // "director" or agent ID
  authorAgentId: AgentId;
  verdict: ReviewVerdict;
  findings: string;
  revisionRequests?: string; // If verdict is REVISE
  createdAt: string;
}

// ─── Execution Metrics ───

export interface ExecutionMetrics {
  taskId: string;
  agentId: AgentId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  attempt: number;
  success: boolean;
  error?: string;
}

// ─── Pipeline Types ───

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  trigger: string;         // What triggers this pipeline
  phases: PipelinePhase[];
}

export interface PipelinePhase {
  name: string;
  agents: AgentId[];       // Agents in this phase (run in parallel)
  sequential?: boolean;    // If true, agents run one-at-a-time (default: parallel)
}

// ─── Skill Loader Types ───

export interface ParsedSkill {
  name: string;
  description: string;
  version: string;
  systemPrompt: string;     // The full SKILL.md body (after frontmatter)
  references: SkillReference[];
}

export interface SkillReference {
  filename: string;
  content: string;
}
```

---

## 7. Module: Skill Loader

**Purpose:** Read a SKILL.md file, parse its YAML frontmatter and markdown body, and load all reference files. This produces the structured skill definition that the executor uses to build prompts.

**File:** `src/skills/loader.ts`

### Interface

```typescript
/**
 * Load a skill definition from disk.
 *
 * @param skillDir - Absolute path to the skill directory (e.g., .agents/skills/copywriting/)
 * @returns ParsedSkill with frontmatter, body, and reference file contents
 */
export async function loadSkill(skillDir: string): Promise<ParsedSkill>;
```

### Behavior

1. Read `{skillDir}/SKILL.md`
2. Parse YAML frontmatter between `---` delimiters → extract `name`, `description`, `metadata.version`
3. Extract the markdown body (everything after the second `---`)
4. Glob `{skillDir}/references/*.md` → read each file
5. Return `ParsedSkill` with all data assembled

### SKILL.md format (existing, not changing)

```yaml
---
name: copywriting
description: When the user wants to write...
metadata:
  version: 1.0.0
---

# Copywriting

You are an expert conversion copywriter...
[rest of the skill definition]
```

### Edge cases

- Skill directory doesn't exist → throw `SkillNotFoundError`
- No references/ directory → return empty `references` array
- Malformed frontmatter → throw `SkillParseError` with details

---

## 8. Module: Agent Executor

**Purpose:** The atomic unit of work. Takes a task, loads the relevant skill, builds a prompt, calls the Claude API, validates the output, and writes results to the workspace.

**File:** `src/executor/index.ts`

### Interface

```typescript
export interface ExecutorOptions {
  workspacePath: string;       // Absolute path to workspace/
  skillsBasePath: string;      // Absolute path to .agents/skills/
  anthropicApiKey: string;
}

export interface ExecutionResult {
  taskId: string;
  success: boolean;
  outputPath?: string;         // Where the output was written
  output?: string;             // The raw output text
  metrics: ExecutionMetrics;
  error?: string;
}

/**
 * Execute a single agent task.
 */
export async function executeTask(
  task: Task,
  options: ExecutorOptions,
): Promise<ExecutionResult>;
```

### Execution flow

```
1. LOAD SKILL
   skillDir = {skillsBasePath}/{task.agentId}/
   skill = loadSkill(skillDir)

2. LOAD CONTEXT
   productContext = readFile(workspace/context/product-marketing-context.md) or ""
   inputFiles = task.inputFiles.map(f => readFile(workspace/{f}))

3. BUILD PROMPT
   systemPrompt = skill.systemPrompt
     + "\n\n## Reference Materials\n" + skill.references.map(r => r.content).join("\n")

   userPrompt = buildUserPrompt({
     productContext,        // "## Product Marketing Context\n{content}"
     inputFiles,            // "## Input: {filename}\n{content}" for each
     task.requirements,     // "## Your Task\n{requirements}"
     task.revisionFeedback, // "## Revision Feedback\n{feedback}" (if revision)
   })

4. CALL CLAUDE API
   response = anthropic.messages.create({
     model: agentConfig.model,   // sonnet for most, opus for director
     max_tokens: 8192,
     system: systemPrompt,
     messages: [{ role: "user", content: userPrompt }],
   })

5. EXTRACT OUTPUT
   output = response.content[0].text

6. VALIDATE
   - Check that output is non-empty
   - Check that output contains expected markdown structure (H1, H2 headings)
   - If validation fails and attempt < maxAttempts → retry with validation error in prompt
   - If validation fails and attempt >= maxAttempts → return { success: false, error }

7. WRITE TO WORKSPACE
   outputPath = outputs/{squad}/{agentId}/{task.id}.md
   Write output with metadata header:
     ---
     task: {task.id}
     agent: {task.agentId}
     goal: {task.goalId}
     created: {ISO timestamp}
     model: {model used}
     tokens: {input + output tokens}
     ---
     {agent output}

8. RETURN ExecutionResult
   Return { taskId, success: true, outputPath, output, metrics }
```

### Prompt assembly (`src/executor/prompt-builder.ts`)

```typescript
export interface PromptParts {
  productContext: string | null;
  inputContents: Array<{ path: string; content: string }>;
  requirements: string;
  revisionFeedback?: string;
}

/**
 * Build the user message from task context and inputs.
 */
export function buildUserPrompt(parts: PromptParts): string;
```

The prompt structure:

```markdown
## Product Marketing Context

{product-marketing-context.md contents, or "No product context available."}

## Input Files

### {path}
{file contents}

[repeated for each input file]

## Your Task

{requirements from the task}

## Revision Feedback

{revision feedback, if this is a retry}
```

### Token budget management

- Default `max_tokens: 8192` for Sonnet agents
- Director (Opus) gets `max_tokens: 16384` for planning and review
- If output is truncated (`stop_reason: "max_tokens"`), retry once with `max_tokens: 16384`
- Log tokens used per execution for cost tracking

---

## 9. Module: Workspace Manager

**Purpose:** Unified interface for both SQLite (structured data) and filesystem (markdown content). All modules interact with the workspace through this manager — never by writing raw paths or queries directly.

**File:** `src/workspace/manager.ts`

### Interface

```typescript
export interface WorkspaceManager {
  readonly basePath: string;

  // Initialization
  init(): Promise<void>;  // Create directories + DB tables + seed files

  // Context (filesystem)
  readProductContext(): Promise<string | null>;

  // Tasks (SQLite via Drizzle)
  createTask(task: Task): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<void>;
  listTasks(filter?: { status?: TaskStatus; goalId?: string; priority?: Priority }): Promise<Task[]>;

  // Outputs (filesystem for content, SQLite for metadata)
  writeOutput(taskId: string, agentId: AgentId, squad: Squad, content: string): Promise<string>;
  readOutput(path: string): Promise<string | null>;
  listOutputs(filter?: { squad?: Squad; agentId?: AgentId; goalId?: string }): Promise<string[]>;

  // Reviews (SQLite)
  createReview(review: Review): Promise<Review>;
  getReview(taskId: string): Promise<Review | null>;
  listReviews(goalId: string): Promise<Review[]>;

  // Memory (filesystem — append-only)
  appendLearning(entry: string): Promise<void>;
  readLearnings(): Promise<string>;

  // Metrics (SQLite)
  recordMetrics(metrics: ExecutionMetrics): Promise<void>;
  getMetrics(filter?: { goalId?: string; agentId?: AgentId }): Promise<ExecutionMetrics[]>;
  getMetricsSummary(goalId: string): Promise<{
    totalTasks: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    avgDurationMs: number;
  }>;

  // Goal plans (SQLite)
  saveGoalPlan(plan: GoalPlan): Promise<void>;
  getGoalPlan(goalId: string): Promise<GoalPlan | null>;
}
```

### Implementation details

- **SQLite database:** Located at `workspace/marketing-agents.db`. Created by `init()` via Drizzle push.
- **Drizzle schema:** Defined in `src/db/schema.ts`. Tables: `tasks`, `reviews`, `metrics`, `goal_plans`.
- **Filesystem outputs:** Agent markdown output written to `workspace/outputs/{squad}/{skill}/{task-id}.md`. SQLite stores the metadata (path, taskId, agentId, timestamps). File content stays on disk.
- **Concurrency:** For Phase 1, the in-memory queue serializes task execution. SQLite WAL mode enabled for read concurrency. True parallel writes deferred to PostgreSQL in Phase 2.
- **Product context path:** Always `workspace/context/product-marketing-context.md`. If missing, `readProductContext()` returns `null`.

---

## 10. Module: Pipeline Engine

**Purpose:** Execute a sequence of phases. Within each phase, tasks run in parallel (or sequentially if marked). The engine handles the ordering, waits for phase completion, and feeds outputs forward.

**File:** `src/pipeline/engine.ts`

### Interface

```typescript
export interface PipelineRun {
  pipelineId: string;
  goalId: string;
  plan: GoalPlan;
  status: "running" | "completed" | "failed" | "paused";
  currentPhase: number;
  results: Map<string, ExecutionResult>;  // taskId → result
}

export interface PipelineEngineOptions {
  executor: typeof executeTask;
  executorOptions: ExecutorOptions;
  workspace: WorkspaceManager;
  queue: TaskQueue;            // From queue/interface.ts
  maxConcurrency: number;     // Max parallel agents (default: 3)
  onTaskComplete?: (task: Task, result: ExecutionResult) => void;
}

/**
 * Run a goal plan through the pipeline engine.
 */
export async function runPipeline(
  plan: GoalPlan,
  options: PipelineEngineOptions,
): Promise<PipelineRun>;
```

### Execution model

```
For each phase in plan.phases (sequential):
  1. Create Task objects from phase.tasks (using TaskSpec → Task conversion)
  2. Resolve input files:
     - Static inputs (from TaskSpec.inputFiles) → use as-is
     - Dynamic inputs (from previous phase outputs) → look up in results map
  3. Submit all tasks to the queue
  4. Wait for all tasks in this phase to complete (or fail)
  5. If any task failed after max retries → pause pipeline, return for Director review
  6. If all tasks succeeded → advance to next phase

Parallel execution within a phase:
  - Tasks without dependsOn → start immediately (up to maxConcurrency)
  - Tasks with dependsOn → start after their dependencies complete
  - Use Promise.all with a concurrency limiter (simple semaphore)
```

### Concurrency control

```typescript
/**
 * Simple semaphore for limiting concurrent agent executions.
 * Phase 1: in-process concurrency control.
 * Phase 2+: BullMQ handles concurrency natively.
 */
class Semaphore {
  private current = 0;
  private waiting: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void>;
  release(): void;
}
```

---

## 11. Module: Task Queue

**Purpose:** Priority queue for task scheduling. Phase 1 uses an in-memory implementation. Week 3 adds a BullMQ adapter with the same interface.

**File:** `src/queue/interface.ts`

### Interface

```typescript
export interface TaskQueue {
  /**
   * Add a task to the queue. Higher priority tasks are dequeued first.
   * Within the same priority, FIFO ordering.
   */
  enqueue(task: Task): Promise<void>;

  /**
   * Remove and return the highest-priority task.
   * Returns null if queue is empty.
   */
  dequeue(): Promise<Task | null>;

  /**
   * Peek at the next task without removing it.
   */
  peek(): Promise<Task | null>;

  /**
   * Get the current queue length, optionally filtered by priority.
   */
  size(priority?: Priority): Promise<number>;

  /**
   * Get all tasks in the queue (for inspection/debugging).
   */
  list(): Promise<Task[]>;

  /**
   * Remove a specific task from the queue (for cancellation).
   */
  remove(taskId: string): Promise<boolean>;

  /**
   * Pause/resume queue processing.
   */
  pause(): Promise<void>;
  resume(): Promise<void>;
  isPaused(): boolean;
}
```

### In-Memory Implementation (`src/queue/memory.ts`)

```typescript
/**
 * In-memory priority queue using sorted arrays.
 *
 * Priority ordering: P0 > P1 > P2 > P3
 * Within same priority: FIFO (insertion order)
 *
 * Suitable for Phase 1 development and testing.
 * Replaced by BullMQ adapter in Week 3 for persistence and distributed processing.
 */
export class MemoryQueue implements TaskQueue {
  private queues: Record<Priority, Task[]> = {
    P0: [], P1: [], P2: [], P3: [],
  };
  private paused = false;

  // ... implementation
}
```

### BullMQ Adapter (`src/queue/bullmq.ts`) — Week 3

```typescript
/**
 * BullMQ-backed priority queue.
 * Same TaskQueue interface, backed by Redis for persistence and multi-process support.
 *
 * Priority mapping: P0=1, P1=2, P2=3, P3=4 (BullMQ uses ascending priority)
 */
export class BullMQQueue implements TaskQueue {
  private queue: Queue;
  private worker: Worker;

  constructor(redisUrl: string, options?: BullMQQueueOptions);

  // ... implementation satisfying TaskQueue interface
}
```

### Migration path

The `TaskQueue` interface is the contract. All pipeline and director code depends only on the interface, never on a concrete implementation. Switching from `MemoryQueue` to `BullMQQueue` is a one-line change in the entry point:

```typescript
// Week 1-2:
const queue = new MemoryQueue();

// Week 3+:
const queue = new BullMQQueue(process.env.REDIS_URL!);
```

---

## 12. Module: Marketing Director

**Purpose:** The supervisor agent. Receives a marketing goal, decomposes it into a phased plan, orchestrates agent execution via the pipeline engine, reviews outputs, and decides when to iterate vs. ship.

**File:** `src/director/index.ts`

### Interface

```typescript
export interface DirectorOptions {
  workspace: WorkspaceManager;
  pipeline: typeof runPipeline;
  pipelineOptions: PipelineEngineOptions;
  anthropicApiKey: string;
  maxIterations: number;       // Default: 3 — prevent infinite loops
}

export interface GoalResult {
  goalId: string;
  goal: string;
  status: "completed" | "partial" | "failed";
  plan: GoalPlan;
  outputs: Map<string, string>;   // taskId → output path
  reviews: Review[];
  iterations: number;
  summary: string;                // Director's final summary
  learnings: string;              // What the Director learned
  metrics: {
    totalTasks: number;
    tasksApproved: number;
    tasksRevised: number;
    tasksRejected: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}

/**
 * Run the Director on a marketing goal.
 */
export async function runDirector(
  goal: string,
  options: DirectorOptions,
): Promise<GoalResult>;
```

### Director loop

```
1. INITIALIZE
   goalId = nanoid()
   productContext = workspace.readProductContext()
   learnings = workspace.readLearnings()
   iteration = 0

2. PLAN (calls Claude Opus)
   plan = await planGoal(goal, productContext, learnings)
   Validate plan against agent registry (all agentIds must exist)
   Write plan to workspace/tasks/{goalId}-plan.md
   Log: "Director planned {N} phases with {M} total tasks"

3. EXECUTE (pipeline engine)
   for each phase in plan.phases:
     run = await runPipeline(plan, pipelineOptions)

     for each completed task in run.results:
       4. REVIEW (calls Claude Opus)
          review = await reviewOutput(task, output, goal)
          workspace.writeReview(review)

          if review.verdict === "APPROVE":
            continue
          elif review.verdict === "REVISE" && iteration < maxIterations:
            re-queue task with revisionFeedback
            iteration++
          elif review.verdict === "REJECT":
            re-plan this phase with feedback
            iteration++

5. SUMMARIZE (calls Claude Opus)
   summary = synthesize all approved outputs into a goal completion report
   learnings = extract what worked and what didn't

6. PERSIST
   workspace.appendLearning(learnings)
   Write summary to workspace/outputs/{goalId}-summary.md

7. RETURN GoalResult
```

### Planner (`src/director/planner.ts`)

```typescript
/**
 * Decompose a goal into a phased task plan.
 * Uses Claude Opus with knowledge of the agent registry and dependency graph.
 */
export async function planGoal(
  goal: string,
  productContext: string | null,
  learnings: string,
  agentRegistry: AgentConfig[],
  pipelineTemplates: PipelineTemplate[],
): Promise<GoalPlan>;
```

The planner's system prompt includes:
- The full agent registry (names, squads, descriptions)
- The predefined pipeline templates
- The agent dependency graph (from Appendix A of the proposal)
- Decision rules (from Section 3 of the proposal)
- Instructions to output a structured JSON plan conforming to `GoalPlan`

The planner uses **structured output** — we pass a JSON schema to `response_format` to ensure Claude returns valid JSON matching our `GoalPlan` type. If structured output is not available for the model, we parse the response and validate with Zod.

### Reviewer (`src/director/reviewer.ts`)

```typescript
/**
 * Review an agent's output and decide: APPROVE, REVISE, or REJECT.
 */
export async function reviewOutput(
  task: Task,
  output: string,
  goal: string,
  productContext: string | null,
): Promise<Review>;
```

The reviewer's system prompt includes:
- The original goal
- The task requirements
- Quality criteria: completeness, accuracy, brand alignment, actionability
- Instructions to output structured JSON conforming to `Review`

### Director decision rules (encoded in planner system prompt)

```
IF goal is strategic (positioning, pricing, launch planning)
  → Phase 1: Strategy Squad
  → Phase 2: Creative Squad (execution)
  → Phase 3: Measure Squad (tracking)

IF goal is content creation (new pages, emails, ads, social)
  → Phase 1: Strategy Squad (content-strategy)
  → Phase 2: Creative Squad (writing)
  → Phase 3: Creative Squad (copy-editing)
  → Phase 4: Measure Squad (SEO audit, tracking)

IF goal is optimization (improve existing pages, forms, flows)
  → Phase 1: Convert Squad (audit)
  → Phase 2: Creative Squad (rewrites based on audit)
  → Phase 3: Measure Squad (A/B test setup, tracking)

IF goal is retention (churn, activation, upgrades)
  → Phase 1: Activate Squad (strategy)
  → Phase 2: Creative Squad (content for activation)
  → Phase 3: Measure Squad (tracking)

ALWAYS:
  → Measure Squad is the final phase
  → Feed results back to memory/learnings.md
  → If target not met after maxIterations → return partial result
```

---

## 13. Predefined Pipelines

The Director can select and customize these templates rather than planning from scratch. This reduces hallucination risk.

**File:** `src/config/pipelines.ts`

```typescript
export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "content-production",
    name: "Content Production",
    description: "Strategy → Writing → Editing → SEO → Schema",
    trigger: "Weekly schedule or content request",
    phases: [
      { name: "STRATEGIZE", agents: ["content-strategy"] },
      { name: "WRITE", agents: ["copywriting"] },
      { name: "EDIT", agents: ["copy-editing"] },
      { name: "OPTIMIZE", agents: ["seo-audit", "schema-markup"] },
    ],
  },
  {
    id: "page-launch",
    name: "Page Launch",
    description: "Write → CRO audit → A/B test → Track",
    trigger: "New page needed",
    phases: [
      { name: "WRITE", agents: ["copywriting"] },
      { name: "OPTIMIZE", agents: ["page-cro"] },
      { name: "TEST", agents: ["ab-test-setup", "analytics-tracking"] },
    ],
  },
  {
    id: "product-launch",
    name: "Product Launch",
    description: "Launch strategy → Parallel content creation → Review → Measure",
    trigger: "Launch date approaching",
    phases: [
      { name: "PLAN", agents: ["launch-strategy"] },
      { name: "CREATE", agents: ["copywriting", "email-sequence", "social-content", "paid-ads"] },
      { name: "REVIEW", agents: ["copy-editing", "page-cro", "seo-audit", "schema-markup"] },
      { name: "MEASURE", agents: ["analytics-tracking", "ab-test-setup"] },
    ],
  },
  {
    id: "conversion-sprint",
    name: "Conversion Sprint",
    description: "CRO audit → Rewrites → A/B testing → Measure",
    trigger: "Monthly or conversion drop",
    phases: [
      { name: "AUDIT", agents: ["page-cro", "signup-flow-cro"] },
      { name: "REWRITE", agents: ["copywriting", "form-cro", "popup-cro"] },
      { name: "TEST", agents: ["ab-test-setup", "analytics-tracking"] },
    ],
  },
  {
    id: "competitive-response",
    name: "Competitive Response",
    description: "Research competitor → Update copy + pricing → Adjust ads",
    trigger: "Competitor launch detected",
    phases: [
      { name: "RESEARCH", agents: ["competitor-alternatives"] },
      { name: "RESPOND", agents: ["copywriting", "pricing-strategy", "paid-ads"] },
      { name: "MEASURE", agents: ["analytics-tracking"] },
    ],
  },
  {
    id: "retention-sprint",
    name: "Retention Sprint",
    description: "Onboarding → Email sequences → Upgrade optimization → Test",
    trigger: "Churn spike or activation goals",
    phases: [
      { name: "ANALYZE", agents: ["onboarding-cro"] },
      { name: "BUILD", agents: ["email-sequence", "paywall-upgrade-cro"] },
      { name: "TEST", agents: ["ab-test-setup", "analytics-tracking"] },
    ],
  },
  {
    id: "seo-cycle",
    name: "SEO Cycle",
    description: "Audit → Programmatic pages + Schema + Content strategy",
    trigger: "Monthly or ranking drops",
    phases: [
      { name: "AUDIT", agents: ["seo-audit"] },
      { name: "FIX", agents: ["programmatic-seo", "schema-markup", "content-strategy"] },
      { name: "MEASURE", agents: ["analytics-tracking"] },
    ],
  },
  {
    id: "outreach-campaign",
    name: "Outreach Campaign",
    description: "Write cold emails → Test → Track",
    trigger: "New prospect list available",
    phases: [
      { name: "WRITE", agents: ["cold-email"] },
      { name: "TEST", agents: ["ab-test-setup", "analytics-tracking"] },
    ],
  },
];
```

---

## 14. Mock Product Context

For testing the full flow without a real product, we'll create a mock `product-marketing-context.md` for a fictional product. This is used in automated tests and for development.

**File:** `workspace/context/product-marketing-context.md` (created by `workspace.init()` in test mode)

The mock describes a fictional SaaS product ("Acme Analytics" — a developer-focused analytics platform) with all 12 sections filled in:

1. Product overview
2. Target audience
3. Personas (2-3)
4. Problems and pain points
5. Competitive landscape
6. Differentiation
7. Objections
8. Switching dynamics
9. Customer language
10. Brand voice
11. Proof points
12. Goals and targets

This gives every agent enough context to produce meaningful (if fictional) output for testing purposes.

---

## 15. Testing Strategy

### Unit tests

| Module | What to test | Test file |
|--------|-------------|-----------|
| Skill Loader | Parse frontmatter, extract body, load references, handle missing files | `src/skills/loader.test.ts` |
| Prompt Builder | Assemble prompt from parts, handle missing context, handle revision feedback | `src/executor/prompt-builder.test.ts` |
| Workspace Manager | Create dirs, read/write tasks, outputs, reviews, memory append-only | `src/workspace/manager.test.ts` |
| Memory Queue | Priority ordering, FIFO within priority, pause/resume, size/list | `src/queue/memory.test.ts` |
| Agent Registry | All 26 agents registered, squads correct, paths resolve to existing SKILL.md | `src/config/agents.test.ts` |

### Integration tests (require API key)

| Test | What it validates |
|------|------------------|
| **Single agent execution** | Executor loads skill, calls Claude, writes valid output to workspace |
| **Sequential pipeline** | Two agents chain: Agent A output becomes Agent B input |
| **Parallel pipeline** | Three agents run concurrently within one phase |
| **Director planning** | Director decomposes a goal into a valid GoalPlan |
| **Director review** | Director reads an output and produces a valid Review |
| **End-to-end** | Goal → Director → Pipeline → Agents → Review → Summary |

### Test configuration

```typescript
// Use environment variable to control test mode:
// MOCK_API=true  → Skip Claude API calls, use canned responses (fast, free)
// MOCK_API=false → Real API calls (slow, costs money, but validates real behavior)
```

For CI: `MOCK_API=true` (no API costs).
For development: `MOCK_API=false` with a real API key to validate the full flow.

---

## 16. Build Order

### Week 1: Foundation

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Install deps (`@anthropic-ai/sdk`, `zod`, `nanoid`). Create `src/` structure. | Project compiles with `bunx tsc --noEmit` |
| 1 | Implement `src/types.ts` — all shared types and Zod schemas | Types importable across modules |
| 2 | Implement `src/config/agents.ts` — agent registry with all 26 agents | Registry maps agentId → config |
| 2 | Implement `src/skills/loader.ts` — parse SKILL.md + references | `loadSkill()` works on all 26 skills |
| 3 | Implement `src/workspace/manager.ts` + `init.ts` | Workspace directories created, read/write works |
| 3 | Write mock product-marketing-context.md | Realistic test fixture |
| 4 | Implement `src/executor/prompt-builder.ts` | Prompt assembly from parts |
| 4 | Implement `src/executor/index.ts` — full agent executor | Can execute a single agent end-to-end |
| 5 | Unit tests for all Week 1 modules | Tests pass with `bun test` |
| 5 | Integration test: execute `copywriting` agent on mock product | Produces valid marketing copy |

**Week 1 milestone:** Run `bun run src/index.ts --agent copywriting --task "Write homepage copy"` and get structured output written to `workspace/outputs/creative/copywriting/`.

### Week 2: Director + Sequential Pipelines

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Implement `src/queue/interface.ts` + `src/queue/memory.ts` | In-memory priority queue |
| 1 | Implement `src/config/pipelines.ts` — 8 pipeline templates | Templates importable |
| 2 | Implement `src/director/planner.ts` — goal decomposition | Director produces valid GoalPlan from a goal string |
| 3 | Implement `src/pipeline/engine.ts` — sequential execution | Pipeline runs phases in order |
| 4 | Implement `src/director/reviewer.ts` — output review | Director reviews outputs, returns verdict |
| 5 | Implement `src/director/index.ts` — full Director loop | Director plans + executes + reviews |
| 5 | Integration test: Content Production pipeline end-to-end | 4 agents chain in sequence |

**Week 2 milestone:** Run `bun run src/index.ts --goal "Write a blog post about API security"` and get Director-orchestrated output from content-strategy → copywriting → copy-editing → seo-audit.

### Week 3: Parallel Execution + BullMQ

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Add concurrency to pipeline engine (Semaphore) | Multiple agents run in parallel within a phase |
| 2 | Install `bullmq` + `ioredis`. Implement `src/queue/bullmq.ts` | BullMQ adapter satisfies TaskQueue interface |
| 3 | Wire BullMQ into pipeline engine + Director | Queue-backed execution |
| 4 | Integration test: Product Launch pipeline (4 parallel agents in Phase 2) | Parallel execution verified |
| 5 | Stress test: multiple goals queued simultaneously | Queue prioritization works |

**Week 3 milestone:** Product Launch pipeline runs with 4 agents in parallel, backed by Redis queue.

### Week 4: Director Review Loop + E2E

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Implement revision loop in Director | Director sends REVISE → agent retries → Director re-reviews |
| 2 | Implement iteration cap + partial results | maxIterations prevents infinite loops |
| 3 | Implement learnings persistence | Director writes to memory/learnings.md after each goal |
| 4 | Full E2E test: "Increase signup conversions" | Multi-phase, multi-agent, review loop, final summary |
| 5 | Documentation: update CLAUDE.md, write usage guide | Phase 1 complete and documented |

**Week 4 milestone:** Complete system — goal → Director → phased agents → reviews → iterations → final output + learnings.

---

## 17. Migration to Phase 2

Phase 1 is designed to be extended without rewrites:

| Phase 2 Feature | Phase 1 Preparation |
|-----------------|-------------------|
| **Cron scheduler** | Pipeline templates have `trigger` field ready for cron expressions |
| **Event bus** | Pipeline engine accepts external triggers — just add an HTTP listener |
| **PostgreSQL** | Drizzle ORM abstracts the database — change import from `bun-sqlite` to `postgres` and update connection string |
| **Monitoring** | `ExecutionMetrics` type captures all data needed — just add a reporting layer |
| **Budget tracking** | Metrics include `inputTokens` + `outputTokens` — add cost calculation |
| **Health checks** | Queue interface has `isPaused()` — add system-level health endpoint |

The key architectural invariant: **all modules depend on interfaces, not implementations.** Swapping storage backends, queue implementations, or adding new agent types requires no changes to the pipeline engine or Director logic.

### Phase 2+ additions

| Feature | How it plugs in |
|---------|----------------|
| **Elysia HTTP server** | New `src/server.ts` entry point. Exposes webhook endpoints that call `pipeline.run()`. |
| **Better Auth** | Elysia middleware. Auth tables added to Drizzle schema. |
| **Stripe** | Elysia routes for webhook handling. Metering calls added to executor after each API call. |

---

## Appendix: Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...       # Claude API key

# Optional (Week 3+)
REDIS_URL=redis://localhost:6379   # For BullMQ queue

# Development
MOCK_API=true                      # Skip real API calls in tests
WORKSPACE_PATH=./workspace         # Override workspace location
LOG_LEVEL=debug                    # debug | info | warn | error
MAX_CONCURRENCY=3                  # Max parallel agents
DIRECTOR_MAX_ITERATIONS=3          # Max revision cycles per goal
```

---

## Appendix: Finalized Tech Stack

> See [infrastructure-decisions.md](infrastructure-decisions.md) for full rationale and alternatives evaluated.

| Layer | Phase 1 | Phase 2+ | Phase 5 |
|-------|---------|----------|---------|
| **Runtime** | Bun + TypeScript | Bun + TypeScript | Bun + TypeScript |
| **AI SDK** | @anthropic-ai/sdk | @anthropic-ai/sdk | @anthropic-ai/sdk |
| **Database** | SQLite (bun:sqlite) | PostgreSQL (Railway/Neon) | PostgreSQL |
| **ORM** | Drizzle ORM | Drizzle ORM | Drizzle ORM |
| **Queue** | In-memory → BullMQ+Redis | BullMQ + Redis | BullMQ + Redis |
| **HTTP** | CLI only | Elysia | Elysia |
| **Auth** | N/A | N/A | Better Auth |
| **Billing** | N/A | N/A | Stripe |
| **Deploy** | Local | Railway | Railway → Render/Fly.io |
