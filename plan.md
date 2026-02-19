# Task 3: Agent Executor — Implementation Plan

## Overview

The Agent Executor is the runtime engine that takes a `Task` from the workspace and runs a specialized marketing agent against the Claude API. It bridges the workspace layer (Task 1) and the pipeline engine (Task 4).

**Flow:** Task → Load Skill → Build Prompt → Call Claude API → Write Output → Update Status → Return Result

---

## 1. New Types & Interfaces

### 1.1 `src/executor/types.ts` — Executor-specific types

```typescript
// ── Claude Client Interface ─────────────────────────────────────────────────

interface ClaudeClientConfig {
  apiKey: string;
  baseUrl?: string;        // optional override (for proxies, testing)
  defaultMaxTokens: number; // default: 4096
}

interface ClaudeRequest {
  systemPrompt: string;
  userMessage: string;
  model: string;            // "claude-opus-4-6" | "claude-sonnet-4-5-20250929" | etc.
  maxTokens: number;
  signal?: AbortSignal;     // for Task 5 fail-fast cancellation
}

interface ClaudeResponse {
  content: string;          // the text output
  inputTokens: number;
  outputTokens: number;
  stopReason: "end_turn" | "max_tokens" | "stop_sequence";
}

interface ClaudeClient {
  complete(request: ClaudeRequest): Promise<ClaudeResponse>;
}

// ── Execution Result ────────────────────────────────────────────────────────

type ExecutionStatus = "completed" | "failed";

interface ExecutionResult {
  taskId: string;
  skill: SkillName;
  status: ExecutionStatus;
  outputPath: string | null;  // null on failure
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  durationMs: number;
  error?: ExecutionError;     // present only on failure
}

// ── Execution Errors ────────────────────────────────────────────────────────

type ExecutionErrorCode =
  | "SKILL_NOT_FOUND"        // SKILL.md missing for this skill
  | "CONTEXT_NOT_FOUND"      // product-marketing-context.md missing
  | "INPUT_NOT_FOUND"        // upstream input file from task.inputs missing
  | "API_ERROR"              // Claude API returned an error
  | "API_RATE_LIMITED"       // 429 — rate limited
  | "API_OVERLOADED"         // 529 — API overloaded
  | "API_TIMEOUT"            // request timed out
  | "RESPONSE_EMPTY"         // Claude returned empty content
  | "RESPONSE_TRUNCATED"     // stopReason === "max_tokens"
  | "WORKSPACE_WRITE_FAILED" // failed to write output to workspace
  | "TASK_NOT_EXECUTABLE"    // task status is not pending/assigned/revision
  | "ABORTED"                // AbortSignal triggered (parallel fail-fast)
  | "UNKNOWN";               // unexpected error

class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: ExecutionErrorCode,
    public readonly taskId: string,
    public readonly cause?: Error,
  ) {}
}

// ── Executor Config ─────────────────────────────────────────────────────────

interface ExecutorConfig {
  projectRoot: string;       // for loading SKILL.md files
  modelMap: Record<ModelTier, string>; // maps "opus" → "claude-opus-4-6", etc.
  defaultModelTier: ModelTier; // default: "sonnet"
  defaultTimeoutMs: number;  // default: 120_000 (2 min)
  defaultMaxTokens: number;  // default: 4096
  maxRetries: number;        // default: 2
  retryDelayMs: number;      // base delay for exponential backoff, default: 1000
  retryableErrors: ExecutionErrorCode[]; // default: ["API_ERROR", "API_RATE_LIMITED", "API_OVERLOADED", "API_TIMEOUT"]
}

// ── Skill Content (extends AgentMeta with full body) ────────────────────────

interface SkillContent extends AgentMeta {
  body: string;              // full SKILL.md markdown after frontmatter
  referenceContents: {       // loaded reference file contents
    path: string;
    content: string;
  }[];
}
```

### 1.2 Model Tier → Model ID Mapping

```typescript
const DEFAULT_MODEL_MAP: Record<ModelTier, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};
```

---

## 2. Files to Create

### 2.1 `src/executor/types.ts`
All types listed in Section 1 above. Pure type definitions + the `ExecutionError` class + `DEFAULT_MODEL_MAP` constant.

### 2.2 `src/executor/claude-client.ts`
Two implementations of `ClaudeClient`:

**`AnthropicClaudeClient`** — real implementation:
- Constructor takes `ClaudeClientConfig`
- Creates `new Anthropic({ apiKey })` from `@anthropic-ai/sdk`
- `complete()` method:
  - Calls `this.client.messages.create({ model, max_tokens, system, messages: [{ role: "user", content }] })`
  - Maps response to `ClaudeResponse`
  - Handles `signal` for abort via SDK's built-in abort support
  - Extracts `usage.input_tokens` and `usage.output_tokens`
  - Extracts `stop_reason` → maps to `stopReason`
  - Extracts text content from `response.content[0]` (type "text")

