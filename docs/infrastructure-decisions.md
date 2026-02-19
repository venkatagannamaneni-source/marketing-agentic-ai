# Infrastructure Decisions

> **Date:** 2026-02-19
> **Status:** Approved

This document records the infrastructure choices for marketing-agentic-ai, evaluated against alternatives and finalized before Phase 1 implementation.

---

## Summary

| Layer | Choice | Phase |
|-------|--------|-------|
| **Runtime** | Bun + TypeScript | All |
| **AI SDK** | @anthropic-ai/sdk | All |
| **Database** | SQLite (bun:sqlite) → PostgreSQL (Railway/Neon) | P1 → P2+ |
| **ORM** | Drizzle ORM | All |
| **Task Queue** | In-memory → BullMQ + Redis | P1 W1-2 → P1 W3+ |
| **HTTP Framework** | Elysia | P2+ (not needed in P1) |
| **Auth** | Better Auth | P5 |
| **Billing** | Stripe (AI token billing) | P5 |
| **Deployment** | Railway → Render/Fly.io → Coolify | P1 → P4 → long-term |

---

## 1. Task Queue: BullMQ + Redis

**Chosen over:** pg-boss, Inngest, Trigger.dev, Temporal, Upstash QStash

### Why BullMQ

- Official Bun support (CI-tested, 12-83% perf improvement over Node)
- Native priority queues (P0-P3 mapping)
- Concurrency controls, rate limiting, delayed/repeatable jobs built-in
- Flow system for parent-child job dependencies
- 1.9M weekly npm downloads, 7,800+ GitHub stars
- BullBoard provides web UI for monitoring

### Why not the alternatives

| Alternative | Reason eliminated |
|-------------|------------------|
| **pg-boss** | Not officially tested on Bun. Uses `pg` driver which works but is unsupported. Smaller community (134K weekly downloads vs 1.9M). |
| **Inngest** | Durable execution is attractive (retry per step, not per job). AgentKit is purpose-built for AI agents. However, requires HTTP endpoint exposure, more opinionated architecture, and self-hosted mode is newer. Strong candidate for Phase 2+ migration if orchestration complexity warrants it. |
| **Trigger.dev** | Good waitpoint feature for Director review gates. Official Bun support. But requires Docker containers for execution — more opinionated than embedding a queue library. |
| **Temporal** | Workers do not work on Bun (Rust-level panics due to `node:v8 createHook` dependency). Hard blocker. |
| **Upstash QStash** | No user-facing priority queues. Cannot implement P0-P3 prioritization. Not self-hostable. |

### Migration path

- **Weeks 1-2:** In-memory priority queue (same `TaskQueue` interface)
- **Week 3+:** BullMQ + Redis (swap implementation, interface unchanged)
- **Phase 2+ (if needed):** Evaluate Inngest self-hosted for durable execution

---

## 2. Database: SQLite → PostgreSQL

**Phase 1:** bun:sqlite (zero infrastructure)
**Phase 2+:** PostgreSQL on Railway or Neon

### Why SQLite first

- Built into Bun (`bun:sqlite`) — zero dependencies, zero infrastructure
- Drizzle ORM supports both SQLite and PostgreSQL — switching is a one-line import change
- Single-writer constraint is fine in Phase 1 (queue serializes writes)
- Fastest development cycle (no database server to manage)

### Why PostgreSQL later

- Data model is relational (tasks, outputs, metrics, reviews)
- Concurrent writes from parallel agents (3 slots) require a real database
- PostgreSQL RLS for multi-tenancy in Phase 5
- Railway already configured (MCP server in the project)
- Neon ($0-19/mo) offers database branching for dev/test workflows

### Why not the alternatives

| Alternative | Reason eliminated |
|-------------|------------------|
| **Supabase** | All-in-one (DB + auth + storage + realtime) is attractive for Phase 5. But $25/mo minimum for 24/7, and org/team features for end-users must be custom-built. Evaluate at Phase 5. |
| **PlanetScale** | No free tier. Pivoted to enterprise/Metal. MySQL-based (ecosystem mismatch). |
| **MongoDB** | Data is relational. Task records have statuses, priorities, foreign keys. Metrics need aggregation. SQL is the right fit. |

---

## 3. ORM: Drizzle

**Chosen over:** Prisma, raw SQL

### Why Drizzle

- Native Bun support without binary dependencies
- Schema defined in TypeScript (no `prisma generate` step)
- SQL-transparent API (`select().from().where()`) — you always know what query runs
- Supports both SQLite and PostgreSQL from the same schema definitions
- `drizzle-kit` handles migrations
- ~50KB runtime (Prisma is significantly larger)

### Why not Prisma

