# Project Proposal: Marketing Agentic AI System

## 1. Project Feasibility Assessment

### Can an agentic AI be built with Claude? — **Yes**

Claude is uniquely suited for this project for three reasons:

1. **Skill-based agent architecture already exists.** The 26 marketing skills installed in this repository use Claude's native skill/agent system (`.claude/skills/` symlinks to `.agents/skills/`). Each skill defines a specialized persona with domain expertise, structured workflows, reference materials, and cross-skill dependencies. Claude reads these at invocation time and operates as a domain expert — no fine-tuning, no external orchestration framework required.

2. **Shared context via product-marketing-context.** The `product-marketing-context` skill creates a canonical `.claude/product-marketing-context.md` file that 25 of 26 skills check before doing any work. This is a lightweight but effective form of agent memory — the user establishes foundational context once, and every subsequent skill invocation inherits it automatically.

3. **Tool use and multi-step reasoning.** Claude's tool-use capability allows skills to read files, search codebases, write outputs, and chain actions. Each skill defines a phased workflow (assess → analyze → produce → validate) that Claude executes autonomously within a single conversation.

### Key Capabilities

| Capability | Status |
|---|---|
| Specialized domain agents (26 marketing skills) | Available now |
| Shared persistent context across agents | Available now (product-marketing-context.md) |
| Structured multi-step workflows | Available now (each SKILL.md defines phases) |
| Cross-skill orchestration and referrals | Available now (Related Skills sections) |
| File generation and project scaffolding | Available now (Claude Code tool use) |
| Web research and real-time data | Available via WebSearch/WebFetch tools |
| External tool integrations (GA4, GTM, email platforms) | Documented in skills; requires user API keys |
| Autonomous multi-agent pipelines (no human in loop) | Not yet — requires orchestration layer |
| Persistent long-term memory across sessions | Not yet — requires external storage |

### Key Limitations

- **No autonomous multi-agent orchestration.** Currently, a human invokes one skill at a time. There is no automated pipeline that chains skills (e.g., auto-running `copywriting` after `content-strategy` completes).
- **Session-bound context.** The product-marketing-context file persists across sessions, but conversation state does not. Each new session starts fresh.
- **No external API execution.** Skills can *design* GA4 tracking plans or email sequences, but they cannot *deploy* them to external platforms without MCP server integrations or custom tooling.
- **No real-time analytics feedback loop.** The system cannot yet monitor live metrics and trigger optimization skills automatically.

---

## 2. Technical Requirements

### Essential Tools and Technologies

| Layer | Technology | Purpose |
|---|---|---|
| **AI Runtime** | Claude (Opus/Sonnet) via Claude Code CLI or API | Core reasoning engine for all 26 skills |
| **Skill Framework** | `.agents/skills/` + `.claude/skills/` (symlinks) | Skill discovery, registration, and invocation |
| **Shared Context** | `.claude/product-marketing-context.md` | Persistent product/audience/brand knowledge base |
| **Reference Library** | `references/*.md` per skill (25 files total) | Templates, frameworks, benchmarks, examples |
| **Version Control** | Git + GitHub | Skill versioning, collaboration, deployment |
| **Package Manager** | npm (`npx skills` CLI) | Skill installation and updates |

### Integration Methods with Claude

**Method 1: Claude Code CLI (Current — Recommended for v1)**
- User invokes skills via slash commands (e.g., `/copywriting`, `/seo-audit`)
- Claude reads SKILL.md at invocation, adopts the expert persona, follows the defined workflow
- Outputs are written to files or displayed in conversation
- Best for: Individual marketers, small teams, interactive use

**Method 2: Claude API + Agent SDK (Future — Required for automation)**
- Build a Node.js/Python orchestration service using the Claude Agent SDK
- Programmatically invoke skills as API calls with structured inputs
- Chain skills into automated pipelines (e.g., content-strategy → copywriting → seo-audit)
- Best for: SaaS product, team workflows, scheduled automation

**Method 3: MCP Server Integrations (Future — Required for external tools)**
- Connect Claude to external marketing platforms via Model Context Protocol
- Email platforms (Customer.io, Mailchimp, Resend, SendGrid)
- Analytics (GA4, GTM)
- CMS (WordPress, Webflow)
- Ad platforms (Google Ads, Meta Ads)
- Best for: End-to-end execution, not just planning

