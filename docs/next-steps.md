# Next Steps — Phase 2 and Beyond

## Phase 2: Runtime Engine (Weeks 5-8)

Priority order:

1. **Entry point / CLI** — `bun run start` that accepts a goal string and runs the full pipeline. This is the single most important missing piece.

2. **Real Claude API integration** — Replace MockClaudeClient with real AnthropicClaudeClient. Test with actual prompts. Validate that skill prompts produce useful marketing output.

3. **Redis + BullMQ** — Stand up Redis (local Docker or Railway), connect TaskQueueManager to real queues. Test priority routing, failure recovery.

4. **Scheduler** — Cron-based pipeline triggers: daily social content, weekly content pipeline, monthly CRO sprint. Use `node-cron` or BullMQ's built-in repeat.

5. **Event bus** — Webhook receiver that maps external signals (traffic drops, conversion changes) to pipeline triggers.

6. **Basic observability** — Structured logging (pino), execution timing, cost tracking to file/stdout.

## Phase 3: Feedback Loop (Weeks 9-12)

- Measure squad agents produce real metrics reports
- Director reads metrics and adjusts strategy
- Learning memory accumulates what worked/failed
- Auto-iteration: Director re-runs pipelines based on data

## Phase 4: Scale (Weeks 13-16)

- Multi-goal parallel execution
- PostgreSQL for durable state (replace file workspace for production)
- Rate limiting and cost guardrails at scale

## Phase 5: Autonomy (Weeks 17-20)

- Self-healing pipelines
- Automatic budget reallocation
- Anomaly detection triggers

## Key Technical Decisions Still Open

- **File workspace vs PostgreSQL**: File workspace works for single-machine dev. Production needs a database. When to switch?
- **Deployment target**: Railway? Docker? Bare Bun process?
- **Agent quality validation**: How to verify Claude outputs are actually good marketing? Human review loop? Automated scoring?
- **Cost management**: Real Claude API costs. Need budget caps tested against actual spend.
