> **Live demo:** https://lead-cockpit-demo.onrender.com — opens in a demo workspace for an invented company (Meghdoot Zari & Trims). No sign-up needed.

# LeadCockpit — Agentic B2B CRM + Lead Generation

LeadCockpit is an **agentic B2B CRM**. It is CRM software first, with AI agents
embedded inside CRM workflows (leads, accounts, contacts, conversations, tasks,
campaigns, pipeline, replies) — *not* a scraper or a chatbot bolted onto a CRM.

The first test company is Balaji Zari Udyog (textile/zari), but the product is
built to stay **generic** for any B2B business.

> **Status:** Demo/development. The default runtime is local JSON. Production
> deployment (PostgreSQL, real auth, live integrations) is gated behind the
> production-readiness checks — see `npm run check:production`.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000 — demo mode, no keys required
```

The app boots in **demo mode** (`AUTH_MODE=demo`, JSON persistence). You can
test onboarding, knowledge extraction, lead review, manual outreach, WhatsApp
dry-runs, and the AI review queue without any paid API keys — the LLM layer
falls back to Mock providers and reports that honestly.

### Run the tests

```bash
npm run test:smoke                 # main MVP flow
npm run test:smoke:crm-workflow    # lead review + enrichment + draft
npm run test:smoke:prospecting     # Google Maps search + crawler
npm run test:smoke:rbac            # RBAC role-mapping (unit, no server)
# Stage A (2026-07-26) — Prisma-mode tests require DATABASE_URL set:
npm run test:smoke:prisma-auth     # Postgres auth round-trip (login, session, RBAC)
npm run test:smoke:prisma-runtime  # Postgres repository round-trip
# Golden tests (hand-computed math — see docs/PRD.md §7):
npm run golden:llm-adapters        # LLM adapter contracts (no API key needed)
# full list: see package.json "scripts"
```

### Typecheck & build

```bash
npx tsc --noEmit
npm run lint
npm run build
```

---

## What it does

- **Knowledge Base:** upload documents / paste text / scan your website (with
  consent) → the agent answers a 523-question internal framework, grouped into
  12 business-friendly domains. You approve answers; conflicts become review
  cards. Sensitive fields (price, credit, delivery, returns) ALWAYS require
  human review — never auto-written.
- **Prospecting:** discover B2B leads via Google Maps search (SerpApi) +
  website crawler, scored against your ICP.
- **Lead review:** human-in-the-loop approve / reject / enrich with full audit
  trail. DNC (do-not-contact) is immediate and permanent.
- **Outreach:** message drafts generated and reviewed before any send. **No
  automatic customer-facing outreach** — WhatsApp/Gmail stay draft/manual/dry-run.
- **Conversations:** inbound WhatsApp Cloud webhooks are received and classified
  (with HMAC signature verification); auto-replies are held for human review.
- **AI Review Queue:** every agent draft that touches a sensitive topic or
  low-confidence answer waits for your approval.

---

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript 5 (strict) + Tailwind v4
- Prisma 7 + PostgreSQL (production runtime); local JSON (default demo runtime)
- Catch-all API route → services → repositories → JSON/Prisma
- LLM layer: Mock (default fallback), OpenAI-compatible, Gemini, Ollama

---

## Configuration

Copy `.env.example` → `.env`. Key variables:

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_MODE` | `demo` | `demo` / `local` / `production` |
| `PERSISTENCE_PROVIDER` | `json` | `json` / `prisma` |
| `AUTH_SESSION_SECRET` | — | ≥32 chars, required for production auth |
| `ENCRYPTION_KEY` | — | AES-256-GCM for credential encryption |
| `DATABASE_URL` | — | PostgreSQL connection (Prisma mode) |
| `PLATFORM_SERPAPI_API_KEY` | — | Google Maps prospecting search |
| `WHATSAPP_*` | — | Cloud API (live send disabled until configured) |

**Never commit `.env`.** See `AGENTS.md` → "Configuration & secrets".

---

## Architecture & docs

- `AGENTS.md` — **read this first** if you're working on the codebase (rules, boundaries, security infrastructure).
- `LEADCOCKPIT_PRODUCT_OBJECTIVE.md` — authoritative product vision and non-negotiable rules.
- `PLAN.md` — current implementation plan and acceptance tests.
- `docs/` — short reference docs per area (ARCHITECTURE, LLM_ARCHITECTURE, KNOWLEDGE_BASE, AUTH_ROADMAP, API, etc.).
- `docs/planning/` — audit findings, stage plans, verification reports.

## Production readiness

Production is **not** enabled by default. Stage A (2026-07-26) made the
backend fully production-capable (real Postgres + real auth + real LLM
adapters), but the cutover is **operator-controlled** — your `.env` stays in
demo mode until you flip it.

**Full step-by-step cutover guides** (with troubleshooting):
- **`docs/STAGE_A_CUTOVER_RUNBOOK.md`** — Neon Postgres + real auth + bootstrap owner
- **`docs/STAGE_B_WHATSAPP_RUNBOOK.md`** — Meta Business setup + WhatsApp Cloud API keys + test-connection

Quick summary of the env-var flips:

1. Set `AUTH_MODE=production` + a strong `AUTH_SESSION_SECRET` (≥32 chars).
2. Set `PERSISTENCE_PROVIDER=prisma` + a real `DATABASE_URL` (Neon) and run migrations (`npx prisma migrate deploy`).
3. Set `ENCRYPTION_KEY` (≥16 chars) for credential encryption.
4. **Bootstrap the owner account** — the demo owner doesn't exist in Postgres; run `npm run bootstrap:owner -- --email <you@example.com> --password '<min-8-chars>' --name "Your Name"` once (or use the web setup screen on first visit).
5. Configure real LLM provider keys (mock fallback can stay on as a safety net).
6. Configure WhatsApp Cloud webhook secret + verify token (if using WhatsApp) — then click "Test connection" in the Integrations tab.

Run the gate:

```bash
npm run check:production            # report mode
npm run check:production -- --strict # exit 1 on any fail
```

This scans the data store for real scrypt-hashed credentials and legacy-insecure
credentials, and reports whether production auth/encryption/webhook config is in place.
