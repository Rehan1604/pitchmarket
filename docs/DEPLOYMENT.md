# Deployment

Two free setups are documented. Both use **Neon Postgres (free)**.

* **Render (free web service) — recommended.** The app runs as one long-lived
  Node process with the market scheduler built in, so live in-play pricing
  works without any external cron service.
* **Vercel (Hobby).** Serverless; needs an external scheduler calling
  `/api/cron/tick` every minute on match days.

Anything that runs Node 20.9+ and can reach Postgres also works (see "Any Node host").

## Free-tier budgets (why the scheduler is match-aware)

| Limit | What PITCHMARKET does about it |
|---|---|
| Neon Free: 100 CU-hours per project per month, compute sleeps after 5 idle minutes, 0.5 GB storage | Cap the compute at **0.25 CU** (Neon → Branch → Compute → Edit). The scheduler only queries the database every minute around matches; otherwise it waits until shortly before the next kickoff, so Neon can sleep between match days. Open browser tabs stop polling when hidden. |
| Render Free: sleeps after 15 minutes without inbound traffic; 750 instance-hours per workspace per month shared by **all** free services | The server pings its own `/api/health` (no database) **only** while a match is live, within 90 minutes of kickoff, or awaiting settlement. The rest of the week it sleeps and costs no instance-hours. |
| A sleeping server can't wake itself before kickoff | `.github/workflows/market-tick.yml` runs hourly, checks the public fixture list and calls `/api/cron/tick` only when a match is near. Hourly ≈ 720 Actions minutes/month: free on public repos, inside the 2,000 free minutes on private ones. |
| Render's build machines | Builds run on separate compute (8 GB RAM on the default pipeline), so the ~1 GB `next build` peak is fine. Runtime uses ~250 MB on a 512 MB instance; the start command caps the heap at 320 MB. |

Rough monthly usage with a normal Premier League schedule: ~100–150 Render
instance-hours and ~30–45 Neon CU-hours, plus whatever your players' own visits add.
With the ESPN leagues enabled there are matches on most days (weekend afternoons
and evenings, Champions League Tuesdays and Wednesdays): expect roughly
**200–300 instance-hours and 50–75 Neon CU-hours** a month. That fits Neon's 100
CU-hours, but if your Render workspace runs other free services, their hours share
the same 750. To trim, drop competitions from `ESPN_LEAGUES` (e.g. keep `esp.1,uefa.champions`).

Storage: with ~4,200 listed players the database grows by roughly 100–200 MB per
season (Neon Free has 0.5 GB). Live history is only written when something happens
in a match, which is what keeps it inside the limit.

## A. Render + Neon (recommended)

### 1. Database (Neon)

1. Create a Neon project (any region; pick the one closest to your Render region).
2. Copy the **pooled** connection string (Dashboard → Connect → "Connection
   pooling" on). Use `?sslmode=verify-full` (node-postgres already treats `require`
   that way and logs a warning for it); remove `&channel_binding=require` if present.
3. Branch → Computes → Edit → set autoscaling max to **0.25 CU**.
4. Optional least-privilege role: see "Least-privilege database role" below.

### 2. Web service (Render)

The repo contains a Blueprint (`render.yaml`):

1. Push the code to GitHub (public or private).
2. Render Dashboard → **New → Blueprint** → choose the repo. Fill the prompted values:
   * `DATABASE_URL`: the Neon pooled string.
   * `APP_URL`: `https://<service-name>.onrender.com`. You can set it after the first
     deploy, once Render shows the URL.
3. Render builds with `npm ci && npm run db:migrate && npm run build`, so migrations
   are applied on every deploy. The start command runs Next directly with a heap cap.
4. On first boot the in-process scheduler sees an empty market and loads it
   (fixtures, ~670 players, settled matches). That takes 15–30 s, then `/api/ready` turns `200`.
   With ESPN enabled, the first tick also loads every ESPN fixture and squad
   (~3,500 players), then replays this season's ESPN matches 40 at a time every 20
   seconds; expect 10–20 minutes until every league's prices are caught up.

