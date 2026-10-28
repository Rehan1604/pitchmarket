/**
 * The scheduler is a single idempotent "tick": call it every minute (cron,
 * GitHub Actions, or the long-running worker) and it runs whatever is due.
 * Postgres job locks make concurrent ticks safe — a job runs at most once per
 * interval no matter how many invocations overlap.
 */
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/server/env";
import { log } from "@/server/log";
import { audit } from "@/server/audit";
import { getMarketState } from "@/server/market/state";
import { takeDailySnapshots } from "@/server/portfolio/snapshots";
import { syncFixtures, syncFixtureOnlyCompetition, syncReference, syncStats, withRun } from "./pipeline";
import { fixtureOnlyProvider, resolveMarketProvider } from "./registry";

export async function acquireJob(job: string, minIntervalSec: number, ttlSec = 300): Promise<boolean> {
  const res = await db.execute<{ job: string }>(sql`
    INSERT INTO job_locks (job, locked_until, last_run_at)
    VALUES (${job}, now() + make_interval(secs => ${ttlSec}), now())
    ON CONFLICT (job) DO UPDATE
      SET locked_until = now() + make_interval(secs => ${ttlSec}), last_run_at = now()
      WHERE job_locks.locked_until < now()
        AND (job_locks.last_run_at IS NULL OR job_locks.last_run_at < now() - make_interval(secs => ${minIntervalSec}))
    RETURNING job`);
  return res.rows.length > 0;
}

export async function releaseJob(job: string, status: string) {
  await db.update(schema.jobLocks).set({ lockedUntil: new Date(), lastStatus: status }).where(eq(schema.jobLocks.job, job));
}

async function runJob(job: string, minIntervalSec: number, fn: () => Promise<{ status: string }>, results: Record<string, string>) {
  if (!(await acquireJob(job, minIntervalSec))) return;
  let status = "failed";
  try {
    status = (await fn()).status;
  } catch (e) {
    log.error("scheduled job crashed", { job, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await releaseJob(job, status);
    results[job] = status;
  }
}

async function liveWindow(entityProvider: string) {
  const now = Date.now();
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'live')::int`,
      imminent: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'scheduled' and ${schema.fixtures.kickoffAt} between ${new Date(now - 3 * 3600_000)} and ${new Date(now + 20 * 60_000)})::int`,
      unsettled: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'finished' and ${schema.fixtures.settledAt} is null)::int`,
    })
    .from(schema.fixtures)
    .where(eq(schema.fixtures.provider, entityProvider));
  return row ?? { live: 0, imminent: 0, unsettled: 0 };
}

/**
 * Halt trading automatically if a live match has had no successful stats
 * refresh for STALE_LIVE_DATA_HALT_MINUTES; reopen when the feed recovers.
 * Manual (admin) halts are never overridden.
 */
export async function enforceDataFreshness(now = new Date()) {
  const e = env();
  const market = await getMarketState();
  if (market.dataMode !== "live") return { changed: false };
  const cutoff = new Date(now.getTime() - e.STALE_LIVE_DATA_HALT_MINUTES * 60_000);
  const [{ stale }] = await db
    .select({ stale: sql<number>`count(*)::int` })
    .from(schema.fixtures)
    .where(
      and(
        eq(schema.fixtures.status, "live"),
        or(lt(schema.fixtures.lastStatsSyncAt, cutoff), and(isNull(schema.fixtures.lastStatsSyncAt), lt(schema.fixtures.kickoffAt, cutoff))),
      ),
    );
  if (stale > 0 && market.status === "open") {
    await db
      .update(schema.marketState)
      .set({ status: "halted", statusSetBy: "system", statusReason: "Live match data is delayed. Trading is paused until the feed recovers.", updatedAt: now })
      .where(eq(schema.marketState.id, 1));
    await audit({ actor: "system", action: "market.auto_halt", metadata: { staleLiveFixtures: stale } });
    return { changed: true, status: "halted" };
  }
  if (stale === 0 && market.status === "halted" && market.statusSetBy === "system") {
    await db.update(schema.marketState).set({ status: "open", statusSetBy: "system", statusReason: null, updatedAt: now }).where(eq(schema.marketState.id, 1));
    await audit({ actor: "system", action: "market.auto_reopen" });
    return { changed: true, status: "open" };
  }
  return { changed: false };
}

async function cleanup() {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  await db.delete(schema.rateLimits).where(lt(schema.rateLimits.windowStart, new Date(Date.now() - 24 * 3600_000)));
  await db.delete(schema.passwordResetTokens).where(lt(schema.passwordResetTokens.expiresAt, new Date(Date.now() - 24 * 3600_000)));
  return { status: "success" };
}

export interface CycleResult {
  provider: string;
  mode: string;
  jobs: Record<string, string>;
}

/** Run every job that is due. Safe to call as often as every few seconds. */
export async function runSchedulerTick(trigger = "schedule", opts: { force?: boolean } = {}): Promise<CycleResult> {
  const e = env();
  const provider = await resolveMarketProvider();
  const results: Record<string, string> = {};
  const isLive = provider.mode === "live";
  const window = await liveWindow(provider.entityProvider);
  const hot = window.live > 0 || window.imminent > 0;
  const f = opts.force ? 0 : 1; // force → zero minimum intervals

  await runJob(`fixtures:${provider.source}`, f * (isLive ? (hot ? 90 : 900) : 3600), () => withRun("fixtures", provider.source, trigger, () => syncFixtures(provider)), results);
  await runJob(`reference:${provider.source}`, f * (isLive ? 6 * 3600 : 6 * 3600), () => withRun("reference", provider.source, trigger, () => syncReference(provider)), results);

  const after = await liveWindow(provider.entityProvider);
  if (after.live > 0 || after.unsettled > 0) {
    const interval = after.live > 0 ? e.LIVE_POLL_SECONDS - 5 : 240;
    await runJob(`stats:${provider.source}`, f * interval, () => withRun("stats", provider.source, trigger, () => syncStats(provider)), results);
  }

  const fo = fixtureOnlyProvider();
  if (fo) {
    await runJob(
      "fixtures:football-data",
      f * 1800,
      async () => {
        let worst = "success";
        for (const code of fo.competitions) {
          const r = await withRun(`fixtures:${code}`, fo.provider.source, trigger, () => syncFixtureOnlyCompetition(fo.provider, code));
          // One request per competition every 30 min stays far below the free tier's 10 requests/minute.
          if (r.status === "failed") worst = "partial";
        }
        return { status: worst };
      },
      results,
    );
  }

  await runJob("snapshots:daily", f * 1800, async () => withRun("snapshots", "internal", trigger, () => takeDailySnapshots(), { gate: false }), results);
  await runJob("cleanup", f * 6 * 3600, cleanup, results);
  const freshness = await enforceDataFreshness();
  if (freshness.changed) results.freshness = String(freshness.status);

  return { provider: provider.source, mode: provider.mode, jobs: results };
}

/** Admin: which jobs ran recently and whether any are failing. */
export async function recentRuns(limit = 40) {
  return db.select().from(schema.ingestionRuns).orderBy(sql`${schema.ingestionRuns.startedAt} desc`).limit(limit);
}

export async function failingJobs(sinceHours = 24) {
  return db
    .select()
    .from(schema.ingestionRuns)
    .where(and(eq(schema.ingestionRuns.status, "failed"), gt(schema.ingestionRuns.startedAt, new Date(Date.now() - sinceHours * 3600_000))))
    .orderBy(sql`${schema.ingestionRuns.startedAt} desc`)
    .limit(50);
}
