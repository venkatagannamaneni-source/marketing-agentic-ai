# Next Steps — Phase 3 and Beyond

## Phase 1: Director + Orchestration Engine (Weeks 1-4) — COMPLETE ✓

14 modules, 1825+ tests, 68 files. Real Claude API integration verified with 23 live API tests.

## Phase 2: Runtime Engine (Weeks 5-8) — COMPLETE ✓

All 9 work streams delivered:
- Entry point / CLI with 3 modes (goal, pipeline, daemon)
- Real Claude API integration (AnthropicClaudeClient)
- Redis + BullMQ real queue adapters + Docker Compose
- Cron-based scheduler with 6 default schedules
- Event bus with webhook receiver and 5 default mappings
- Structured logging (pino), cost tracking, metrics, health monitoring
- Memory system (agents read past learnings)
- Full bootstrap composition root wiring 14 modules
- 1825+ tests across 68 files

See [docs/phase-2-status.md](phase-2-status.md) for the honest assessment.

## Phase 3: Intelligence + Semantic Review (Weeks 9-12) — COMPLETE ✓

All 6 items implemented with 121+ tests across semantic review, quality scoring, and consistency checking.

1. **Claude-powered semantic review** — ReviewEngine supports 3 depths (quick/standard/deep). Deep mode loads SKILL.md for context-aware Opus review. Structured JSON responses with verdict, findings, revision instructions, and summary. Graceful degradation on parse errors.

2. **Quality scoring model** — QualityScorer with 7 dimensions (completeness, actionability, data_driven, clarity, brand_alignment, creativity, technical_accuracy). 5 squad-specific profiles with per-dimension weights and min scores. Both structural and semantic scoring paths. Domain-aware criteria loaded from domain.yaml at runtime.

3. **Multi-pass review chains** — Review engine merges structural + semantic findings with deduplication. Pipeline continuation via `evaluateTaskSemantic()` integrates into the execute-and-review flow.

4. **Revision loops with real feedback** — REVISE decisions include Claude-generated revision instructions in task metadata. Agents re-execute with structured `revisionFeedback`, `reviewSummary`, and `reviewFindings` context. Prompt builder renders revision feedback in a dedicated `<revision-feedback>` section.

5. **Learning validation** — LearningValidator validates entries, ConsistencyChecker cross-checks pipeline outputs. Learning entries include quality scores for tracking improvement over time.

6. **Cross-agent consistency check** — ConsistencyChecker validates consistency across pipeline outputs (tone alignment, messaging consistency, etc.).

## Phase 3b: Platform Hardening — Extensibility Layer (Weeks 12-14) — COMPLETE ✓

The `.agents/` directory is now a complete, swappable "domain cartridge." Swap 7 YAML files to repurpose the system for any domain (DevOps, Support, Sales) with zero code changes.

### What was built:

1. **Externalized skill registry** — `skills.yaml` defines skills, squads, dependency graph, foundation skill. `SkillRegistry.fromYaml()` loads at startup. Adding a skill = YAML entry + SKILL.md file.

2. **Dynamic Director prompt** — `buildDirectorPrompt(registry, { domainRegistry })` generates the prompt from the live skill registry + domain config. Squad listings, agent descriptions, decision rules all derived from config.

3. **MCP Tool Registry** — `ToolRegistry` with `tools.yaml` config. Skills declare which tools they need; executor passes available tools to Claude.

4. **Domain Registry** — `domain.yaml` defines domain identity, goal categories with regex inference patterns, phase blueprints, director prompt sections, quality dimensions/profiles/skill criteria. `DomainRegistry.fromYaml()` with full validation.

5. **Externalized routing, schedules, events, pipelines** — `routing.yaml`, `schedules.yaml`, `events.yaml`, `pipelines.yaml` all loadable from YAML with hardcoded fallbacks.

6. **Cross-validation** — Bootstrap validates routing/schedule categories against domain config. Deferred `validateAgainstCategories()` methods on RoutingRegistry and ScheduleRegistry.

### What this enables:

```
Adding a new skill (BEFORE):  5 TypeScript file edits + recompile + redeploy
Adding a new skill (AFTER):   1 YAML entry + 1 SKILL.md file

Connecting a tool (BEFORE):   No way to do it — hardcoded system
Connecting a tool (AFTER):    1 tools.yaml entry + install MCP server

Changing domain (BEFORE):     Impossible — marketing hardcoded everywhere
Changing domain (AFTER):      Swap .agents/ directory — zero code changes
```

## Phase 4: Tool Integration + Real Execution (Weeks 15-22) — NEXT

The execution phase. With the Tool Registry in place, connect agents to real tools via MCP servers. Users configure which tools to connect through `tools.yaml` — the system discovers and binds tools to agents automatically.

