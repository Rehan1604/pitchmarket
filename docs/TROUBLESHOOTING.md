# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Invalid server environment: DATABASE_URL…` at startup/build | Missing env var | Copy `.env.example` to `.env` and set `DATABASE_URL`. On Vercel, set it for the Production (and Preview) environment. |
| `/api/ready` returns 503 with `listedPlayers: 0` | Market not seeded | `npm run db:seed` (or wait for the scheduler's reference job). |
| Amber "Snapshot data" pill everywhere | The live FPL API isn't reachable from the server | Expected fallback. Admin → Providers shows the error. Run the worker from a host that can reach `fantasy.premierleague.com`, or set `DATA_PROVIDER=fpl` to fail loudly instead of falling back. |
| Prices never move | No scheduler is calling `/api/cron/tick` | Configure Vercel Cron, the GitHub workflow, cron-job.org or `npm run worker` (docs/DEPLOYMENT.md). Admin → Recent runs shows the last run. |
| `401 Invalid cron credentials` | Header mismatch | Send `Authorization: Bearer <CRON_SECRET>` exactly. |
| `503 CRON_NOT_CONFIGURED` | `CRON_SECRET` unset | Set `CRON_SECRET` (≥16 characters). |
| Admin shows a provider "Backoff until …" | Repeated failures or HTTP 429 | Automatic. The provider is retried after the backoff, or use Admin → Re-check live feed. |
| Trading paused, reason "Live match data is delayed…" | Automatic stale-data halt during a live match | Lifts itself when the feed recovers. Admin can also set the status manually (manual halts never auto-lift). |
| "Trading in this player is locked while their match is live" | In-play lock (`LIVE_TRADING_POLICY=halt`) | By design. Set `allow` to permit in-play trading. |
| `409 PRICE_CHANGED` when confirming an order | The price moved between review and confirm | The ticket shows the new price. Confirm again. |
| Password-reset emails never arrive (production) | `RESEND_API_KEY` not set | Configure Resend and `EMAIL_FROM` with a verified domain. In development the link is printed to the server console. |
| Can't log in after many attempts | Rate limit (8 per 15 min per account, 20 per 10 min per IP) | Wait for the window to pass. |
| `npm install` fails with `Cannot read properties of null (reading 'edgesOut')` | npm peer-resolution bug with optional Vitest peers | `npm ci` (uses the lockfile) works. For new installs, add `--legacy-peer-deps`. |
| Integration tests refuse to run | `TEST_DATABASE_URL` doesn't contain "test" | Safety check against wiping a real DB. Use a dedicated `…_test` database. |
| Playwright can't find a browser | Browsers not installed | `npx playwright install chromium`. |
| Ledger integrity shows a mismatch in Admin | Should never happen; indicates manual DB edits | Check the audit log. Ledgers are append-only; investigate before changing anything. |