**Edge cases handled:**
- `signal.aborted` already true → throw `ExecutionError("ABORTED")` immediately before calling API
- SDK throws `Anthropic.APIError` → catch and map:
  - `status === 429` → `ExecutionError("API_RATE_LIMITED")`
  - `status === 529` → `ExecutionError("API_OVERLOADED")`
  - `status === 408` or `error.code === "ETIMEDOUT"` → `ExecutionError("API_TIMEOUT")`
  - `status === 401` → `ExecutionError("API_ERROR", "Invalid API key")`
  - `status >= 500` → `ExecutionError("API_ERROR")`
  - Any other → `ExecutionError("API_ERROR")`
- SDK throws `Anthropic.APIConnectionError` → `ExecutionError("API_TIMEOUT")`
- Response has no text content blocks → `ExecutionError("RESPONSE_EMPTY")`
- `AbortError` from SDK → `ExecutionError("ABORTED")`

**`MockClaudeClient`** — for testing:
- Constructor takes an optional response generator: `(request: ClaudeRequest) => ClaudeResponse`
- Default: returns `{ content: "Mock output for {skill}", inputTokens: 100, outputTokens: 200, stopReason: "end_turn" }`
- Stores call history: `calls: ClaudeRequest[]` for assertions
- Supports configurable failure mode: `setError(error: Error)` to simulate API failures
- Supports configurable delay: `setDelay(ms: number)` to simulate latency
- Respects `signal` — if aborted during delay, throws `ExecutionError("ABORTED")`

### 2.3 `src/executor/skill-content-loader.ts`
New function that extends the existing `loadSkillMeta()`:

```typescript
async function loadSkillContent(
  skillName: SkillName,
  projectRoot: string,
): Promise<SkillContent>
```

**What it does:**
1. Calls `loadSkillMeta(skillName, projectRoot)` to get metadata
2. Reads the full SKILL.md file content (raw markdown)
3. Uses `parseFrontmatter()` to extract the `body` (everything after the `---` frontmatter)
4. For each file in `meta.referenceFiles`:
   - Reads the file content
   - Stores as `{ path, content }`
5. Returns `{ ...meta, body, referenceContents }`

**Edge cases:**
- SKILL.md not found → propagates `WorkspaceError("NOT_FOUND")` from `loadSkillMeta()`
- Reference file missing → logs warning (non-fatal), skips that reference. Don't crash the executor because a reference file was deleted. Include successfully loaded references only.
- Reference file read failure (permissions, etc.) → same as above, warn and skip
- Empty body (frontmatter only, no content after `---`) → valid but unusual. Return empty string body. The prompt builder will handle this.

### 2.4 `src/executor/prompt-builder.ts`
Builds the system prompt and user message from loaded skill content + task + context.

```typescript
function buildPrompt(params: {
  skillContent: SkillContent;
  task: Task;
  productContext: string | null;  // null if context doesn't exist
  upstreamOutputs: { path: string; description: string; content: string }[];
}): { systemPrompt: string; userMessage: string }
```

**System prompt assembly:**
```
{skillContent.body}

{for each referenceContent:}
---
## Reference: {filename}
{content}
{end for}
```
The system prompt IS the agent persona — the SKILL.md body contains the role definition, principles, frameworks, and output format.

**User message assembly:**
```
## Product Context
{productContext or "No product marketing context available. Work with the information provided in the task."}

## Task Assignment
- **Task ID:** {task.id}
- **From:** {task.from}
- **Priority:** {task.priority}
- **Goal:** {task.goal}

## Upstream Inputs
{for each upstreamOutput:}
### Input: {description}
Source: {path}

{content}
{end for}
{or "No upstream inputs for this task." if empty}

## Requirements
{task.requirements}

## Output Instructions
- Write your complete output below
- Format: {task.output.format}
- Be thorough and follow the skill guidelines above
```

**Edge cases:**
- No product context (`productContext === null`) → include a note saying context isn't available. Don't fail — some tasks may not need it (e.g., the `product-marketing-context` agent itself creates it).
- No upstream inputs (`upstreamOutputs` is empty) → include "No upstream inputs" message. Many tasks (first in a pipeline) have no inputs.
- Very large product context or upstream outputs → no truncation in this layer. Token limits are the API's concern; the executor will catch `RESPONSE_TRUNCATED`. Future optimization can add context windowing.
- Task requirements are empty → valid edge case (shouldn't happen if validated, but don't crash). Pass empty requirements section.
- Special characters in content → no escaping needed. Claude handles markdown naturally.
- Revision task (task.revisionCount > 0) → append revision context to user message:
  ```
  ## Revision Context
  This is revision #{task.revisionCount}. Previous output was reviewed and changes were requested.
  See the review feedback in the upstream inputs above.
  ```

### 2.5 `src/executor/agent-executor.ts`
The main executor class.

```typescript
class AgentExecutor {
  constructor(
    private readonly client: ClaudeClient,
    private readonly workspace: WorkspaceManager,
    private readonly config: ExecutorConfig,
  )

  async execute(task: Task, options?: {
    signal?: AbortSignal;          // for parallel fail-fast
    agentConfig?: Partial<AgentConfig>; // per-task overrides
  }): Promise<ExecutionResult>
}
```

**Full execution flow (12 steps):**

