# CLAUDE.md

## What This Is

A self-operating marketing team — 26 AI agents in 5 squads + a Director, powered by Claude. Agents strategize, create, optimize, measure, and iterate across the full marketing funnel.

## Current State: Phase 1 + 2 Complete, Integration Verified

Phase 2 built the 24/7 runtime engine on top of Phase 1's backend. 14 modules, 1472+ tests across 68 files. The system can accept a natural-language goal, decompose it into tasks, execute them through pipelines, schedule recurring work, react to external events, and track costs — all with structured logging and health monitoring.

**Real Claude API integration verified** — 23 tests make live API calls (Haiku model, ~$0.01/test). Full 5-step Content Production pipeline runs end-to-end in ~4 minutes. All 26 skill SKILL.md files load successfully. Director structural review approves real Claude output.

| Module | What it does |
|--------|-------------|
| `src/types/` | Shared TypeScript types and constants |
| `src/workspace/` | File-based CRUD for tasks, outputs, reviews, learnings, schedules |
| `src/agents/` | Skill registry (26 skills), Claude client, model selector, prompt builder, unified executor |
| `src/executor/` | Legacy executor (deprecated — kept for reference) |
| `src/director/` | Goal decomposition, squad routing, pipeline factory, review engine, escalation |
| `src/pipeline/` | Sequential + parallel pipeline engine with concurrency control |
| `src/queue/` | BullMQ adapter, budget gate, failure tracker, completion router, fallback queue |
| `src/events/` | Event bus with condition/cooldown/dedup, webhook HTTP receiver |
| `src/scheduler/` | Cron-based scheduler with budget gating and overlap protection |
| `src/observability/` | Structured logging (pino), cost tracker, metrics collector, health monitor |
| `src/runtime/` | Goal run loop (poll-based phase advancement) |
| `src/config.ts` | Runtime configuration from env vars with validation |
| `src/bootstrap.ts` | Composition root wiring all 14 modules |
| `src/cli.ts` | CLI entry point (goal, pipeline, daemon modes) |

**Unit tests use mocks** for Claude API and Redis. Real API integration tests opt-in via `ANTHROPIC_API_KEY` env var (`describe.skipIf`). Director reviews are structural only (semantic review is Phase 3).

See [docs/phase-2-status.md](docs/phase-2-status.md) for the full honest assessment.

## Where to Find Things

| You need... | Look here |
|---|---|
| Module map, exports, dependency flow | [docs/architecture.md](docs/architecture.md) |
| Phase 2 honest assessment | [docs/phase-2-status.md](docs/phase-2-status.md) |
| Phase 1 honest assessment | [docs/phase-1-status.md](docs/phase-1-status.md) |
| Phase 2 design (sessions A-I) | [docs/phase-2-design.md](docs/phase-2-design.md) |
| Phase 3-5 roadmap and open decisions | [docs/next-steps.md](docs/next-steps.md) |
| Full project blueprint (5 phases, 20 weeks) | [PROJECT_PROPOSAL.md](PROJECT_PROPOSAL.md) |
| Agent skill definitions (26 agents) | `.agents/skills/<name>/SKILL.md` |
| Product marketing context (shared) | `.claude/product-marketing-context.md` |
| All public API exports | `src/index.ts` |
| E2E integration tests (mocked) | `src/__tests__/e2e/` |
| Real API integration tests | `src/__tests__/e2e/real-api.test.ts`, `integration-real-api.test.ts` |

## Team Structure

```
MARKETING DIRECTOR (Supervisor — Claude Opus)
├── STRATEGY SQUAD    — content-strategy, pricing-strategy, launch-strategy,
│                       marketing-ideas, marketing-psychology, competitor-alternatives
├── CREATIVE SQUAD    — copywriting, copy-editing, social-content, cold-email,
│                       paid-ads, programmatic-seo, schema-markup
├── CONVERT SQUAD     — page-cro, form-cro, signup-flow-cro, popup-cro, free-tool-strategy
├── ACTIVATE SQUAD    — onboarding-cro, email-sequence, paywall-upgrade-cro, referral-program
└── MEASURE SQUAD     — analytics-tracking, ab-test-setup, seo-audit
```

## Commands

```bash
bun install          # Install deps
bun test             # Run 1472+ tests (mock tests always run; real API tests need ANTHROPIC_API_KEY)
bunx tsc --noEmit    # Type check
```

Real API integration tests (uses Haiku to minimize cost):
```bash
ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e/real-api.test.ts           # 3 tests, ~5 min
ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e/integration-real-api.test.ts # 20 tests, ~5 min
```

Runtime (requires ANTHROPIC_API_KEY + Redis):
```bash
bun run start "Create a content strategy for Q2"   # Single goal
bun run start --pipeline "Content Production"       # Named pipeline
bun run start --daemon                              # 24/7 daemon mode
bun run start --dry-run "Goal text"                 # Plan only, no execution
docker compose up -d                                # Start Redis via Docker
```

Skill invocation (manual mode):
```
/product-marketing-context   /content-strategy   /copywriting
/copy-editing                /page-cro           /seo-audit
/ab-test-setup               /email-sequence     /launch-strategy
/pricing-strategy
```

## Conventions

- **Commits**: Conventional format (`feat:`, `fix:`, `docs:`, `chore:`)
- **Branches**: Descriptive (`feat/director-agent`, `feat/pipeline-engine`)
- **Secrets**: Never commit. Use `.env` files (gitignored)
- **Skills**: Preserve metadata headers and product-marketing-context checks

## For AI Assistants

1. Read `.claude/product-marketing-context.md` before asking about the product
2. Read the relevant SKILL.md before producing marketing output
3. Check `references/*.md` in skill directories for templates and examples
4. Read [docs/architecture.md](docs/architecture.md) before modifying src/ modules
5. Run `bun test` after any code change — 1472+ tests must stay green
6. Tech stack: Bun + TypeScript. Orchestration uses Claude Agent SDK + BullMQ + PostgreSQL (planned)
7. Use `--dry-run` flag for plan-only execution when testing goal flows
8. E2E tests in `src/__tests__/e2e/` cover cross-module integration; read `helpers.ts` for bootstrap utilities
9. Real API tests use `describe.skipIf(!HAS_API_KEY)` — they auto-skip without `ANTHROPIC_API_KEY`
10. Task status transitions are enforced: `pending → in_progress → completed` (not `pending → completed`)
11. Config test for missing API key must save/restore `process.env` to avoid leaking env state
12. Pipeline timeouts: 5-step sequential pipelines need 360s+ with real API (each step ~30-60s)