- Prisma 7 removed the Rust engine (major improvement), but still requires `prisma generate` codegen step
- Locked to one database per schema file (harder to switch SQLite → PostgreSQL)
- Larger bundle size
- Less SQL-transparent

---

## 4. Authentication: Better Auth

**Chosen over:** Clerk, WorkOS, Auth.js, Supabase Auth, Lucia

### Why Better Auth (Phase 5)

- Free and MIT-licensed — no per-MAU costs
- Bun-native (explicitly tested, sub-100ms cold starts)
- Built-in Organization plugin: teams, roles (owner/admin/member), invitations, dynamic RBAC
- Drizzle ORM adapter — auth data lives in the same database
- Framework-agnostic (works with Elysia, Hono, or any Bun-native framework)
- No vendor lock-in — data stays in your database

### Trade-offs accepted

- You build your own login/signup UI (no pre-built components like Clerk)
- Younger project (less battle-tested than Clerk)
- Self-hosted means you own uptime and security patches

### Fallback

If enterprise SSO/SCIM demand emerges early, **WorkOS** (1M free MAUs, enterprise-grade) is the migration path. Per-connection pricing ($125/SSO connection) is the cost trade-off.

---

## 5. Billing: Stripe

**Chosen over:** Lemon Squeezy, Paddle, Orb

### Why Stripe

- **Purpose-built AI token billing** — LLM proxy meters tokens automatically across providers
- Credit-based pricing support (buy credits, consume tokens)
- Hybrid billing (subscription tiers + usage overages)
- Acquired Metronome ($1B) for advanced usage-based billing
- 100M usage events/month capacity
- Standard pricing: 2.9% + $0.30 per transaction

### Why not the alternatives

| Alternative | Reason eliminated |
|-------------|------------------|
| **Lemon Squeezy** | Acquired by Stripe (2024). Transitioning to Stripe Managed Payments. Don't build on legacy APIs. |
| **Paddle** | Usage-based billing is clunky (one-time charges against subscriptions). 5% + $0.50 per transaction. Not designed for AI/token billing. |
| **Orb** | Best metering engine, but doesn't handle payments (still needs Stripe). Custom enterprise pricing. Evaluate at scale if pricing experimentation becomes critical. |

---

## 6. HTTP Framework: Elysia

**Chosen over:** Hono, Express, Fastify, h3/Nitro

### Why Elysia (Phase 2+)

- Built exclusively for Bun — uses Bun's uWebSockets stack directly
- Best TypeScript DX: Eden client provides tRPC-like end-to-end type safety
- Built-in WebSocket pub/sub for real-time dashboard (Phase 5)
- Auto-generates OpenAPI documentation
- AOT compilation optimizes handlers at startup
- Built-in cron plugin complements BullMQ for scheduling

### Why not the alternatives

| Alternative | Reason |
|-------------|--------|
| **Hono** | Excellent multi-runtime framework. Use as fallback for edge components if needed. Less type-safe than Elysia. |
| **Express** | Slowest, least type-safe. No reason to choose for a new Bun project in 2026. |
| **Fastify** | Designed for Node, not Bun. Unofficial Bun support. |
| **h3/Nitro** | Tied to Nuxt/Vue ecosystem. Not the best fit for a standalone API. |

### Note

Elysia is not needed in Phase 1 (CLI-only operation). It enters the picture in Phase 2 when the event bus needs an HTTP webhook listener.

---

## 7. Deployment: Railway (phased)

**Phase 1-3:** Railway (already configured, cheapest to start)
**Phase 4-5:** Evaluate Render (first-class background workers) or Fly.io (persistent VMs)
**Long-term:** Coolify on Hetzner ($5-20/mo for the full stack)

### Cost projection

| Phase | Infrastructure | Monthly Cost |
|-------|---------------|-------------|
| Phase 1 | SQLite (local), no Redis yet | $0 |
| Phase 1 W3+ | Railway (Redis) | ~$5-10 |
| Phase 2 | Railway (app + PostgreSQL + Redis) | ~$15-25 |
| Phase 3-4 | Railway or Render (app + worker + DB + Redis) | ~$25-40 |
| Phase 5 | Render/Fly.io (multi-service) | ~$50-100 |

---

## 8. Dependency Summary

### Phase 1 — Install immediately

```bash
bun add @anthropic-ai/sdk drizzle-orm zod nanoid
bun add -D drizzle-kit
```

### Phase 1 Week 3 — Add BullMQ

```bash
bun add bullmq ioredis
```

### Phase 2+ — Add HTTP framework

```bash
bun add elysia @elysiajs/cors @elysiajs/swagger
```

### Phase 2+ — Switch to PostgreSQL

```bash
bun add postgres
# or use Bun.sql (built-in, no package needed)
```

### Phase 5 — Add auth and billing

```bash
bun add better-auth stripe
```
