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

## Phase 3: Intelligence + Semantic Review (Weeks 9-12) — NEXT

The quality phase. Replace structural pattern-matching with Claude-powered semantic evaluation.

### Priority order:

1. **Claude-powered semantic review** — Replace structural-only ReviewEngine with Claude-powered evaluation. Director sends output + task requirements + SKILL.md quality criteria to Claude and gets real APPROVE/REVISE/REJECT decisions with specific, actionable feedback.

2. **Quality scoring model** — Define scoring rubric per agent type (copy quality, SEO quality, CRO quality). Director assigns numeric quality scores (1-10) that feed into learnings and enable comparison.

3. **Multi-pass review chains** — Creative outputs go through review chains: copywriting → copy-editing → page-cro review → Director final approval. Each reviewer uses Claude for real feedback.

4. **Revision loops with real feedback** — When Director sends REVISE, the revision request includes specific Claude-generated feedback. Agents re-execute with both original task and revision notes, producing genuinely improved output.

5. **Learning validation** — A/B test: run tasks with and without past learnings context. Measure quality score difference. Validate the memory system actually helps. Prune learnings that don't improve output.

6. **Cross-agent consistency check** — Director validates consistency across a pipeline's outputs: email copy matches landing page, social content aligns with blog post, etc.

## Phase 3b: Platform Hardening — Extensibility Layer (Weeks 12-14)

**The phase that turns a hardcoded system into a configurable product.** This is a prerequisite for Phase 4's MCP tool integrations and Phase 6's multi-tenancy. Without it, every new skill, squad, or tool integration requires modifying TypeScript source files in 5+ locations.

### Why this phase exists

This system is a product — Claude Code for Marketing. Users connect their own tools (GA4, Webflow, Mailchimp, Stripe) and the engine operates against their real stack. That model requires:
- Skills, squads, and routing rules as **configuration** (not hardcoded arrays)
- A **Tool Registry** where users declare which MCP servers to connect
- A **dynamic Director prompt** that always matches the actual registry
- A **validation layer** that catches config errors before runtime

### Priority order:

1. **Externalize skill registry** (Week 12) — Move `SKILL_NAMES`, `SKILL_SQUAD_MAP`, `AGENT_DEPENDENCY_GRAPH` from TypeScript `as const` arrays into a `skills.yaml` config file. Skill loader reads config at startup, builds registry dynamically. Adding a skill = YAML entry + SKILL.md file. No code changes.

2. **Dynamic Director prompt** (Week 12) — Replace hardcoded `DIRECTOR_SYSTEM_PROMPT` ("26 agents, 5 squads") with `buildDirectorPrompt(registry)` that generates the prompt from the live skill registry. Squad listings, agent descriptions, decision rules all derived from config.

3. **MCP Tool Registry + abstraction layer** (Week 13) — Create `ToolRegistry` interface: `registerTool(name, mcpConfig)`, `getToolsForSkill(skillName)`, `invokeTool(name, action, params)`. Executor passes available tools to Claude's tool_use API. Foundation for all Phase 4 integrations.

4. **User tool configuration** (Week 13) — Create `tools.yaml` where users declare their connected tools: MCP server references, credential env var names, and which skills get access. The "onboard a new hire" experience.

5. **Externalize routing, schedules, events** (Week 14) — Move `ROUTING_RULES`, `DEFAULT_SCHEDULES`, `DEFAULT_EVENT_MAPPINGS` to config files. Users can customize which pipelines run on what schedule and which events trigger which responses.

6. **Single source of truth + validation CLI** (Week 14) — Merge duplicate budget thresholds. `bun run validate-skills` verifies config integrity: every skill has SKILL.md, valid squad, valid dependency edges, declared tools match available MCP servers.

### What this enables:

```
Adding a new skill (BEFORE):  5 TypeScript file edits + recompile + redeploy
Adding a new skill (AFTER):   1 YAML entry + 1 SKILL.md file

Connecting a tool (BEFORE):   No way to do it — hardcoded system
Connecting a tool (AFTER):    1 tools.yaml entry + install MCP server

Director prompt (BEFORE):     Hardcodes "26 agents, 5 squads" — breaks if anything changes
Director prompt (AFTER):      Auto-generated from live registry — always correct
```

## Phase 4: Tool Integration + Real Execution (Weeks 15-22)

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

## Key Technical Decisions Still Open

- **MCP integration architecture**: Build custom MCP servers per tool, use community MCP servers where available, or wrap REST APIs directly? Need to evaluate per-tool. Some tools (GA4, Mailchimp) have community MCP servers. Others (Customer.io, Meta Ads) need custom implementation. Phase 3b's Tool Registry provides the abstraction layer regardless of approach.
- **OAuth2 flow**: Many Google APIs (GA4, Search Console, GTM, Ads) require OAuth2 user consent. Need a credential management system with token refresh. Phase 3b establishes the credential reference pattern (`tools.yaml` → env vars); Phase 4 implements the actual OAuth flows.
- **CMS selection**: Support WordPress (REST API) first — largest market share. Webflow second. Headless CMS (Contentful/Sanity) third. Tool Registry allows users to connect whichever they use.
- **ESP selection**: Mailchimp (SMB) vs Customer.io (product-led) vs Resend (developer). Tool Registry + ESP abstraction layer lets users choose.
- **Config format**: YAML vs JSON for `skills.yaml` and `tools.yaml`. YAML is more human-readable. JSON is stricter. Decision needed at Phase 3b start.
- **File workspace vs PostgreSQL**: File workspace works for single-machine dev. Production needs PostgreSQL. Migration in Phase 6, but schema design should start in Phase 4.
- **Deployment target**: Railway for initial deployment. Docker Compose for self-hosted. Consider Fly.io as failover.
- **Cost management**: CostTracker infrastructure is built. Phase 4 will validate against real spend patterns when agents make real API calls to external tools.
- **Rate limiting across tools**: Each external API has its own rate limits. Phase 3b's Tool Registry should include per-tool rate limit configuration. Phase 4 implements the actual limiters.
- **Hot-reload vs restart**: Phase 3b config changes require restart. Phase 6 dashboard could support hot-reload (change tools.yaml → system picks up changes without downtime). Decision deferred to Phase 6.
