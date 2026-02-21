# Next Steps — Phase 3 and Beyond

## Phase 2: Runtime Engine (Weeks 5-8) — COMPLETE

All 9 work streams delivered:
- Entry point / CLI with 3 modes (goal, pipeline, daemon)
- Real Claude API integration (AnthropicClaudeClient)
- Redis + BullMQ real queue adapters + Docker Compose
- Cron-based scheduler with 6 default schedules
- Event bus with webhook receiver and 5 default mappings
- Structured logging (pino), cost tracking, metrics, health monitoring
- Memory system (agents read past learnings)
- Full bootstrap composition root wiring 14 modules
- 1447 tests across 67 files

See [docs/phase-2-status.md](phase-2-status.md) for the honest assessment.

## Phase 3: Feedback Loop (Weeks 9-12)

Priority order:

1. **Real Director reviews via Claude** — Replace structural-only review with Claude-powered semantic evaluation. The ReviewEngine currently pattern-matches; it should send the output + task requirements to Claude and get a real APPROVE/REVISE/REJECT decision.

2. **Measure squad produces real metrics** — Analytics-tracking, ab-test-setup, and seo-audit agents should read real data sources (GA4, Search Console) and produce metrics reports that the Director can act on.

3. **Director reads metrics and adjusts strategy** — Close the feedback loop: Director reads metrics from Measure squad, identifies underperformance, and re-runs relevant pipelines with adjusted goals.

4. **Learning memory validation** — Measure whether agents actually improve when given past learnings. Compare output quality with/without learnings context.

5. **External data integrations** — MCP connections to GA4, Google Search Console, and CMS (WordPress/Webflow) for real data input.

## Phase 4: Scale (Weeks 13-16)

- Multi-goal parallel execution (multiple goals running simultaneously)
- PostgreSQL for durable state (replace file workspace for production)
- Rate limiting and cost guardrails at scale
- CI/CD pipeline and deployment automation
- Production Redis deployment (managed service)

## Phase 5: Autonomy (Weeks 17-20)

- Self-healing pipelines (auto-retry with strategy adjustment)
- Automatic budget reallocation based on ROI data
- Anomaly detection triggers (from metrics to action)
- Web dashboard / REST API for human oversight
- Multi-tenancy and authentication

## Key Technical Decisions Still Open

- **File workspace vs PostgreSQL**: File workspace works for single-machine dev. Production needs a database. Phase 4 target.
- **Deployment target**: Railway? Docker? Bare Bun process? Need to decide before Phase 3 external integrations.
- **Agent quality validation**: How to verify Claude outputs are actually good marketing? Phase 3 should introduce Claude-powered review to replace structural-only checks.
- **Cost management**: Real Claude API costs need monitoring. CostTracker infrastructure is built; need to validate against actual spend patterns.
- **MCP integration architecture**: How to connect GA4, Search Console, CMS. MCP tools vs direct API calls vs webhooks.
