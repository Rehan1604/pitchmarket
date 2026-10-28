# Architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 (App Router, React 19, TypeScript 5.9) | One deployable for UI + API; server components read the database directly. |
| Rendering | Classic dynamic rendering (`cacheComponents` off) | Almost every screen is per-user and per-request. Cache Components would add a Suspense boundary per session read with little benefit. Next's docs support this "previous model"; revisit when the next major makes Cache Components mandatory. |
| Styling | Tailwind CSS 4, design tokens in `src/app/globals.css` | Dark-first "floodlit pitch" palette; Big Shoulders Display (scoreboard numerals) + IBM Plex Sans, self-hosted via Fontsource. |
| UI primitives | Radix (dialog, dropdown), hand-built components in `src/components` | Accessible primitives without a generated component kit. |
| Charts | Recharts (step line for prices, line for portfolio), SVG sparklines | |
| Database | PostgreSQL 16 | Row locks, partial unique indexes, triggers. |
| ORM / migrations | Drizzle ORM 0.45 + drizzle-kit SQL migrations (`drizzle/`) | Prisma 7's CLI downloads its migration engine from `binaries.prisma.sh`, which the build environment couldn't reach, so migrations couldn't be generated or verified. Drizzle is pure TypeScript, emits reviewable SQL, and supports `FOR UPDATE`/`FOR SHARE` directly. |
| Auth | Own implementation: argon2id (`@node-rs/argon2`), database sessions | No external auth dependency; works on any Postgres. See Security. |
| Validation | Zod 4 on every API input | |
| Tests | Vitest 4 (unit + integration against real Postgres), Playwright 1.63 (E2E) | |

## Layout

```
src/
  app/                    routes (pages + /api route handlers)
    (app)/…               authenticated app shell: dashboard, market, players/[slug], portfolio,
                          leaderboard, social, leagues/[id], fixtures, activity, settings, admin, u/[username]
    (auth)/…              login, signup, forgot-password, reset-password
    onboarding/, join/[code]/, page.tsx (landing)
    api/…                 JSON API (thin wrappers over src/server)
  proxy.ts                optimistic signed-out redirect (Next 16 "proxy", formerly middleware)
  components/             UI (shell, market, social, settings, admin, ui primitives)
  db/                     Drizzle schema, client, migrator
  lib/                    shared, browser-safe helpers (money, formatting, API client)
  server/                 domain services (framework-independent, integration-tested)
    auth/  trading/  portfolio/  leaderboard/  social/  market/  ingestion/  admin/
scripts/                  migrate, seed, ingest, worker, derive-model, demo-users, grant-admin
data/priors/              last-season player priors (generated, committed)
drizzle/                  SQL migrations (generated + one hand-written for ledger triggers)
tests/unit|integration|e2e
docs/
```

## Sources of truth

| Data | Authoritative source | Derived / cached |
|---|---|---|
| Cash | `cash_entries` (append-only ledger) | `cash_accounts.balance_cents`, updated in the same transaction under a row lock |
| Holdings | `trades` (append-only ledger) | `positions` (quantity, cost basis, realised P/L) |
| Prices | `price_ticks` (append-only history) | `player_prices` (latest + engine state) |
| Football data | `competitions`, `clubs`, `players`, `fixtures`, `player_match_stats` | each row carries provider, provider ref and source timestamps |
| Rankings | computed on read from the above | `portfolio_snapshots` (start-of-day values for day/week views) |

Database triggers block `UPDATE`/`DELETE` on `trades`, `cash_entries` and
`price_ticks`. The admin page runs invariant checks: every cash balance equals its
ledger, every position equals its trades, and every trade has its cash entry.

Money is stored as integer cents (`BIGINT`) and handled as JS safe integers with
guards (`src/lib/money.ts`). Proportional basis uses BigInt intermediates. No
floating point touches balances.

## Data pipeline