### Infrastructure Requirements

**Phase 1 (Current — Zero infrastructure):**
- Claude Code CLI installed locally
- Git repository with skills installed
- No servers, no databases, no deployment

**Phase 2 (API-based service):**
- Node.js or Python runtime
- Claude API key (Anthropic)
- PostgreSQL or SQLite for session/context persistence
- Redis for job queuing (optional)
- Docker for containerization

**Phase 3 (Full SaaS):**
- Cloud hosting (AWS/GCP/Vercel)
- Authentication (Auth0/Clerk)
- File storage (S3) for generated assets
- MCP server instances for external integrations
- Monitoring and logging (Datadog/Sentry)

---

## 3. Project Description

### Overview

Marketing Agentic AI is a system of 26 specialized AI agents — each an expert in a specific marketing discipline — that collectively function as a full marketing team. Powered by Claude, the system strategizes, writes, optimizes, audits, and measures marketing across the entire funnel, from awareness through retention. Users establish their product context once, and every agent inherits that knowledge to deliver consistent, brand-aligned output.

### Core Functionalities

The 26 agents are organized into a marketing funnel pipeline:

```
FOUNDATION
  └─ product-marketing-context — Establishes product, audience, positioning, voice

AWARENESS (Top of Funnel)
  ├─ content-strategy    — Plans content pillars, topics, editorial calendar
  ├─ programmatic-seo    — Builds SEO pages at scale (12 playbooks)
  ├─ social-content      — Creates platform-specific social media content
  ├─ paid-ads            — Designs ad campaigns (Google, Meta, LinkedIn, Twitter)
  └─ marketing-ideas     — Library of 139 proven marketing tactics

CONSIDERATION (Middle of Funnel)
  ├─ competitor-alternatives — Creates comparison/alternative pages (4 formats)
  ├─ pricing-strategy        — Designs pricing, packaging, monetization
  ├─ copywriting             — Writes marketing page copy (homepage, landing, pricing)
  ├─ copy-editing            — Edits copy via 7 systematic sweeps
  ├─ schema-markup           — Generates JSON-LD structured data
  ├─ cold-email              — Writes outreach emails and follow-up sequences
  └─ marketing-psychology    — Applies 70+ psychological models to marketing

CONVERSION (Bottom of Funnel)
  ├─ page-cro         — Optimizes marketing pages for conversion
  ├─ form-cro         — Optimizes lead capture, contact, demo forms
  ├─ signup-flow-cro  — Optimizes signup/registration flows
  ├─ popup-cro        — Creates and optimizes popups/modals/banners
  └─ free-tool-strategy — Plans free tools for lead generation

ACTIVATION & RETENTION
  ├─ onboarding-cro         — Optimizes post-signup user activation
  ├─ email-sequence         — Creates lifecycle email sequences
  ├─ paywall-upgrade-cro    — Optimizes free-to-paid conversion screens
  ├─ referral-program       — Designs referral and affiliate programs
  └─ launch-strategy        — Plans phased launches (ORB framework, 5 phases)

MEASUREMENT (Cross-cutting)
  ├─ analytics-tracking — Sets up GA4/GTM tracking plans
  ├─ ab-test-setup      — Designs statistically rigorous A/B tests
  └─ seo-audit          — Audits technical SEO, content quality, E-E-A-T
```

### Unique Value Proposition

Unlike point-solution AI writing tools (Jasper, Copy.ai) that generate isolated content, this system provides an **interconnected team of specialists** that share context, reference each other's outputs, and follow structured marketing frameworks. It replaces the need for 5-10 separate marketing hires or agencies by providing expert-level output across 26 disciplines from a single, context-aware system.

---

## 4. Target Audience Analysis

### Primary User Demographics