1. **Validate task is executable**
   - Check `task.status` is one of: `"pending"`, `"assigned"`, `"revision"`
   - If not → return failed `ExecutionResult` with `TASK_NOT_EXECUTABLE`
   - Rationale: prevents re-executing completed/failed/cancelled tasks

2. **Check abort signal**
   - If `signal?.aborted` → return failed result with `ABORTED`
   - Check this before doing any work

3. **Update task status to `"in_progress"`**
   - Call `workspace.updateTaskStatus(task.id, "in_progress")`
   - Marks the task as actively being worked on
   - If workspace write fails → return failed result with `WORKSPACE_WRITE_FAILED`

4. **Start timer**
   - Record `startTime = Date.now()` for `durationMs` calculation

5. **Load skill content**
   - Call `loadSkillContent(task.to, config.projectRoot)`
   - If `SKILL_NOT_FOUND` → update task status to `"failed"`, return failed result
   - The skill name comes from `task.to` (which agent runs this task)

6. **Read product marketing context**
   - Call `workspace.contextExists()` first
   - If exists → `workspace.readContext()` → store as string
   - If not exists AND `task.to !== "product-marketing-context"` → this is a warning, not a failure. Pass `null` to prompt builder. The agent can still work, just without product context.
   - If not exists AND `task.to === "product-marketing-context"` → expected! This agent creates it. Pass `null`.

7. **Read upstream inputs**
   - For each entry in `task.inputs[]`:
     - Try `workspace.readFile(input.path)`
     - If file found → add to `upstreamOutputs[]` with content
     - If file not found → **this is an error**. An upstream task should have produced this file. Update task status to `"failed"`, return failed result with `INPUT_NOT_FOUND` and the missing path.
   - Rationale: if an input is declared, it must exist. Missing inputs indicate a pipeline failure upstream.

8. **Build prompt**
   - Call `buildPrompt({ skillContent, task, productContext, upstreamOutputs })`
   - No failure cases here — it's pure string assembly

9. **Resolve model and config**
   - Determine model tier: `agentConfig?.modelTier ?? config.defaultModelTier`
   - Map to model ID: `config.modelMap[modelTier]`
   - Determine timeout: `agentConfig?.timeoutMs ?? config.defaultTimeoutMs`
   - Determine max tokens: `config.defaultMaxTokens`
   - Determine max retries: `agentConfig?.maxRetries ?? config.maxRetries`

10. **Call Claude API (with retries)**
    - Build `ClaudeRequest` with `{ systemPrompt, userMessage, model, maxTokens, signal }`
    - Execute with retry loop:
      ```
      for attempt = 0 to maxRetries:
        try:
          response = await client.complete(request)
          break
        catch error:
          if error.code NOT in config.retryableErrors → rethrow immediately
          if attempt === maxRetries → rethrow
          if signal?.aborted → throw ABORTED
          wait retryDelayMs * 2^attempt (exponential backoff)
          if signal?.aborted after wait → throw ABORTED
      ```
    - Check abort signal between retries
    - On final failure after all retries exhausted → update task status to `"failed"`, return failed result

11. **Handle response**
    - If `response.stopReason === "max_tokens"`:
      - This is a **warning**, not a failure. The output was truncated.
      - Still write the truncated output (partial work is valuable).
      - Set `error` on `ExecutionResult` with code `RESPONSE_TRUNCATED` (as a warning, not a failure status).
      - Mark task as `"completed"` (the output exists, even if truncated).
    - If `response.content` is empty string or whitespace only:
      - Update task status to `"failed"`
      - Return failed result with `RESPONSE_EMPTY`
    - Otherwise: proceed with writing output

12. **Write output to workspace**
    - Resolve squad from `SKILL_SQUAD_MAP[task.to]`
    - Handle foundation skill (`product-marketing-context`): squad is `null`. Write context file instead:
      - Call `workspace.writeFile("context/product-marketing-context.md", response.content)`
    - For all other skills (squad is not null):
      - Call `workspace.writeOutput(squad, task.to, task.id, response.content)`
    - Update task status to `"completed"`
    - If workspace write fails → update task status to `"failed"`, return failed result with `WORKSPACE_WRITE_FAILED`

**Return `ExecutionResult`:**
```typescript
{
  taskId: task.id,
  skill: task.to,
  status: "completed" | "failed",
  outputPath: the path where output was written (or null on failure),
  tokensUsed: { input: response.inputTokens, output: response.outputTokens, total: sum },
  durationMs: Date.now() - startTime,
  error: present only on failure or warning (RESPONSE_TRUNCATED)
}
```

**Error handling contract:**
- The executor **never throws**. It always returns an `ExecutionResult`.
- All errors are caught internally, task status is updated, and a failed result is returned.
- The only exception: if `signal` is aborted, it returns a failed result with `ABORTED` (does not throw).
- This design makes it safe for the pipeline engine to call — no try/catch needed at the call site.

**Status transition diagram:**
```
pending/assigned/revision → in_progress → completed (success)
pending/assigned/revision → in_progress → failed (any error)
any other status → TASK_NOT_EXECUTABLE (no status change)
```

