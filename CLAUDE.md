# CLAUDE.md

## Project Overview

**marketing-agentic-ai** is a self-operating marketing team — 26 specialized AI agents organized into 5 squads, led by a Marketing Director agent, working 24/7. Agents strategize, create, optimize, measure, and iterate across the full marketing funnel. They hand off work to each other, review each other's outputs, respond to real-time data, and improve continuously — powered by Claude.

## Current State

- **26 marketing agents installed** and operational via Claude Code CLI skills
- **Bun + TypeScript** project scaffolded with Playwright 1.56.1
- **Session start hook** configured for Claude Code on the web
- **Railway MCP server** registered in `.claude/settings.json`
- **Orchestration engine not yet built** — agents currently run one at a time via manual invocation

### Repository Contents

```
marketing-agentic-ai/
├── .agents/
│   └── skills/                 # 26 agent definitions (SKILL.md + references/)
│       ├── ab-test-setup/      # [Measure Squad]
│       ├── analytics-tracking/ # [Measure Squad]
│       ├── cold-email/         # [Creative Squad]
│       ├── competitor-alt.../  # [Strategy Squad]
│       ├── content-strategy/   # [Strategy Squad]
│       ├── copy-editing/       # [Creative Squad]
│       ├── copywriting/        # [Creative Squad]
│       ├── email-sequence/     # [Activate Squad]
│       ├── form-cro/           # [Convert Squad]
│       ├── free-tool-strategy/ # [Convert Squad]
│       ├── launch-strategy/    # [Strategy Squad]
│       ├── marketing-ideas/    # [Strategy Squad]
│       ├── marketing-psych.../  # [Strategy Squad]
│       ├── onboarding-cro/     # [Activate Squad]
│       ├── page-cro/           # [Convert Squad]
│       ├── paid-ads/           # [Creative Squad]
│       ├── paywall-upgrade.../  # [Activate Squad]
│       ├── popup-cro/          # [Convert Squad]
│       ├── pricing-strategy/   # [Strategy Squad]
│       ├── product-marketing-context/  # [Foundation]
│       ├── programmatic-seo/   # [Creative Squad]
│       ├── referral-program/   # [Activate Squad]
│       ├── schema-markup/      # [Creative Squad]
│       ├── seo-audit/          # [Measure Squad]
│       ├── signup-flow-cro/    # [Convert Squad]
│       └── social-content/     # [Creative Squad]
├── .claude/
│   ├── hooks/
│   │   └── session-start.sh    # Installs deps in remote environments
│   ├── settings.json           # Hooks + Railway MCP server config
│   └── skills/                 # Symlinks to .agents/skills/
├── index.ts                    # Future orchestration entry point
├── index.test.ts               # Smoke tests
├── package.json                # Bun project with Playwright
├── tsconfig.json               # TypeScript strict config
├── CLAUDE.md                   # This file
├── PROJECT_PROPOSAL.md         # Full project blueprint
└── README.md                   # Project description
```

## Architecture

### Team Structure

```
MARKETING DIRECTOR (Supervisor Agent — Claude Opus)
  │
  ├── STRATEGY SQUAD — Plans what to do and why
  │   content-strategy, pricing-strategy, launch-strategy,
  │   marketing-ideas, marketing-psychology, competitor-alternatives
  │
  ├── CREATIVE SQUAD — Produces content and copy
  │   copywriting, copy-editing, social-content, cold-email,
  │   paid-ads, programmatic-seo, schema-markup
  │
  ├── CONVERT SQUAD — Optimizes conversion touchpoints
  │   page-cro, form-cro, signup-flow-cro, popup-cro, free-tool-strategy
  │
  ├── ACTIVATE SQUAD — Turns signups into retained users
  │   onboarding-cro, email-sequence, paywall-upgrade-cro, referral-program
  │
  └── MEASURE SQUAD — Closes the feedback loop
      analytics-tracking, ab-test-setup, seo-audit
```

### Shared Context Model

The `product-marketing-context` skill creates `.claude/product-marketing-context.md` — a 12-section document covering product, audience, positioning, voice, and goals. **25 of 26 agents read this before doing any work.**