Manual setup instead of the Blueprint: New → Web Service → the repo, runtime
Node, plan Free, the build and start commands from `render.yaml`, health check
path `/api/health`, and the same environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (`?sslmode=verify-full`) |
| `APP_URL` | `https://<service>.onrender.com` (or your domain) |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `APP_MODE` | `production` (or `demo` for a public demo) |
| `ENABLE_INPROCESS_SCHEDULER` | `true` |
| `CLIENT_IP_HEADER` | `true-client-ip` (Render's edge sets it; `X-Forwarded-For` can be spoofed there) |
| `NODE_VERSION` | `22` |
| `DB_POOL_MAX` | `5` |
| `ESPN_ENABLED` | `true` to list La Liga, Bundesliga, Serie A, Ligue 1 and Champions League players (unofficial ESPN feed: read docs/DATA_LICENSING.md first) |
| `ESPN_LEAGUES` | optional subset, default `esp.1,ger.1,ita.1,fra.1,uefa.champions` |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional: password-reset emails |
| `FOOTBALL_DATA_API_KEY` | optional: other leagues' fixtures |

### 3. Wake-up before matches (GitHub Actions)

The "Market wake-up" workflow runs hourly and needs no secrets: when a match is
near it sends a plain `GET /api/health`, which is enough to wake a sleeping server
(the in-process scheduler starts on boot). Point it at your deployment by setting
the repository variable `APP_URL` (Settings → Secrets and variables → Actions →
Variables), or edit the default URL in `.github/workflows/market-tick.yml`. If you
also add the secret `CRON_SECRET` (same value as on Render), it calls the
authenticated `/api/cron/tick` instead.

### 4. Admin account

Sign up in the app, then grant yourself admin with the production `DATABASE_URL`:
`npm run admin:grant -- you@example.com` (from your machine), or run
`UPDATE users SET role = 'admin' WHERE lower(email) = lower('you@example.com');`
in the Neon SQL editor. There is no web route that grants admin.

## B. Vercel + Neon

1. Migrate and seed once from your machine:

   ```bash
   cp .env.example .env            # set DATABASE_URL to the owner connection string
   npm ci
   npm run db:migrate
   npm run db:seed                 # players, fixtures, stats; settles finished matches
   ```

2. vercel.com → **Add New → Project → Import** the repo. `vercel.json` sets the
   build command to `npm run vercel-build` (migrations + build).
3. Environment variables (Production): `DATABASE_URL`, `APP_URL`, `CRON_SECRET`,
   `APP_MODE`, optional `RESEND_API_KEY`/`EMAIL_FROM`/`FOOTBALL_DATA_API_KEY`.
   Leave `ENABLE_INPROCESS_SCHEDULER` unset (serverless functions don't stay running).
4. Scheduling: Vercel Hobby cron (in `vercel.json`) runs once a day. For live
   matches add cron-job.org (free): URL `https://<app>/api/cron/tick`, header
   `Authorization: Bearer <CRON_SECRET>`, every minute. Or set the repository
   variable `TICK_EVERY_RUN=true` so the GitHub workflow ticks every hour.

**Note:** if a host can't reach `fantasy.premierleague.com` (FPL sometimes blocks
cloud IP ranges), `DATA_PROVIDER=auto` falls back to the public GitHub snapshot and
the UI says "Snapshot data". Check Admin → Providers.

## Any Node host (Railway, Fly.io, a VM, Docker)

```bash
npm ci
npm run db:migrate
npm run build
ENABLE_INPROCESS_SCHEDULER=true npm start -- -p $PORT
# or keep the scheduler separate:  npm start  +  npm run worker  (TICK_SECONDS, default 30)
```

The in-process scheduler, the worker and `/api/cron/tick` share Postgres job locks,
so running more than one is safe. Put the app behind HTTPS (cookies are `Secure` in
production) and a proxy that overwrites `X-Real-IP`, or set `CLIENT_IP_HEADER` to
the header your proxy guarantees.

## Least-privilege database role

Run migrations as the owner and give the app a role without DDL rights:

```sql
CREATE ROLE pitchmarket_app LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE <db> TO pitchmarket_app;
GRANT USAGE ON SCHEMA public TO pitchmarket_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pitchmarket_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pitchmarket_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pitchmarket_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pitchmarket_app;
```

The immutability triggers still block `UPDATE`/`DELETE` on the ledgers for every
role. (Render's build runs migrations, so with this split, point the build at the
owner role or migrate from your machine and drop `npm run db:migrate` from the build.)

## Health and operations

* `GET /api/health` returns `200` when the process is serving (no database call).
* `GET /api/ready` returns `200` once the database is reachable, migrations are
  applied and players are listed (`503` otherwise), and includes market status,
  data mode and data age.
* `GET|POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` runs whatever
  is due and reports when the next tick is useful. `?force=1` ignores intervals.
* `/admin` (admins only) shows provider status, last successful ingestion, failing
  jobs, rate-limit hits, ledger integrity, the audit log, market halt/open controls
  and manual refresh.
* Logs are single-line JSON with secrets and emails redacted.

## Resetting a demo instance

Set `APP_MODE=demo`, then run `npm run db:seed -- --demo-users` to add the
clearly-labelled demo accounts and a public "Demo League". Users can reset their
own portfolio in Settings (rate-limited, audited).