```
          ┌────────────── provider adapters (src/server/ingestion/providers) ──────────────┐
          │ FplApiProvider (live)   FplArchiveProvider (GitHub snapshot)   FootballDataProvider │
          └───────────────┬─────────────────────────────────────────────────────┬──────────────┘
                          │ normalised: competition, clubs, players, fixtures,  │ fixtures only
                          │ per-player match stats (null = unavailable)          │
                   pipeline.ts: syncFixtures → syncReference (IPO) → syncStats (live ticks, settlement)
                          │
     scheduler.ts runSchedulerTick(): decides what's due, Postgres job locks, freshness auto-halt
                          │
   triggers: in-process scheduler (instrumentation.ts)  ·  /api/cron/tick (GitHub Actions wake-up, Vercel Cron, any cron)  ·  npm run worker  ·  admin "Run now"
```

* **Adapters** implement `MarketDataProvider` (tradable, with player stats) or
  `FixtureOnlyProvider`. Adding a provider means writing one adapter; trading,
  pricing and UI don't change.
* **`DATA_PROVIDER=auto`** probes the live FPL API; if unreachable it uses the
  GitHub snapshot and records `data_mode = snapshot`, which the whole UI surfaces.
  The choice is re-probed every 30 minutes.
* **Resilience:** timeouts, bounded exponential backoff with jitter on 5xx and
  network errors, immediate surfacing of HTTP 429 with `Retry-After`, and
  provider-level backoff (`provider_status.next_allowed_at`). Every run is recorded
  in `ingestion_runs`.
* **Idempotency:** stats rows are written only when their fingerprint changes;
  settlement is exactly-once per fixture (row lock + `settled_at`) and per player
  (unique final tick); IPO is exactly-once per player.
* **Cadence (live mode):** fixtures every 90 s near kick-off (15 min otherwise),
  stats every `LIVE_POLL_SECONDS` (default 60 s) while matches are live, every 4 min
  while finished matches await final stats, players and availability every 6 h, a
  daily snapshot, and cleanup. Snapshot mode polls hourly.

## Live UI updates

The shell polls `GET /api/market/status` every 20 s while the tab is visible. When
`marketVersion` changes, it calls `router.refresh()`, so server components
re-render with new prices. This works on serverless hosts without long-lived
connections. The status pill shows live/snapshot mode, data age and halts.

## Security

* **Passwords:** argon2id (19 MiB, t=2), policy checks, timing-equalised unknown-user path.
* **Sessions:** 256-bit random token in an `httpOnly`, `SameSite=Lax`, `Secure`
  (production) cookie. Only its SHA-256 is stored. Sliding expiry. Password
  change or reset revokes all sessions.
* **CSRF:** SameSite cookies, plus an Origin/`Sec-Fetch-Site` check on every
  state-changing API request (`route()` in `src/server/http.ts`).
* **Authorisation** is on the server for every page and route. Private leagues
  return 404 to non-members. Friend requests can only be answered by the
  recipient. Admin requires `role = admin`, granted only via `npm run admin:grant`,
  which needs database access, so there's no web backdoor.
* **Rate limits** (Postgres fixed window): sign-up, sign-in (per IP and per
  account), password reset, trades (30/min), friend requests, league creation,
  invite lookups/joins, search, admin manual runs.
* **Headers:** CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, HSTS in production. The CSP allows inline scripts because
  Next.js bootstraps with them; a nonce-based CSP is a possible hardening step.
* **Privacy:** emails are never shown to other users. Holdings and activity
  follow the owner's visibility settings. Portfolio value and return appear on
  leaderboards (disclosed at sign-up), with a global opt-out. Deleting an account
  anonymises the user, removes social data, and keeps immutable ledgers for
  league integrity.
* **Secrets** are server-only (`src/server/env.ts` is `server-only`). No provider
  key reaches the browser. Logs are structured JSON with sensitive keys redacted.
* **Least privilege:** run the app with a database role that can read/write tables
  but not alter schema, and run migrations with the owner role (see DEPLOYMENT.md).

Known limits: there's no email verification, so one person can open several
accounts (sign-ups are rate-limited per IP). Password reset needs `RESEND_API_KEY`
in production.