### 4a: Analytics & Measurement (Weeks 15-16)
- GA4 MCP — read real traffic, conversion, bounce data (registered as `ga4`)
- Google Search Console MCP — read real rankings, impressions, index coverage (registered as `search-console`)
- Google Tag Manager MCP — deploy tracking events without code changes (registered as `gtm`)
- PageSpeed Insights MCP — run real Lighthouse audits (registered as `pagespeed`)

### 4b: Content Publishing (Weeks 17-18)
- WordPress MCP — publish posts, pages, structured data (registered as `wordpress`)
- Webflow MCP — publish to CMS collections (registered as `webflow`)
- GitHub MCP — create PRs for template pages, schema changes (registered as `github`)
- Playwright page analysis — analyze real pages (registered as `browser`, already installed)

### 4c: Email & Marketing Automation (Weeks 19-20)
- Mailchimp MCP — create campaigns, automations, read engagement (registered as `mailchimp`)
- Customer.io MCP — behavior-triggered workflows, activation sequences (registered as `customerio`)
- Resend MCP — transactional email (registered as `resend`)
- ESP-agnostic abstraction — Tool Registry routes to user's configured ESP automatically

### 4d: Advertising & Social (Weeks 21-22)
- Google Ads MCP — create campaigns, read performance (registered as `google-ads`)
- Meta Ads MCP — create campaigns, audience targeting, read ROAS (registered as `meta-ads`)
- Social media MCP — schedule posts to LinkedIn, Twitter/X via Buffer (registered as `linkedin`, `twitter`, `buffer`)
- Stripe MCP — read MRR, churn, plan distribution, trial conversions (registered as `stripe`)

## Phase 5: Feedback Loops + Self-Optimization (Weeks 23-28)

The intelligence phase. Close the loop: measure → detect → re-optimize → iterate.

- Analytics → Optimization loop (GA4 drop → auto-trigger CRO pipeline)
- A/B test → Iteration loop (significance reached → implement winner)
- SEO → Content loop (ranking drop → refresh content, build supporting pages)
- Email performance loop (low engagement → rewrite subject lines, adjust timing)
- Competitive response loop (competitor change → update comparison pages)
- Ad optimization loop (high CPC → pause keywords, scale winners)
- Social optimization loop (engagement data → adjust content calendar)
- Compound learning system (aggregate learnings into reusable patterns)
- Budget reallocation engine (shift spend from low-ROI to high-ROI channels)
- Anomaly detection + alerting (traffic/conversion drops → auto-response)
- Self-healing pipelines (failure → adjust strategy → retry)

## Phase 6: Dashboard, API + Multi-tenancy (Weeks 29-36)

The product phase. Turn the engine into a commercial SaaS.

- PostgreSQL migration (replace file workspace for production)
- REST API (goals, tasks, pipelines, outputs, metrics, health)
- WebSocket real-time updates
- Web dashboard (goal management, pipeline monitor, analytics, escalation center)
- MCP integration manager (connect tools via web UI — builds on Phase 3b's `tools.yaml`)
- Product context editor (guided wizard)
- Authentication + authorization (email/OAuth, RBAC)
- Multi-tenancy (per-tenant isolation — each tenant has own skills config + tool connections)
- Billing (Stripe, usage-based plans)
- Onboarding flow (15-minute time-to-value target: sign up → connect tools → set first goal)
- Production deployment (Railway, managed DB/Redis, CI/CD)

## Key Technical Decisions Still Open

- **MCP integration architecture**: Build custom MCP servers per tool, use community MCP servers where available, or wrap REST APIs directly? Need to evaluate per-tool. Some tools (GA4, Mailchimp) have community MCP servers. Others (Customer.io, Meta Ads) need custom implementation. The Tool Registry provides the abstraction layer regardless of approach.
- **OAuth2 flow**: Many Google APIs (GA4, Search Console, GTM, Ads) require OAuth2 user consent. Need a credential management system with token refresh. The credential reference pattern (`tools.yaml` → env vars) is established; Phase 4 implements the actual OAuth flows.
- **CMS selection**: Support WordPress (REST API) first — largest market share. Webflow second. Headless CMS (Contentful/Sanity) third. Tool Registry allows users to connect whichever they use.
- **ESP selection**: Mailchimp (SMB) vs Customer.io (product-led) vs Resend (developer). Tool Registry + ESP abstraction layer lets users choose.
- **File workspace vs PostgreSQL**: File workspace works for single-machine dev. Production needs PostgreSQL. Migration in Phase 6, but schema design should start in Phase 4.
- **Deployment target**: Railway for initial deployment. Docker Compose for self-hosted. Consider Fly.io as failover.
- **Cost management**: CostTracker infrastructure is built. Phase 4 will validate against real spend patterns when agents make real API calls to external tools.
- **Rate limiting across tools**: Each external API has its own rate limits. The Tool Registry includes per-tool configuration; Phase 4 implements the actual limiters.
- **Hot-reload vs restart**: Config changes currently require restart. Phase 6 dashboard could support hot-reload (change YAML → system picks up changes without downtime). Decision deferred to Phase 6.