| Segment | Description | Size Estimate |
|---|---|---|
| **Solo founders / indie hackers** | Technical founders who can build product but lack marketing expertise. Need a "marketing co-founder in a box." | ~2M globally (IndieHackers, Product Hunt, YC community) |
| **Small SaaS teams (2-20 people)** | Have product-market fit but no dedicated marketing hire. Marketing falls on founders or generalist employees. | ~500K companies globally |
| **Marketing teams at startups (Series A-B)** | Have 1-3 marketers who are stretched thin. Need expert-level output in disciplines they don't specialize in. | ~100K companies globally |
| **Freelance marketers / consultants** | Serve multiple clients and need to scale their output. Use AI as a force multiplier. | ~5M globally |

### Use Cases and Pain Points Addressed

| Pain Point | How the System Solves It |
|---|---|
| "I don't know what content to create" | `content-strategy` plans pillars, topics, and editorial calendar based on customer research |
| "My landing page isn't converting" | `page-cro` audits the page and provides prioritized fixes with copy alternatives |
| "I need to launch but have no plan" | `launch-strategy` creates a phased plan using the ORB framework |
| "I'm not sure how to price my product" | `pricing-strategy` designs tiers using value-based pricing and psychological principles |
| "My emails have low open/click rates" | `email-sequence` redesigns sequences with proven templates and copy guidelines |
| "I need to rank for keywords but don't know SEO" | `seo-audit` + `programmatic-seo` + `schema-markup` provide a complete SEO strategy |
| "I keep repeating my product info to every tool" | `product-marketing-context` captures it once; all 25 other skills inherit it automatically |
| "I want to run A/B tests but don't know statistics" | `ab-test-setup` designs tests with proper sample sizes, hypothesis frameworks, and analysis templates |

### Market Size Estimation

- **TAM (Total Addressable Market):** ~$50B — global digital marketing software market
- **SAM (Serviceable Addressable Market):** ~$5B — AI-powered marketing tools for SMBs and startups
- **SOM (Serviceable Obtainable Market):** ~$50M — early adopters using AI coding/agent tools for marketing (Claude Code, Cursor, etc.)

---

## 5. User Input Requirements

### What Users Need to Provide

**One-time setup (via `product-marketing-context`):**

| Section | What to Provide | Example |
|---|---|---|
| Product Overview | What you sell, how it works, key features | "SaaS scheduling tool for remote teams" |
| Target Audience | Who buys, company size, role, industry | "Engineering managers at 50-500 person companies" |
| Personas | 2-4 buyer personas with goals and frustrations | "DevOps Dana: wants to reduce meeting overhead" |
| Problems & Pain Points | What problems your product solves | "Scheduling across time zones is manual and error-prone" |
| Competitive Landscape | Key competitors and how you differ | "Calendly (too simple), Doodle (not async-first)" |
| Differentiation | Your unique advantage | "Only tool with async-first scheduling and timezone AI" |
| Objections | Common reasons people don't buy | "Already using Google Calendar" |
| Customer Language | How customers describe their problems | "I waste 2 hours/week on scheduling back-and-forth" |
| Brand Voice | Tone, personality, dos and don'ts | "Professional but not stiff. Technical but accessible." |
| Proof Points | Metrics, testimonials, case studies | "92% reduction in scheduling emails for Acme Corp" |
| Goals | Current marketing objectives | "Reach 1000 signups by Q3; reduce CAC below $50" |

**Per-skill invocation (varies by skill):**

Each skill asks 3-6 targeted questions. Examples:
- `copywriting`: "What type of page? What is the ONE primary action?"
- `page-cro`: "What's the current conversion rate? Where does traffic come from?"
- `ab-test-setup`: "What's your baseline conversion rate? How much traffic do you get?"

### Input Formats and Methods

| Method | Description |
|---|---|
| **Conversational** | Answer questions in natural language via Claude Code chat |
| **Auto-draft from codebase** | `product-marketing-context` can scan README, landing pages, and package.json to auto-generate context |
| **File-based** | Paste existing marketing docs, competitor analysis, or analytics data into the conversation |
| **URL-based** | Share a page URL for `page-cro`, `seo-audit`, or `copy-editing` to analyze |

### Onboarding Process

