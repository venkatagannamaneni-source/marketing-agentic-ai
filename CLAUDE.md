# CLAUDE.md

## Project Overview

**marketing-agentic-ai** is an agentic AI system of 26 specialized marketing agents that collectively function as a full marketing team. It strategizes, writes, optimizes, audits, and measures marketing across the entire funnel — powered by Claude with shared product context and cross-skill orchestration.

## Current State

The project has **26 marketing skills installed** and is operational via Claude Code CLI. No custom application code exists yet — the system runs entirely on Claude's native skill framework.

### Repository Contents

```
marketing-agentic-ai/
├── .agents/
│   └── skills/              # 26 marketing skill definitions (SKILL.md + references/)
│       ├── ab-test-setup/
│       ├── analytics-tracking/
│       ├── cold-email/
│       ├── competitor-alternatives/
│       ├── content-strategy/
│       ├── copy-editing/
│       ├── copywriting/
│       ├── email-sequence/
│       ├── form-cro/
│       ├── free-tool-strategy/
│       ├── launch-strategy/
│       ├── marketing-ideas/
│       ├── marketing-psychology/
│       ├── onboarding-cro/
│       ├── page-cro/
│       ├── paid-ads/
│       ├── paywall-upgrade-cro/
│       ├── popup-cro/
│       ├── pricing-strategy/
│       ├── product-marketing-context/
│       ├── programmatic-seo/
│       ├── referral-program/
│       ├── schema-markup/
│       ├── seo-audit/
│       ├── signup-flow-cro/
│       └── social-content/
├── .claude/
│   └── skills/              # Symlinks to .agents/skills/ for Claude Code discovery
├── .git/
├── CLAUDE.md                # This file
├── PROJECT_PROPOSAL.md      # Full project proposal and feasibility analysis
└── README.md                # Project description
```

## Architecture

### Skill-Based Agent System

Each skill is a self-contained marketing expert defined by:
- **SKILL.md** — Persona, workflow, principles, output format, and cross-skill references
- **references/*.md** — Templates, frameworks, benchmarks, and examples (25 files across 18 skills)

### Shared Context Model

The `product-marketing-context` skill creates `.claude/product-marketing-context.md` — a 12-section document covering product overview, audience, personas, pain points, competitors, differentiation, objections, customer language, brand voice, proof points, and goals. **25 of 26 skills check this file before doing any work**, enabling context-once-use-everywhere behavior.

### Funnel-Aligned Pipeline

```
FOUNDATION:    product-marketing-context
AWARENESS:     content-strategy → programmatic-seo → social-content → paid-ads → marketing-ideas
CONSIDERATION: competitor-alternatives → pricing-strategy → copywriting → copy-editing → schema-markup → cold-email → marketing-psychology
CONVERSION:    page-cro → form-cro → signup-flow-cro → popup-cro → free-tool-strategy
ACTIVATION:    onboarding-cro → email-sequence → paywall-upgrade-cro → referral-program → launch-strategy
MEASUREMENT:   analytics-tracking → ab-test-setup → seo-audit
```

### Cross-Skill Dependencies

Skills reference each other in "Related Skills" sections. Key hub skills:
- **product-marketing-context** — referenced by 25/26 skills
- **copywriting** — referenced by page-cro, cold-email, pricing-strategy, popup-cro, email-sequence
- **ab-test-setup** — referenced by all 6 CRO skills + analytics-tracking + copy-editing
- **page-cro** — referenced by form-cro, popup-cro, paid-ads, copywriting, free-tool-strategy

## Common Commands

### Skill Installation
```bash
npx skills add coreyhaines31/marketingskills --yes
```

### Skill Invocation (via Claude Code)
```
/product-marketing-context   # Start here — establish product context
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

## Development Guidelines

### For AI Assistants

When working on this repository:

1. **Always check for `.claude/product-marketing-context.md` first.** If it exists, read it before asking the user redundant questions about their product.
2. **Skills are defined in `.agents/skills/<name>/SKILL.md`.** Read the SKILL.md to understand the skill's workflow, principles, and expected output format before producing any marketing output.
3. **Reference files supplement skills.** Check for `references/*.md` in the skill directory — these contain templates, frameworks, and examples that should inform your output.
4. **Follow the skill's output format.** Each SKILL.md defines a specific output structure. Adhere to it for consistency.
5. **Suggest related skills.** After completing a skill's workflow, recommend relevant next skills from the "Related Skills" section.
6. **Technology stack for the orchestration layer is not yet decided.** If asked to build automation, confirm the intended stack (Node.js/TypeScript recommended) with the user.

### Conventions to Follow

- **Commit messages**: Conventional commit format (`feat:`, `fix:`, `docs:`, `chore:`).
- **Branch naming**: Descriptive names (e.g., `feat/content-writer-skill`, `fix/strategy-output-format`).
- **Documentation**: Keep this CLAUDE.md and PROJECT_PROPOSAL.md in sync with project state.
- **Skill modifications**: When editing skills, preserve the metadata header (name, description, version) and the product-marketing-context check.
- **Environment variables**: Never commit API keys. Use `.env` files (gitignored) with `.env.example` templates.

### Key Decisions Still Needed

- Programming language for the orchestration layer (Node.js/TypeScript recommended)
- Session persistence and context storage strategy
- MCP server integrations for external marketing tools
- Web UI framework (if building a SaaS product)
- Deployment target and infrastructure

## Project Documentation

See **[PROJECT_PROPOSAL.md](PROJECT_PROPOSAL.md)** for the complete project proposal including:
- Feasibility assessment
- Technical requirements
- Target audience analysis
- Service delivery framework
- Implementation roadmap (5 phases)
- Resource requirements and cost estimates
