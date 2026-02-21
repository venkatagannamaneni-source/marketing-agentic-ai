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

## Phase 4: Tool Integration + Real Execution (Weeks 13-20)

The execution phase. Connect agents to real tools via MCP servers so they act, not just advise.

### 4a: Analytics & Measurement (Weeks 13-14)
- GA4 MCP — read real traffic, conversion, bounce data
- Google Search Console MCP — read real rankings, impressions, index coverage
- Google Tag Manager MCP — deploy tracking events without code changes
- PageSpeed Insights MCP — run real Lighthouse audits

### 4b: Content Publishing (Weeks 15-16)
- WordPress MCP — publish posts, pages, structured data
- Webflow MCP — publish to CMS collections
- GitHub MCP — create PRs for template pages, schema changes
- Playwright page analysis — analyze real pages (already installed)

### 4c: Email & Marketing Automation (Weeks 17-18)
- Mailchimp MCP — create campaigns, automations, read engagement
- Customer.io MCP — behavior-triggered workflows, activation sequences
- Resend MCP — transactional email
- ESP-agnostic abstraction layer — unified interface across email providers

### 4d: Advertising & Social (Weeks 19-20)
- Google Ads MCP — create campaigns, read performance (CPC, ROAS)
- Meta Ads MCP — create campaigns, audience targeting, read ROAS
- Social media MCP — schedule posts to LinkedIn, Twitter/X via Buffer
- Stripe MCP — read MRR, churn, plan distribution, trial conversions

## Phase 5: Feedback Loops + Self-Optimization (Weeks 21-26)

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

## Phase 6: Dashboard, API + Multi-tenancy (Weeks 27-34)

The product phase. Turn the engine into a commercial SaaS.

- PostgreSQL migration (replace file workspace for production)
- REST API (goals, tasks, pipelines, outputs, metrics, health)
- WebSocket real-time updates
- Web dashboard (goal management, pipeline monitor, analytics, escalation center)
- MCP integration manager (connect tools via web UI)
- Product context editor (guided wizard)
- Authentication + authorization (email/OAuth, RBAC)
- Multi-tenancy (per-tenant isolation)
- Billing (Stripe, usage-based plans)
- Onboarding flow (15-minute time-to-value target)
- Production deployment (Railway, managed DB/Redis, CI/CD)

## Key Technical Decisions Still Open

- **MCP integration architecture**: Build custom MCP servers per tool, use community MCP servers where available, or wrap REST APIs directly? Need to evaluate per-tool. Some tools (GA4, Mailchimp) have community MCP servers. Others (Customer.io, Meta Ads) need custom implementation.
- **OAuth2 flow**: Many Google APIs (GA4, Search Console, GTM, Ads) require OAuth2 user consent. Need a credential management system with token refresh. Phase 4 prerequisite.
- **CMS selection**: Support WordPress (REST API) first — largest market share. Webflow second. Headless CMS (Contentful/Sanity) third. Can't support all at once; need adapter pattern.
- **ESP selection**: Mailchimp (SMB) vs Customer.io (product-led) vs Resend (developer). Build unified interface, let user choose.
- **File workspace vs PostgreSQL**: File workspace works for single-machine dev. Production needs PostgreSQL. Migration in Phase 6, but schema design should start in Phase 4.
- **Deployment target**: Railway for initial deployment. Docker Compose for self-hosted. Consider Fly.io as failover.
- **Cost management**: CostTracker infrastructure is built. Phase 4 will validate against real spend patterns when agents make real API calls to external tools.
- **Rate limiting across tools**: Each external API has its own rate limits. Need per-tool rate limiting in addition to Claude API rate limiting. Phase 4 concern.
