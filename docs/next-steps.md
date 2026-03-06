# Next Steps — Phase 3 and Beyond

## Phase 1: Director + Orchestration Engine (Weeks 1-4) — COMPLETE ✓

14 modules, 1472+ tests, 68 files. Real Claude API integration verified with 23 live API tests.

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
- 1472+ tests across 68 files

See [docs/phase-2-status.md](phase-2-status.md) for the honest assessment.

## Phase 3: Intelligence + Semantic Review (Weeks 9-12) — COMPLETE ✓

The quality phase. Replaced structural pattern-matching with Claude-powered semantic evaluation.

All 6 deliverables shipped:

1. **Claude-powered semantic review** ✓ — ReviewEngine uses Claude (Sonnet/Opus) for real APPROVE/REVISE/REJECT decisions with skill-aware context. Three depth levels: quick (structural), standard (Sonnet), deep (Opus + SKILL.md). Graceful fallback when client unavailable.

2. **Quality scoring model** ✓ — QualityScorer with 7 dimensions (completeness, clarity, actionability, brand_alignment, data_driven, technical_accuracy, creativity). Both structural (free heuristic) and semantic (Claude Opus) scoring. Weighted averaging, configurable thresholds.

3. **Multi-pass review chains** ✓ — Pipeline `review` step type enables chains like copywriting → copy-editing → page-cro → Director. Each reviewer receives previous output as input. Both agent and director reviewers supported.

4. **Revision loops with real feedback** ✓ — Structured `revisionFeedback` array with {description, priority}. Prompt builder renders feedback in dedicated `<revision-feedback>` section. Agents re-execute with original task + specific revision notes.

5. **Learning validation (A/B testing)** ✓ — LearningValidator runs tasks WITH and WITHOUT learnings, compares quality scores. Tracks averageLift, topPerformingSkills, recommendPruning. Enables data-driven learning retention.

6. **Cross-agent consistency check** ✓ — ConsistencyChecker validates tone, terminology, messaging, style across pipeline outputs. Both structural (heuristic) and semantic (Claude Sonnet) checks. Produces alignmentScore (0-10) with specific inconsistency findings.

## Phase 3b: Platform Hardening — Extensibility Layer (Weeks 12-14) — COMPLETE ✓

**Turned the hardcoded system into a configurable product.** Foundation for Phase 4's MCP tool integrations and Phase 6's multi-tenancy.

All 6 deliverables shipped:

1. **Externalize skill registry** ✓ — `.agents/skills.yaml` with SkillRegistry class. 26 skills, 5 squads loaded dynamically. Adding a skill = 1 YAML entry + 1 SKILL.md file.

2. **Dynamic Director prompt** ✓ — `buildDirectorPrompt(registry)` generates prompt from live registry. Squad listings, agent descriptions, decision rules all derived from config.

3. **MCP Tool Registry + abstraction layer** ✓ — ToolRegistry with `fromYaml`, `getToolsForSkill`, cross-validation. Foundation for Phase 4 integrations.

4. **User tool configuration** ✓ — `.agents/tools.yaml` where users declare connected tools with MCP server references, credential env vars, and skill bindings.

5. **Externalize routing, schedules, events, pipelines** ✓ — 4 YAML config files (`.agents/routing.yaml`, `schedules.yaml`, `events.yaml`, `pipelines.yaml`) with 4 registry classes (RoutingRegistry, ScheduleRegistry, EventRegistry, PipelineTemplateRegistry). All with validation, cross-validation, and fallback to hardcoded defaults.

6. **Validation CLI** ✓ — `bun run validate-config` checks all 7 config files + SKILL.md presence. 9 checks, cross-validates skill references across registries.

**Production hardening** ✓ — YAML parse error wrapping, required field validation, non-string type rejection, event.data null guards, trigger validation, RoutingRegistry wired into MarketingDirector.

**Current test count:** 1829 pass, 25 skip, 0 fail across 81 files.

### What this enables:

```
Adding a new skill (BEFORE):  5 TypeScript file edits + recompile + redeploy
Adding a new skill (AFTER):   1 YAML entry + 1 SKILL.md file

Connecting a tool (BEFORE):   No way to do it — hardcoded system
Connecting a tool (AFTER):    1 tools.yaml entry + install MCP server

Director prompt (BEFORE):     Hardcodes "26 agents, 5 squads" — breaks if anything changes
Director prompt (AFTER):      Auto-generated from live registry — always correct
```

## Phase 4: Tool Integration + Real Execution (Weeks 15-22) — NEXT

The execution phase. With the Tool Registry from Phase 3b in place, connect agents to real tools via MCP servers. Users configure which tools to connect through `tools.yaml` — the system discovers and binds tools to agents automatically.

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

## Key Technical Decisions

### Resolved ✓
- **Config format**: YAML — more human-readable, adopted across all 7 config files.
- **MCP integration architecture**: Hybrid approach — community MCP servers where available, custom implementations where needed. ToolRegistry abstracts the difference.

### Still Open
- **OAuth2 flow**: Many Google APIs (GA4, Search Console, GTM, Ads) require OAuth2 user consent. Need a credential management system with token refresh. Phase 3b established the credential reference pattern (`tools.yaml` → env vars); Phase 4 implements the actual OAuth flows.
- **CMS selection**: Support WordPress (REST API) first — largest market share. Webflow second. Headless CMS (Contentful/Sanity) third. Tool Registry allows users to connect whichever they use.
- **ESP selection**: Mailchimp (SMB) vs Customer.io (product-led) vs Resend (developer). Tool Registry + ESP abstraction layer lets users choose.
- **File workspace vs PostgreSQL**: File workspace works for single-machine dev. Production needs PostgreSQL. Migration in Phase 6, but schema design should start in Phase 4.
- **Deployment target**: Railway for initial deployment. Docker Compose for self-hosted. Consider Fly.io as failover.
- **Cost management**: CostTracker infrastructure is built. Phase 4 will validate against real spend patterns when agents make real API calls to external tools.
- **Rate limiting across tools**: Each external API has its own rate limits. ToolRegistry should include per-tool rate limit configuration. Phase 4 implements the actual limiters.
- **Hot-reload vs restart**: Config changes currently require restart. Phase 6 dashboard could support hot-reload. Decision deferred to Phase 6.