### 2.6 `src/executor/index.ts`
Barrel exports for the executor module:
```typescript
export { AgentExecutor } from "./agent-executor.ts";
export { AnthropicClaudeClient, MockClaudeClient } from "./claude-client.ts";
export { loadSkillContent } from "./skill-content-loader.ts";
export { buildPrompt } from "./prompt-builder.ts";
export {
  type ClaudeClient,
  type ClaudeClientConfig,
  type ClaudeRequest,
  type ClaudeResponse,
  type ExecutionResult,
  type ExecutionStatus,
  type ExecutorConfig,
  type SkillContent,
  ExecutionError,
  type ExecutionErrorCode,
  DEFAULT_MODEL_MAP,
} from "./types.ts";
```

### 2.7 Update `src/index.ts`
Add executor re-exports to the main barrel.

---

## 3. Files to Modify

### 3.1 `package.json`
Add dependency: `@anthropic-ai/sdk`

### 3.2 `src/index.ts`
Add `export * from "./executor/index.ts";`

---

## 4. Test Files

### 4.1 `src/executor/__tests__/claude-client.test.ts`

**AnthropicClaudeClient tests:**
- Skipped unless `ANTHROPIC_API_KEY` env var is set (integration test)
- If key present: test basic completion with a trivial prompt, verify response shape

**MockClaudeClient tests:**
- Returns configured response
- Records call history (calls array)
- Default response when no generator provided
- Custom response generator works
- `setError()` makes next call throw
- `setDelay()` adds artificial latency
- Respects AbortSignal — aborts during delay
- AbortSignal already aborted → immediate rejection
- Multiple calls accumulate in history

### 4.2 `src/executor/__tests__/skill-content-loader.test.ts`