```
Step 1: Install skills
  └─ npx skills add coreyhaines31/marketingskills

Step 2: Establish product context (10-15 minutes)
  └─ /product-marketing-context
  └─ Answer questions or let it auto-draft from your codebase
  └─ Review and confirm the generated .claude/product-marketing-context.md

Step 3: Use any skill on demand
  └─ /content-strategy, /copywriting, /page-cro, etc.
  └─ Each skill inherits your product context automatically

Step 4 (optional): Chain skills for larger projects
  └─ /content-strategy → /copywriting → /copy-editing → /seo-audit
```

---

## 6. Service Delivery Framework

### How the AI Agent System Works

```
┌──────────────────────────────────────────────────────┐
│                   USER INVOCATION                     │
│  "/copywriting — write homepage copy for my SaaS"    │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│              CONTEXT LOADING                          │
│  1. Read .claude/product-marketing-context.md         │
│  2. Read SKILL.md for the invoked skill               │
│  3. Read references/*.md for supplementary data       │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│              INITIAL ASSESSMENT                       │
│  Skill asks 3-6 targeted questions based on what's   │
│  NOT already in product-marketing-context             │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│              EXPERT EXECUTION                         │
│  Claude operates as a domain expert following the     │
│  skill's defined framework, principles, and workflow  │
│  (e.g., 7-sweep copy editing, ORB launch framework)  │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│              STRUCTURED OUTPUT                        │
│  Each skill defines its output format:                │
│  - Copywriting → Page copy + annotations + alts      │
│  - Page CRO → Quick wins + high-impact + test ideas  │
│  - Email seq → Sequence overview + per-email specs    │
│  - AB test → Hypothesis + design + sample size        │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│              CROSS-SKILL REFERRAL                     │
│  Skill suggests related skills for next steps:        │
│  "→ Use /ab-test-setup to test these CTA variants"   │
│  "→ Use /page-cro to optimize the landing page"      │
└──────────────────────────────────────────────────────┘
```

### Workflow and Process Automation

**Current state (Manual orchestration):**
User invokes skills one at a time. Cross-skill referrals are suggestions, not automated handoffs.

**Future state (Automated pipelines):**

| Pipeline | Skill Chain | Trigger |
|---|---|---|
| **Content Production** | content-strategy → copywriting → copy-editing → seo-audit → schema-markup | Weekly content calendar |
| **Landing Page Launch** | copywriting → page-cro → ab-test-setup → analytics-tracking | New feature release |
| **Product Launch** | product-marketing-context → launch-strategy → email-sequence → social-content → paid-ads | Launch date |
| **Conversion Optimization** | page-cro → form-cro → signup-flow-cro → onboarding-cro → ab-test-setup | Monthly CRO sprint |
| **Competitive Response** | competitor-alternatives → copywriting → pricing-strategy → paid-ads | Competitor launch detected |

### Success Metrics and Deliverables

| Metric | How Measured | Target |
|---|---|---|
| **Time to first marketing asset** | Minutes from onboarding to first usable output | < 30 minutes |
| **Output quality** | User acceptance rate (% of outputs used without major edits) | > 70% |
| **Context reuse** | % of skill invocations that leverage product-marketing-context | > 90% |
| **Skill coverage** | % of marketing needs addressable by existing skills | > 80% of SMB needs |
| **Cross-skill usage** | Average skills used per user per month | 5+ skills/month |

---

## 7. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2) — **COMPLETE**

| Task | Status |
|---|---|
| Repository initialized | Done |
| 26 marketing skills installed from coreyhaines31/marketingskills | Done |
| CLAUDE.md created for AI assistant guidance | Done |
| Skills verified and categorized | Done |

**Deliverables:** Working skill system usable via Claude Code CLI today.

### Phase 2: Context & Quality (Weeks 3-4)

| Task | Description |
|---|---|
| Run `product-marketing-context` | Establish the foundational context document for this project |
| Test all 26 skills end-to-end | Invoke each skill with real inputs, evaluate output quality |
| Document skill dependencies | Map the full cross-skill dependency graph |
| Create example outputs | Build a `examples/` directory with sample outputs from each skill |
| Identify gaps | Find marketing needs not covered by the current 26 skills |

**Deliverables:** Validated skill system with documented quality benchmarks.

### Phase 3: Orchestration Layer (Weeks 5-8)