### Inter-Agent Protocol

Agents communicate via a shared workspace:

```
context/       → product-marketing-context.md (team wiki)
tasks/         → {task-id}.md (active assignments from Director)
outputs/       → {squad}/{skill}/{task-id}.md (agent deliverables)
reviews/       → {task-id}-review.md (agent feedback on each other)
metrics/       → {date}-report.md (performance data from Measure Squad)
memory/        → learnings.md (what worked, what failed)
```

### 24/7 Runtime Engine

```
Scheduler (cron) → Daily social content, weekly content pipeline,
                   monthly CRO sprint, quarterly pricing review
Event Bus        → Traffic drops, conversion changes, competitor moves,
                   A/B test significance → trigger response pipelines
Task Queue       → Priority-based (P0-P3), 3 parallel agents,
                   retries with backoff, dead letter queue
```

### Feedback Loop

```
SET GOALS → PLAN (Strategy) → CREATE (Creative) → OPTIMIZE (Convert)
    ↑         → ACTIVATE (Activate) → MEASURE (Measure) → LEARN (Director)
    └─────────────────────────────────────────────────────────────┘
```

The loop never terminates. Measure feeds data back to Director, who iterates or ships.

## Common Commands

### Skill Invocation (current — manual mode)
```
/product-marketing-context   # Foundation — establish product context
/content-strategy            # Plan content pillars and topics
/copywriting                 # Write marketing page copy
/copy-editing                # Edit existing copy (7 sweeps)
/page-cro                    # Optimize a page for conversions
/seo-audit                   # Audit SEO issues
/ab-test-setup               # Design an A/B test
/email-sequence              # Create an email drip campaign
/launch-strategy             # Plan a product launch
/pricing-strategy            # Design pricing and packaging
```

### Development
```bash
bun install                  # Install dependencies
bun test                     # Run tests
bunx tsc --noEmit            # Type check
bunx playwright test         # Run Playwright tests
```

### Skill Installation
```bash
npx skills add coreyhaines31/marketingskills --yes
```

## Development Guidelines

### For AI Assistants

1. **Always check for `.claude/product-marketing-context.md` first.** Read it before asking redundant questions about the product.
2. **Skills are defined in `.agents/skills/<name>/SKILL.md`.** Read the SKILL.md before producing any marketing output.
3. **Reference files supplement skills.** Check `references/*.md` in the skill directory for templates, frameworks, and examples.
4. **Follow the skill's output format.** Each SKILL.md defines a specific output structure.
5. **Suggest related skills.** Recommend next skills from the "Related Skills" section after completing a workflow.
6. **Tech stack is Bun + TypeScript.** The orchestration layer will be built with Bun, Claude Agent SDK, BullMQ, and PostgreSQL.

### Conventions

- **Commit messages**: Conventional commit format (`feat:`, `fix:`, `docs:`, `chore:`)
- **Branch naming**: Descriptive names (e.g., `feat/director-agent`, `feat/pipeline-engine`)
- **Documentation**: Keep CLAUDE.md and PROJECT_PROPOSAL.md in sync with project state
- **Skill modifications**: Preserve metadata headers and product-marketing-context checks
- **Environment variables**: Never commit secrets. Use `.env` files (gitignored)

### What to Build Next

1. **Marketing Director agent** — supervisor that decomposes goals, assigns squads, reviews outputs
2. **Shared workspace** — file-based workspace structure for inter-agent handoffs
3. **Agent executor** — loads SKILL.md + context, calls Claude API, writes output
4. **Pipeline engine** — chains agents sequentially and in parallel
5. **Task queue** — BullMQ priority queue for 24/7 operation
6. **Scheduler + event bus** — cron pipelines and webhook-triggered responses

## Project Documentation

See **[PROJECT_PROPOSAL.md](PROJECT_PROPOSAL.md)** for the complete blueprint:
- 24/7 autonomous team architecture (5 squads + Director)
- Inter-agent communication protocol
- Runtime engine design (scheduler, event bus, queue)
- Feedback loop architecture
- Implementation roadmap (5 phases, 20 weeks)
- Technical stack and MCP server integrations