- Loads a real skill (e.g., "copywriting") and verifies body + referenceContents
- Body is non-empty and does NOT contain frontmatter delimiters
- Reference files are loaded with correct content
- Skill with no references → `referenceContents` is empty array
- Non-existent skill → throws WorkspaceError with NOT_FOUND
- Missing reference file → warns and skips (doesn't fail)

### 4.3 `src/executor/__tests__/prompt-builder.test.ts`

- Builds prompt with full context (skill + product context + upstream inputs)
- System prompt contains SKILL.md body content
- System prompt contains reference content under "Reference:" headings
- User message contains product context
- User message contains task goal, requirements, priority
- User message contains upstream output content with descriptions
- No product context → user message says "No product marketing context available"
- No upstream inputs → user message says "No upstream inputs for this task"
- Revision task (revisionCount > 0) → user message contains "Revision Context" section
- Empty skill body → system prompt is empty string (won't crash)
- Multiple upstream inputs → all appear in user message in order

### 4.4 `src/executor/__tests__/agent-executor.test.ts`

This is the most comprehensive test file. Uses `MockClaudeClient` and `FileSystemWorkspaceManager` (with temp dirs).

**Happy path:**
- Execute a task → status transitions: pending → in_progress → completed
- Output file is written to correct workspace path (`outputs/{squad}/{skill}/{taskId}.md`)
- ExecutionResult has correct fields (taskId, skill, status, outputPath, tokensUsed, durationMs)
- Task status in workspace is "completed" after execution
- Claude client receives correct system prompt (SKILL.md body) and user message (context + requirements)

**Task status edge cases:**
- Task with status "pending" → executes normally
- Task with status "assigned" → executes normally
- Task with status "revision" → executes normally (with revision context in prompt)
- Task with status "completed" → returns failed with TASK_NOT_EXECUTABLE, no API call made
- Task with status "failed" → returns failed with TASK_NOT_EXECUTABLE
- Task with status "cancelled" → returns failed with TASK_NOT_EXECUTABLE
- Task with status "in_progress" → returns failed with TASK_NOT_EXECUTABLE
- Task with status "in_review" → returns failed with TASK_NOT_EXECUTABLE
- Task with status "blocked" → returns failed with TASK_NOT_EXECUTABLE
- Task with status "deferred" → returns failed with TASK_NOT_EXECUTABLE

**Skill loading edge cases:**
- Skill not found (SKILL.md missing) → failed result with SKILL_NOT_FOUND, task status → failed
- Skill with no reference files → executes normally, no references in system prompt

**Context edge cases:**
- Product context exists → included in user message
- Product context does NOT exist, skill is NOT "product-marketing-context" → executes with null context, user message says context unavailable
- Product context does NOT exist, skill IS "product-marketing-context" → executes normally (this agent creates the context)

**Input edge cases:**
- Task has upstream inputs and files exist → content loaded and included in user message
- Task has upstream inputs but file is missing → failed result with INPUT_NOT_FOUND, task status → failed
- Task has no inputs (empty array) → executes normally

**API error edge cases:**
- Claude API returns rate limit (429) → retries with backoff, then fails with API_RATE_LIMITED
- Claude API returns overloaded (529) → retries with backoff, then fails with API_OVERLOADED
- Claude API returns server error (500) → retries, then fails with API_ERROR
- Claude API times out → retries, then fails with API_TIMEOUT
- Claude API returns auth error (401) → fails immediately (no retry) with API_ERROR
- Retry succeeds on second attempt → returns successful result
- All retries exhausted → failed result, task status → failed

**Response edge cases:**
- Empty response content → failed result with RESPONSE_EMPTY
- Whitespace-only response → failed result with RESPONSE_EMPTY
- Response truncated (stopReason "max_tokens") → completed result with RESPONSE_TRUNCATED warning, output still written
- Normal response → completed result, output written

**Output writing edge cases:**
- Normal skill (has squad) → output written to `outputs/{squad}/{skill}/{taskId}.md`
- Foundation skill ("product-marketing-context") → output written to `context/product-marketing-context.md`
- Workspace write fails → failed result with WORKSPACE_WRITE_FAILED, task status → failed

**Abort/cancellation edge cases:**
- Signal already aborted before execution → returns failed with ABORTED immediately, no API call, no status change
- Signal aborted during API call → returns failed with ABORTED
- Signal aborted between retries → returns failed with ABORTED, no further retries
- No signal provided → executes normally (signal is optional)

**Token tracking:**
- ExecutionResult.tokensUsed matches Claude API response usage
- Total = input + output

**Duration tracking:**
- durationMs is approximately correct (within tolerance)

**Retry behavior:**
- Retryable errors (API_ERROR, API_RATE_LIMITED, API_OVERLOADED, API_TIMEOUT) → retried up to maxRetries
- Non-retryable errors (SKILL_NOT_FOUND, INPUT_NOT_FOUND, RESPONSE_EMPTY, etc.) → immediate failure, no retry
- Exponential backoff: delay doubles each attempt (1s, 2s, 4s, ...)

**Config overrides:**
- Per-task agentConfig overrides model tier
- Per-task agentConfig overrides timeout
- Per-task agentConfig overrides maxRetries
- Default config used when no overrides provided

---

## 5. Implementation Order

1. **`src/executor/types.ts`** — types first, everything depends on them
2. **`src/executor/claude-client.ts`** — ClaudeClient interface + both implementations
3. **`src/executor/__tests__/claude-client.test.ts`** — test MockClaudeClient behavior
4. **`src/executor/skill-content-loader.ts`** — extends existing skill-loader
5. **`src/executor/__tests__/skill-content-loader.test.ts`** — test against real SKILL.md files
6. **`src/executor/prompt-builder.ts`** — pure function, no dependencies beyond types
7. **`src/executor/__tests__/prompt-builder.test.ts`** — test prompt assembly
8. **`src/executor/agent-executor.ts`** — the main executor, depends on all above
9. **`src/executor/__tests__/agent-executor.test.ts`** — full integration tests with mock client
10. **`src/executor/index.ts`** — barrel exports
11. **Update `src/index.ts`** — add executor exports
12. **Update `package.json`** — add `@anthropic-ai/sdk`
13. **Run `bun test`** — verify all existing + new tests pass
14. **Run `bunx tsc --noEmit`** — verify no type errors

---

## 6. Dependency Analysis

### What we consume (already built in Task 1):
| Import | From | Used For |
|---|---|---|
| `WorkspaceManager` | `src/workspace/workspace-manager.ts` | Read context, inputs, write outputs, update task status |
| `loadSkillMeta()` | `src/agents/skill-loader.ts` | Load agent metadata |
| `parseFrontmatter()` | `src/workspace/markdown.ts` | Extract SKILL.md body from frontmatter |
| `Task`, `TaskStatus` | `src/types/task.ts` | Task structure and status transitions |
| `SkillName`, `ModelTier`, `AgentConfig`, `AgentMeta` | `src/types/agent.ts` | Agent identification and config |
| `SKILL_SQUAD_MAP` | `src/types/agent.ts` | Resolve squad for output path routing |
| `WorkspaceError` | `src/workspace/errors.ts` | Catch workspace-layer errors |

### What we export (consumed by Tasks 4, 5, and Session B):
| Export | Consumed By | Purpose |
|---|---|---|
| `AgentExecutor` | Pipeline engine (Task 4) | Execute individual pipeline steps |
| `ClaudeClient` interface | Session B Director | Same client interface, different model tier |
| `MockClaudeClient` | All test files | Testing without API keys |
| `ExecutionResult` | Pipeline engine | Check step success/failure |
| `ExecutionError` | Pipeline engine | Error handling and logging |
| `ExecutorConfig` | Pipeline engine, Director | Configuration at startup |
| `buildPrompt()` | Potentially Director | Director may build its own prompts |
| `loadSkillContent()` | Potentially Director | Director may inspect skill capabilities |

### New external dependency:
| Package | Version | Purpose |
|---|---|---|
| `@anthropic-ai/sdk` | latest | Claude API client |

---

## 7. Contract with Session B (Director)

Session B's Director will:
1. Create `Task` objects and write them to workspace
2. Call `executor.execute(task)` or enqueue tasks for the executor
3. Implement the `ReviewHandler` interface (defined in Task 4, not Task 3)
4. Use the same `ClaudeClient` interface but with `modelTier: "opus"`

The executor is **agnostic** to who created the task. It doesn't care if the task came from the Director, the scheduler, or the event bus. It just executes whatever `Task` it receives.

---

## 8. Contract with Task 4 (Pipeline Engine)

The pipeline engine will:
1. Create `Task` objects for each pipeline step
2. Call `executor.execute(task)` for each step
3. Check `ExecutionResult.status` to decide whether to continue or fail
4. Read `ExecutionResult.outputPath` to wire as input to the next step
5. Use `ExecutionResult.tokensUsed` for budget tracking

---

## 9. Timeout Mechanism

The executor enforces timeouts at two levels:

### 9.1 API Call Timeout
- The `ClaudeRequest.signal` (AbortSignal) is passed to the Anthropic SDK's `messages.create()` call
- The SDK natively supports `signal` for request cancellation
- The executor creates a composite signal combining:
  1. A timeout signal: `AbortSignal.timeout(timeoutMs)` — fires after the configured timeout
  2. The caller's signal (if provided): for pipeline fail-fast cancellation
- Use `AbortSignal.any([timeoutSignal, callerSignal])` to combine both (Node 20+ / Bun native)
- If `AbortSignal.any` is unavailable, implement manually with an AbortController that listens to both

### 9.2 Retry Delay Timeout
- Between retries, the executor sleeps for `retryDelayMs * 2^attempt`
- The sleep must be cancellable via the abort signal
- Implementation: `await new Promise((resolve, reject) => { const timer = setTimeout(resolve, delayMs); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new ExecutionError("ABORTED", ...)); }, { once: true }); })`
- If signal is already aborted when entering sleep → reject immediately

---

## 10. `task.output.path` vs Derived Paths

The `Task.output.path` field specifies WHERE the task expects output to be written:
- For normal skills: this will be `outputs/{squad}/{skill}/{taskId}.md`
- For `product-marketing-context`: this will be `context/product-marketing-context.md`

**Design decision:** The executor uses `task.output.path` as the canonical output location. It does NOT independently derive the path. This ensures consistency with whatever path the pipeline engine or Director set when creating the task.

**In `ExecutionResult.outputPath`:** returns `task.output.path` on success. This is the path the pipeline engine uses to wire as input to the next step.

**Write mechanism:**
- If `SKILL_SQUAD_MAP[task.to]` is not null (has squad): call `workspace.writeOutput(squad, skill, taskId, content)`. Verify the resulting path matches `task.output.path`.
- If squad is null (foundation skill): call `workspace.writeFile(task.output.path, content)` directly.

---

## 11. Concurrent Execution Safety

### 11.1 Same task executed twice
- The status check in Step 1 prevents this: once a task moves to `in_progress`, a second `execute()` call with the same task object would still pass (since the in-memory task object still says `pending`). However, `workspace.updateTaskStatus()` performs a read-then-write under lock.
- **Mitigation:** After updating status to `in_progress`, the executor re-reads the task from workspace to confirm it's now `in_progress`. If another executor already changed it, we detect a conflict.
- In practice, Task 4 (pipeline engine) serializes execution, and Task 5 (parallel) uses different tasks per agent. Same-task concurrency shouldn't happen, but we guard against it defensively.

### 11.2 Different tasks executing concurrently
- This is the normal parallel execution case (Task 5)
- Each task writes to a different output path → no file conflicts
- Workspace uses file-level locks for writes → safe
- Product context reads are read-only → no conflicts
- No shared mutable state in the executor class

### 11.3 Executor instance reuse
- The `AgentExecutor` is stateless — safe to reuse across multiple `execute()` calls
- The `ClaudeClient` is stateless — safe to share
- The `WorkspaceManager` handles its own locking

---

## 12. Crash Recovery

If the process crashes mid-execution:

### 12.1 Task stuck in `in_progress`
- The task status was updated to `in_progress` in Step 3 but never transitioned to `completed` or `failed`
- **Recovery strategy**: not the executor's responsibility. The pipeline engine (Task 4) or Director (Session B) should detect stale `in_progress` tasks (e.g., tasks in `in_progress` for longer than `2x timeoutMs`) and either retry or fail them.
- The executor only handles "forward" execution — it never scans for orphaned tasks.

### 12.2 Output partially written
- If the workspace write was interrupted, the file may be incomplete or missing
- File-level locks (from Task 1) prevent corruption from concurrent writes, but can't protect against process crashes mid-write
- **Recovery strategy**: same as above — the pipeline engine should check that the output file exists and is non-empty before wiring it as input to the next step.

### 12.3 Lock files left behind
- The lock module (Task 1) already handles stale locks: locks older than 60 seconds are automatically cleaned up
- No additional handling needed in the executor

---

## 13. ExecutorConfig Factory

Provide a `createDefaultConfig()` helper to reduce boilerplate:

```typescript
function createDefaultConfig(overrides?: Partial<ExecutorConfig>): ExecutorConfig {
  return {
    projectRoot: overrides?.projectRoot ?? process.cwd(),
    modelMap: overrides?.modelMap ?? DEFAULT_MODEL_MAP,
    defaultModelTier: overrides?.defaultModelTier ?? "sonnet",
    defaultTimeoutMs: overrides?.defaultTimeoutMs ?? 120_000,
    defaultMaxTokens: overrides?.defaultMaxTokens ?? 4096,
    maxRetries: overrides?.maxRetries ?? 2,
    retryDelayMs: overrides?.retryDelayMs ?? 1_000,
    retryableErrors: overrides?.retryableErrors ?? [
      "API_ERROR",
      "API_RATE_LIMITED",
      "API_OVERLOADED",
      "API_TIMEOUT",
    ],
  };
}
```

This goes in `src/executor/types.ts` and is exported from the barrel.

---

## 14. AnthropicClaudeClient — Full Implementation Detail

### 14.1 Constructor
```typescript
constructor(config: ClaudeClientConfig) {
  this.client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });
  this.defaultMaxTokens = config.defaultMaxTokens;
}
```

### 14.2 `complete()` Method — Step by Step

1. Check `request.signal?.aborted` → throw `ExecutionError("ABORTED")` if already aborted
2. Build SDK request:
   ```typescript
   const sdkRequest = {
     model: request.model,
     max_tokens: request.maxTokens,
     system: request.systemPrompt,
     messages: [{ role: "user" as const, content: request.userMessage }],
   };
   ```
3. Call API with abort support:
   ```typescript
   const response = await this.client.messages.create(sdkRequest, {
     signal: request.signal,
   });
   ```
4. Extract text content:
   ```typescript
   const textBlocks = response.content.filter(block => block.type === "text");
   if (textBlocks.length === 0) throw new ExecutionError("RESPONSE_EMPTY", ...);
   const content = textBlocks.map(b => b.text).join("\n\n");
   ```
5. Map stop reason:
   ```typescript
   const stopReasonMap: Record<string, ClaudeResponse["stopReason"]> = {
     "end_turn": "end_turn",
     "max_tokens": "max_tokens",
     "stop_sequence": "stop_sequence",
   };
   const stopReason = stopReasonMap[response.stop_reason] ?? "end_turn";
   ```
6. Return `ClaudeResponse`:
   ```typescript
   return {
     content,
     inputTokens: response.usage.input_tokens,
     outputTokens: response.usage.output_tokens,
     stopReason,
   };
   ```

### 14.3 Error Mapping — Full Catch Block

```typescript
catch (error: unknown) {
  if (error instanceof ExecutionError) throw error; // re-throw our own errors

  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 429) throw new ExecutionError("Rate limited", "API_RATE_LIMITED", taskId, error);
    if (status === 529) throw new ExecutionError("API overloaded", "API_OVERLOADED", taskId, error);
    if (status === 401) throw new ExecutionError("Invalid API key", "API_ERROR", taskId, error);
    if (status === 403) throw new ExecutionError("Forbidden", "API_ERROR", taskId, error);
    if (status === 404) throw new ExecutionError("Model not found", "API_ERROR", taskId, error);
    if (status === 408) throw new ExecutionError("Request timeout", "API_TIMEOUT", taskId, error);
    if (status !== undefined && status >= 500) throw new ExecutionError("Server error", "API_ERROR", taskId, error);
    throw new ExecutionError(`API error: ${error.message}`, "API_ERROR", taskId, error);
  }

  if (error instanceof Anthropic.APIConnectionError) {
    throw new ExecutionError("Connection failed", "API_TIMEOUT", taskId, error);
  }

  // AbortError from the SDK when signal is triggered
  if (error instanceof Error && error.name === "AbortError") {
    throw new ExecutionError("Request aborted", "ABORTED", taskId, error);
  }

  // Unknown error
  throw new ExecutionError(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    "UNKNOWN",
    taskId,
    error instanceof Error ? error : undefined,
  );
}
```

Note: The `taskId` in `ExecutionError` is passed as empty string `""` in the Claude client, since the client doesn't know about tasks. The executor wraps client errors with the proper taskId before returning.

---

## 15. MockClaudeClient — Full Implementation Detail

```typescript
class MockClaudeClient implements ClaudeClient {
  readonly calls: ClaudeRequest[] = [];
  private responseGenerator: ((request: ClaudeRequest) => ClaudeResponse) | null;
  private errorToThrow: Error | null = null;
  private delayMs: number = 0;

  constructor(responseGenerator?: (request: ClaudeRequest) => ClaudeResponse) {
    this.responseGenerator = responseGenerator ?? null;
  }

  setError(error: Error): void { this.errorToThrow = error; }
  clearError(): void { this.errorToThrow = null; }
  setDelay(ms: number): void { this.delayMs = ms; }

  async complete(request: ClaudeRequest): Promise<ClaudeResponse> {
    // Check abort
    if (request.signal?.aborted) {
      throw new ExecutionError("Aborted", "ABORTED", "");
    }

    // Simulate delay (cancellable)
    if (this.delayMs > 0) {
      await cancellableSleep(this.delayMs, request.signal);
    }

    // Record call
    this.calls.push(request);

    // Throw configured error
    if (this.errorToThrow) {
      const err = this.errorToThrow;
      this.errorToThrow = null; // one-shot by default
      throw err;
    }

    // Return response
    if (this.responseGenerator) {
      return this.responseGenerator(request);
    }

    return {
      content: `Mock output for task`,
      inputTokens: 100,
      outputTokens: 200,
      stopReason: "end_turn",
    };
  }
}
```

---

## 16. Retry Logic — Detailed Pseudocode

```typescript
private async executeWithRetries(
  request: ClaudeRequest,
  maxRetries: number,
  retryDelayMs: number,
  retryableErrors: ExecutionErrorCode[],
): Promise<ClaudeResponse> {
  let lastError: ExecutionError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await this.client.complete(request);
    } catch (error: unknown) {
      // Wrap non-ExecutionError in UNKNOWN
      const execError = error instanceof ExecutionError
        ? error
        : new ExecutionError(
            error instanceof Error ? error.message : String(error),
            "UNKNOWN",
            "",
            error instanceof Error ? error : undefined,
          );

      lastError = execError;

      // Non-retryable → throw immediately
      if (!retryableErrors.includes(execError.code)) {
        throw execError;
      }

      // ABORTED → throw immediately (never retry aborts)
      if (execError.code === "ABORTED") {
        throw execError;
      }

      // Last attempt → throw
      if (attempt === maxRetries) {
        throw execError;
      }

      // Check signal before sleeping
      if (request.signal?.aborted) {
        throw new ExecutionError("Aborted during retry", "ABORTED", "");
      }

      // Exponential backoff sleep (cancellable)
      const delay = retryDelayMs * Math.pow(2, attempt);
      await cancellableSleep(delay, request.signal);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError ?? new ExecutionError("Retry loop exited unexpectedly", "UNKNOWN", "");
}
```

---

## 17. `cancellableSleep` Utility

Shared between MockClaudeClient and retry logic. Place in `src/executor/utils.ts`:

```typescript
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExecutionError("Aborted", "ABORTED", ""));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ExecutionError("Aborted", "ABORTED", ""));
    }, { once: true });
  });
}
```

This means an additional file: `src/executor/utils.ts`, exported from the barrel.

---

## 18. Output Path Resolution — Detailed Logic

```typescript
private resolveOutputPath(task: Task): string {
  // Use the path specified by the task creator (Director or pipeline engine)
  return task.output.path;
}

private async writeOutput(task: Task, content: string): Promise<void> {
  const squad = SKILL_SQUAD_MAP[task.to];

  if (squad !== null) {
    // Normal skill — use typed workspace method
    await this.workspace.writeOutput(squad, task.to, task.id, content);
  } else {
    // Foundation skill (product-marketing-context) — write directly
    await this.workspace.writeFile(task.output.path, content);
  }
}
```

---

## 19. Complete File Inventory

| # | File | Type | Lines (est.) | Purpose |
|---|---|---|---|---|
| 1 | `src/executor/types.ts` | New | ~120 | All types, ExecutionError class, DEFAULT_MODEL_MAP, createDefaultConfig |
| 2 | `src/executor/utils.ts` | New | ~25 | `cancellableSleep()` utility |
| 3 | `src/executor/claude-client.ts` | New | ~150 | ClaudeClient interface, AnthropicClaudeClient, MockClaudeClient |
| 4 | `src/executor/skill-content-loader.ts` | New | ~60 | `loadSkillContent()` — extends loadSkillMeta with body + refs |
| 5 | `src/executor/prompt-builder.ts` | New | ~90 | `buildPrompt()` — assembles system + user message |
| 6 | `src/executor/agent-executor.ts` | New | ~200 | `AgentExecutor` class — the main executor |
| 7 | `src/executor/index.ts` | New | ~30 | Barrel exports |
| 8 | `src/executor/__tests__/claude-client.test.ts` | New | ~120 | Mock + integration tests |
| 9 | `src/executor/__tests__/skill-content-loader.test.ts` | New | ~80 | Skill loading tests |
| 10 | `src/executor/__tests__/prompt-builder.test.ts` | New | ~120 | Prompt assembly tests |
| 11 | `src/executor/__tests__/agent-executor.test.ts` | New | ~350 | Full executor tests (largest file) |
| 12 | `src/index.ts` | Modify | +1 | Add executor export |
| 13 | `package.json` | Modify | +1 | Add @anthropic-ai/sdk dep |

**Total new code:** ~1,345 lines (est.)
**Total new test code:** ~670 lines (est.)

---

## 20. Not In Scope (Explicitly Excluded)

- **Token budget enforcement**: tracking is done, but no budget limits enforced. Future work.
- **Streaming responses**: using non-streaming `messages.create`. Streaming adds complexity without benefit for autonomous agents.
- **Tool use**: agents don't use Claude tools. They receive instructions and produce text output. Tool use is a Phase 3 concern (Playwright, MCP integrations).
- **Conversation history**: each execution is a single-turn interaction (system + user → assistant). No multi-turn conversations.
- **Output validation beyond empty check**: we don't validate that the output matches the SKILL.md's output format. That's the Director's job (Task 7 review loop).
- **Caching**: no caching of skill content or product context between executions. The workspace is the source of truth.
- **Metrics/logging**: no structured logging. ExecutionResult provides token and duration data. Structured logging is Phase 2.
- **Multi-turn revision loops**: the executor handles a single execution. Revision loops (re-execute with feedback) are orchestrated by the pipeline engine (Task 4) or Director review loop (Task 7).