| Task | Description |
|---|---|
| Choose tech stack | Node.js/TypeScript (recommended) or Python |
| Build pipeline engine | Define skill chains as declarative YAML/JSON configs |
| Implement context passing | Output of skill N becomes input context for skill N+1 |
| Add session persistence | Store conversation state and outputs across sessions |
| Build CLI wrapper | `marketing-ai run content-pipeline --product my-saas` |

**Deliverables:** Automated multi-skill pipelines executable from CLI.

### Phase 4: External Integrations (Weeks 9-12)

| Task | Description |
|---|---|
| MCP server for CMS | Write skill outputs directly to WordPress/Webflow |
| MCP server for email | Deploy email sequences to Customer.io/Mailchimp |
| MCP server for analytics | Read GA4 data to inform CRO and A/B test skills |
| MCP server for ads | Deploy ad copy to Google Ads/Meta Ads |
| Webhook triggers | Auto-invoke skills based on external events |

**Deliverables:** End-to-end execution — from strategy to deployment.

### Phase 5: SaaS Product (Weeks 13-20)

| Task | Description |
|---|---|
| Web UI | Dashboard for invoking skills, reviewing outputs, managing context |
| Authentication & billing | Multi-tenant user system with usage-based pricing |
| Team collaboration | Shared product context, review/approval workflows |
| Analytics dashboard | Track skill usage, output quality, marketing metrics |
| Public API | Allow third-party integrations and custom workflows |

**Deliverables:** Commercial SaaS product.

### Resource Requirements

| Phase | People | Monthly Cost Estimate |
|---|---|---|
| Phase 1-2 | 1 developer + Claude API | $200-500 (API costs only) |
| Phase 3 | 1-2 developers | $1K-2K (API + hosting) |
| Phase 4 | 2 developers + 1 marketer (dogfooding) | $2K-5K |
| Phase 5 | 3-4 developers + 1 designer + 1 marketer | $10K-20K |

### Potential Challenges and Mitigation

| Challenge | Risk | Mitigation |
|---|---|---|
| **Output quality inconsistency** | Medium | Reference files with templates and examples anchor outputs; copy-editing skill provides quality sweep |
| **Context window limits** | Medium | Product-marketing-context keeps shared info in a file, not repeated per conversation; skills reference files on demand |
| **Skill coordination complexity** | High | Start with manual orchestration (Phase 1-2); automate incrementally (Phase 3) |
| **External API rate limits** | Medium | Queue-based execution with backoff; batch operations where possible |
| **User adoption / learning curve** | Medium | Onboarding starts with product-marketing-context (guided setup); skills are self-documenting |
| **Keeping skills up to date** | Low | Skills are version-controlled markdown; `npx skills` supports updates |
| **Claude model changes** | Low | Skills are prompt-based (SKILL.md), not dependent on specific model behavior; work across Opus/Sonnet/Haiku |

---

## Appendix: Skill Cross-Reference Map

Skills that reference each other, forming the agent network:

```
product-marketing-context ──→ ALL 25 OTHER SKILLS

content-strategy ──→ copywriting, seo-audit, programmatic-seo, email-sequence, social-content
copywriting ──→ copy-editing, page-cro, email-sequence, popup-cro, ab-test-setup
page-cro ──→ signup-flow-cro, form-cro, popup-cro, copywriting, ab-test-setup
launch-strategy ──→ marketing-ideas, email-sequence, page-cro, marketing-psychology, programmatic-seo
email-sequence ──→ onboarding-cro, copywriting, ab-test-setup, popup-cro
analytics-tracking ──→ ab-test-setup, seo-audit, page-cro
ab-test-setup ──→ page-cro, analytics-tracking, copywriting
pricing-strategy ──→ page-cro, copywriting, competitor-alternatives, marketing-psychology
referral-program ──→ email-sequence, analytics-tracking, page-cro
seo-audit ──→ content-strategy, schema-markup, programmatic-seo
```

---

*This proposal was generated by analyzing the 26 installed marketing skills, their SKILL.md definitions, 25 reference files, and cross-skill dependency patterns in the marketing-agentic-ai repository.*
