# CLAUDE.md

## What This Is

A self-operating marketing team — 26 AI agents in 5 squads + a Director, powered by Claude. Agents strategize, create, optimize, measure, and iterate across the full marketing funnel.

## Current State: Phase 1 Complete (Backend Only)

Phase 1 built 7 backend modules with 784 tests. **No runtime, no real API calls, no deployment.** This is a library, not a runnable app yet.

| Module | What it does |
|--------|-------------|
| `src/types/` | Shared TypeScript types and constants |
| `src/workspace/` | File-based CRUD for tasks, outputs, reviews, learnings |
| `src/agents/` | Skill registry, Claude client, model selector, prompt builder |
| `src/executor/` | Loads skill → builds prompt → calls Claude → writes output |
| `src/director/` | Goal decomposition, squad routing, review engine, escalation |
| `src/pipeline/` | Sequential + parallel pipeline engine |
| `src/queue/` | BullMQ adapter, budget gate, failure tracker, routing |

**Everything uses mocks.** Claude API = mocked. Redis = mocked. Director reviews = structural only.

See [docs/phase-1-status.md](docs/phase-1-status.md) for the full honest assessment.

## Where to Find Things

| You need... | Look here |
|---|---|
| Module map, exports, dependency flow | [docs/architecture.md](docs/architecture.md) |
| What's built, what's mocked, what's missing | [docs/phase-1-status.md](docs/phase-1-status.md) |
| Phase 2-5 roadmap and open decisions | [docs/next-steps.md](docs/next-steps.md) |
| Full project blueprint (5 phases, 20 weeks) | [PROJECT_PROPOSAL.md](PROJECT_PROPOSAL.md) |
| Agent skill definitions (26 agents) | `.agents/skills/<name>/SKILL.md` |
| Product marketing context (shared) | `.claude/product-marketing-context.md` |
| All public API exports | `src/index.ts` |
| E2E integration tests | `src/__tests__/e2e/` |

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
bun test             # Run 784 tests
bunx tsc --noEmit    # Type check
```

Skill invocation (manual mode — no orchestration yet):
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
5. Run `bun test` after any code change — 784 tests must stay green
6. Tech stack: Bun + TypeScript. Orchestration uses Claude Agent SDK + BullMQ + PostgreSQL (planned)
