/**
 * The scheduler is a single idempotent "tick": call it every minute (cron,
 * GitHub Actions, or the long-running worker) and it runs whatever is due.
 * Postgres job locks make concurrent ticks safe — a job runs at most once per
 * interval no matter how many invocations overlap.
 */
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/server/env";
import { log } from "@/server/log";
import { audit } from "@/server/audit";
import { getMarketState } from "@/server/market/state";
import { takeDailySnapshots } from "@/server/portfolio/snapshots";
import { syncEspnFixtures, syncEspnReference } from "./espn-sync";
import { repriceSkippedRows, syncFixtures, syncFixtureOnlyCompetition, syncReference, syncStats, withRun } from "./pipeline";
import { ESPN_ENTITY } from "./providers/espn";
import { espnProviders, fixtureOnlyProvider, resolveMarketProvider } from "./registry";

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

async function runJob(job: string, minIntervalSec: number, fn: () => Promise<{ status: string }>, results: Record<string, string>, ttlSec = 300) {
  if (!(await acquireJob(job, minIntervalSec, ttlSec))) return;
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
      recentUnsettled: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'finished' and ${schema.fixtures.settledAt} is null and ${schema.fixtures.kickoffAt} > ${new Date(now - 12 * 3600_000)})::int`,
      backlog: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'finished' and ${schema.fixtures.settledAt} is null and ${schema.fixtures.statsFinal} and ${schema.fixtures.lastStatsSyncAt} is null)::int`,
    })
    .from(schema.fixtures)
    .where(eq(schema.fixtures.provider, entityProvider));
  return row ?? { live: 0, imminent: 0, unsettled: 0, recentUnsettled: 0, backlog: 0 };
}

/** Max match sheets fetched per ESPN stats run (first-run backfill is spread over a few ticks). */
const ESPN_STATS_BATCH = 40;

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
        // A fixture still "live" 4 hours after kickoff is a feed glitch, not a delayed match:
        // it must not freeze the whole market.
        gt(schema.fixtures.kickoffAt, new Date(now.getTime() - 4 * 3600_000)),
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

export interface TickPlan {
  /** Seconds until the next tick is useful. */
  delaySec: number;
  /** True while a match is live, about to start or awaiting settlement (live feed only). */
  keepAwake: boolean;
  reason: "live" | "kickoff" | "backfill" | "settling" | "upcoming" | "idle" | "snapshot";
}

/** Pre-kickoff lead during which a sleep-on-idle host should stay awake. */
export const KEEP_AWAKE_LEAD_MINUTES = 90;

/**
 * Decide when the next tick is worth running. Around matches that is every
 * LIVE_POLL_SECONDS; otherwise we wait until shortly before the next kickoff
 * (capped by SCHEDULER_IDLE_SECONDS) so the database can scale to zero.
 */
