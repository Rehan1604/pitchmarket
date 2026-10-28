# Deployment

The recommended free setup is **Vercel (Hobby) + Neon or Supabase Postgres (free)
+ a scheduler that calls `/api/cron/tick`**. Anything that runs Node 20.9+ and
can reach Postgres also works (see "Any Node host").

## 1. Database (Neon or Supabase, free tier)

1. Create a project and copy the **pooled** connection string. Neon: Dashboard →
   Connection details → "Pooled connection". Supabase: Project settings →
   Database → Connection pooling. Make sure it ends with `?sslmode=require`.
2. Least-privilege role (recommended): run migrations as the owner, and give the
   app a role without DDL rights:

   ```sql
   CREATE ROLE pitchmarket_app LOGIN PASSWORD '…';
   GRANT CONNECT ON DATABASE <db> TO pitchmarket_app;
   GRANT USAGE ON SCHEMA public TO pitchmarket_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pitchmarket_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pitchmarket_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pitchmarket_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pitchmarket_app;
   ```

   The immutability triggers still block `UPDATE`/`DELETE` on the ledgers for every role.

## 2. Migrate and seed (from your machine, once)

```bash
cp .env.example .env            # set DATABASE_URL to the owner connection string
npm ci
npm run db:migrate              # applies drizzle/*.sql
npm run db:seed                 # loads players, fixtures, stats and settles finished matches
```

`db:seed` tries the live FPL API first and falls back to the GitHub snapshot.
It's safe to re-run, because every step is idempotent.

## 3. Vercel

1. Push the repository to GitHub, then on vercel.com: **Add New → Project →
   Import** the repo. The framework is detected as Next.js; `vercel.json` sets the
   build command to `npm run vercel-build` (migrations + build).
2. **Settings → Environment Variables** (Production):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | pooled connection string (app role) |
   | `APP_URL` | `https://<your-project>.vercel.app` (or your domain) |
   | `CRON_SECRET` | `openssl rand -hex 32` |
   | `APP_MODE` | `production` (or `demo` for a public demo) |
   | `RESEND_API_KEY`, `EMAIL_FROM` | to send password-reset emails |
   | `FOOTBALL_DATA_API_KEY` | optional, other leagues' fixtures |

   `vercel-build` runs migrations with `DATABASE_URL`, so during the build that
   variable must point at a role that can apply DDL (or migrate manually as in
   step 2 and change the build command to `npm run build`).
3. Deploy. Check `https://<app>/api/health` (liveness) and `/api/ready` (database,
   migrations, listed players, data mode).
4. Make yourself admin: sign up in the app, then from your machine run
   `npm run admin:grant -- you@example.com` with the production `DATABASE_URL`.

### Scheduling the data pipeline

`GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` runs whatever is
due. It's lock-protected, so overlapping schedulers are safe. Pick one or combine:

| Option | Frequency | Setup |
|---|---|---|
| Vercel Cron (`vercel.json`) | Hobby: once a day (06:10 UTC) | Automatic. Vercel sends the bearer token when `CRON_SECRET` is set. |
| GitHub Actions (`.github/workflows/market-tick.yml`) | every 30 min (fits the 2,000 free minutes of a private repo; use every 5 min on a public repo) | Repo → Settings → Secrets and variables → Actions: add `APP_URL` and `CRON_SECRET`. |
| cron-job.org (free) | every 1 min | New cronjob → URL `https://<app>/api/cron/tick` → Advanced → header `Authorization: Bearer <CRON_SECRET>` → every minute. Best for live matches. |
| `npm run worker` on any always-on host | every 30 s | See below. |

For live in-play prices, use a 1-minute scheduler on match days. Without one,
prices still settle correctly, just later.

**Note:** if Vercel's servers can't reach `fantasy.premierleague.com` (FPL
sometimes blocks cloud IP ranges), `DATA_PROVIDER=auto` falls back to the snapshot
and the UI says so. Check the Admin page → Providers. The fix is running the
worker on a host FPL accepts.

## Any Node host (Railway, Render, Fly.io, a VM)

```bash
npm ci
npm run db:migrate
npm run build
npm start                      # web (PORT env respected by next start: npm start -- -p $PORT)
npm run worker                 # separate process: scheduler loop (TICK_SECONDS, default 30)
```

Set the same environment variables. Put the app behind HTTPS (cookies are
`Secure` in production) and a proxy that sets `X-Real-IP`/`X-Forwarded-For`
(used for rate limiting).

## Health and operations

* `GET /api/health` returns `200` when the process is serving.
* `GET /api/ready` returns `200` once the database is reachable, migrations are
  applied and players are listed (`503` otherwise), and includes market status,
  data mode and data age.
* `/admin` (admins only) shows provider status, last successful ingestion,
  failing jobs, rate-limit hits, ledger integrity, the audit log, market halt and
  open controls, and manual refresh.
* Logs are single-line JSON with secrets and emails redacted.

## Resetting a demo instance

Set `APP_MODE=demo`, then run `npm run db:seed -- --demo-users` to add the
clearly-labelled demo accounts and a public "Demo League". Users can reset their
own portfolio in Settings (rate-limited, audited).