export async function planNextTick(liveProviders: string[], now = Date.now()): Promise<TickPlan> {
  const e = env();
  const opts = { idleSec: e.SCHEDULER_IDLE_SECONDS, liveSec: e.LIVE_POLL_SECONDS };
  if (liveProviders.length === 0) return decideNextTick(null, "snapshot", now, opts);
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'live')::int`,
      kickoff: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'scheduled' and ${schema.fixtures.kickoffAt} between ${new Date(now - 3 * 3600_000)} and ${new Date(now + 20 * 60_000)})::int`,
      settling: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'finished' and ${schema.fixtures.settledAt} is null and ${schema.fixtures.kickoffAt} > ${new Date(now - 12 * 3600_000)})::int`,
      backlog: sql<number>`count(*) filter (where ${schema.fixtures.status} = 'finished' and ${schema.fixtures.settledAt} is null and ${schema.fixtures.statsFinal} and ${schema.fixtures.lastStatsSyncAt} is null)::int`,
      nextKickoff: sql<string | null>`min(${schema.fixtures.kickoffAt}) filter (where ${schema.fixtures.status} = 'scheduled' and ${schema.fixtures.kickoffAt} > ${new Date(now)})`,
    })
    .from(schema.fixtures)
    .where(inArray(schema.fixtures.provider, liveProviders));
  return decideNextTick(row ?? null, "live", now, opts);
}

export interface FixtureWindow {
  live: number;
  kickoff: number;
  settling: number;
  /** Final, unsettled fixtures whose stats were never fetched (first-run backfill). */
  backlog?: number;
  nextKickoff: string | Date | null;
}

/** Pure timing policy behind planNextTick (unit-tested). */
export function decideNextTick(w: FixtureWindow | null, mode: string, now: number, o: { idleSec: number; liveSec: number }): TickPlan {
  if (mode !== "live") return { delaySec: o.idleSec, keepAwake: false, reason: "snapshot" };
  if (!w) return { delaySec: o.idleSec, keepAwake: false, reason: "idle" };
  if (w.live > 0) return { delaySec: o.liveSec, keepAwake: true, reason: "live" };
  if (w.kickoff > 0) return { delaySec: o.liveSec, keepAwake: true, reason: "kickoff" };
  if (w.backlog && w.backlog > 0) return { delaySec: 20, keepAwake: true, reason: "backfill" };
  if (w.settling > 0) return { delaySec: 300, keepAwake: true, reason: "settling" };
  if (w.nextKickoff) {
    const untilSec = (new Date(w.nextKickoff).getTime() - now) / 1000;
    const delaySec = Math.round(Math.min(o.idleSec, Math.max(o.liveSec, untilSec - 15 * 60)));
    return { delaySec, keepAwake: untilSec <= KEEP_AWAKE_LEAD_MINUTES * 60, reason: "upcoming" };
  }
  return { delaySec: o.idleSec, keepAwake: false, reason: "idle" };
}

export interface CycleResult {
  provider: string;
  mode: string;
  jobs: Record<string, string>;
  next: TickPlan;
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

  const espn = espnProviders();
  if (espn.length) {
    const w = await liveWindow(ESPN_ENTITY);
    const hotEspn = w.live > 0 || w.imminent > 0 || w.recentUnsettled > 0;
    // Order matters on a fresh database: whole-season fixtures first (they date the
    // initial listing), then squads, then the recent window, then stats.
    await runJob("fixtures-full:espn", f * 6 * 3600, () => syncEspnFixtures(espn, "full", trigger), results);
    await runJob("reference:espn", f * 12 * 3600, () => syncEspnReference(espn, trigger), results, 900);
    await runJob("fixtures:espn", f * (hotEspn ? 90 : 1800), () => syncEspnFixtures(espn, "recent", trigger), results);
    const after = await liveWindow(ESPN_ENTITY);
    if (after.live > 0 || after.unsettled > 0) {
      const interval = after.live > 0 ? e.LIVE_POLL_SECONDS - 5 : after.backlog > 0 ? 0 : 240;
      await runJob(`stats:${ESPN_ENTITY}`, f * interval, () => withRun("stats", ESPN_ENTITY, trigger, () => syncStats(espn[0], new Date(), { maxFixtures: ESPN_STATS_BATCH })), results);
    }
  }

  // One-off repair for rows an earlier release skipped as "before listing" (no-op once done).
  await runJob("repair:before-listing", f * 600, () => repriceSkippedRows("before_listing"), results, 15 * 60);
  await runJob("snapshots:daily", f * 1800, async () => withRun("snapshots", "internal", trigger, () => takeDailySnapshots(), { gate: false }), results);
  await runJob("cleanup", f * 6 * 3600, cleanup, results);
  const freshness = await enforceDataFreshness();
  if (freshness.changed) results.freshness = String(freshness.status);

  const liveProviders = [...(provider.mode === "live" ? [provider.entityProvider] : []), ...(espn.length ? [ESPN_ENTITY] : [])];
  const next = await planNextTick(liveProviders);
  return { provider: provider.source, mode: provider.mode, jobs: results, next };
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
