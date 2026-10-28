/**
 * Market-data pipeline. Each job is idempotent and can be re-run safely:
 *
 *   syncFixtures   upsert competition, clubs, fixtures (status, score, minute)
 *   syncReference  upsert players + availability; IPO new players exactly once
 *   syncStats      fetch stats for live + finished-unsettled fixtures, store
 *                  them (only when changed), apply provisional live prices, and
 *                  settle finished fixtures exactly once
 *   syncFixtureOnly  fixtures/results for non-tradable competitions
 *
 * Every run is recorded in ingestion_runs; provider health (failures, backoff,
 * rate limits, data freshness) lives in provider_status.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit } from "@/server/audit";
import { log } from "@/server/log";
import { ipoState, applyMatch, livePrice, fundamentalCents, type PriorInput } from "@/server/market/pricing";
import { scoreMatch, statsFingerprint, type Position } from "@/server/market/scoring";
import { lockAndBumpMarketVersion, lockMarket, setDataStatus, settledStateFromRow, stateColumns } from "@/server/market/state";
import { slugify } from "@/lib/text";
import { ProviderError } from "./http";
import type { FixtureBundle, FixtureOnlyProvider, MarketDataProvider, NormCompetition, NormFixture, NormPlayerMatch } from "./providers/types";
import priorsFile from "../../../data/priors/fpl-2025-26.json";

const MATCH_LENGTH_MS = 115 * 60_000;
const BIG_MOVE_NOTIFY = 0.04;

type PriorsFile = { players: Record<string, PriorInput & { position: Position }> };
const PRIORS = (priorsFile as unknown as PriorsFile).players;

export function priorFor(entityProvider: string, providerRef: string): PriorInput | null {
  if (entityProvider !== "fpl") return null;
  const p = PRIORS[providerRef];
  return p ? { quality: p.quality, weight: p.weight, role: p.role, roleMatches: p.roleMatches } : null;
}

// ------------------------------------------------------------------ run + provider bookkeeping

export class ProviderBackoffError extends Error {
  constructor(public provider: string, public until: Date) {
    super(`${provider} is backing off until ${until.toISOString()}`);
  }
}

export async function assertProviderAllowed(provider: string, now = new Date()) {
  const [row] = await db.select().from(schema.providerStatus).where(eq(schema.providerStatus.provider, provider));
  if (row?.nextAllowedAt && row.nextAllowedAt > now) throw new ProviderBackoffError(provider, row.nextAllowedAt);
}

export async function recordProviderSuccess(provider: string, dataAsOf: Date | null) {
  const now = new Date();
  await db
    .insert(schema.providerStatus)
    .values({ provider, lastSuccessAt: now, consecutiveFailures: 0, nextAllowedAt: null, dataAsOf, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.providerStatus.provider,
      set: {
        lastSuccessAt: now,
        consecutiveFailures: 0,
        nextAllowedAt: null,
        updatedAt: now,
        ...(dataAsOf ? { dataAsOf } : {}),
      },
    });
}

export async function recordProviderFailure(provider: string, err: unknown) {
  const now = new Date();
  const [row] = await db.select().from(schema.providerStatus).where(eq(schema.providerStatus.provider, provider));
  const failures = (row?.consecutiveFailures ?? 0) + 1;
  const isRate = err instanceof ProviderError && err.kind === "rate_limited";
  const backoffSec = isRate ? Math.max(30, (err as ProviderError).retryAfterSeconds ?? 60) : Math.min(1800, 15 * 2 ** Math.min(failures, 7));
  const message = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
  const values = {
    lastErrorAt: now,
    lastError: message,
    consecutiveFailures: failures,
    nextAllowedAt: new Date(now.getTime() + backoffSec * 1000),
    rateLimitHits: (row?.rateLimitHits ?? 0) + (isRate ? 1 : 0),
    updatedAt: now,
  };
  await db
    .insert(schema.providerStatus)
    .values({ provider, ...values })
    .onConflictDoUpdate({ target: schema.providerStatus.provider, set: values });
}

export interface RunOutcome {
  items: number;
  status?: "success" | "partial" | "skipped";
  details?: Record<string, unknown>;
  dataAsOf?: Date | null;
}

/** Record an ingestion run around `fn`, with provider-level success/failure bookkeeping. */
function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  const base = err.message.split("\nparams:")[0];
  return cause instanceof Error ? `${base.slice(0, 300)} — cause: ${cause.message}` : base;
}

export async function withRun(job: string, provider: string, trigger: string, fn: () => Promise<RunOutcome>, opts: { gate?: boolean } = {}) {
  if (opts.gate !== false) {
    try {
      await assertProviderAllowed(provider);
    } catch (e) {
      if (e instanceof ProviderBackoffError) {
        await db.insert(schema.ingestionRuns).values({
          job,
          provider,
          trigger,
          status: "skipped",
          finishedAt: new Date(),
          details: { reason: "provider backoff", until: e.until.toISOString() },
        });
        return { status: "skipped" as const, items: 0 };
      }
      throw e;
    }
  }
  const [run] = await db.insert(schema.ingestionRuns).values({ job, provider, trigger, status: "running" }).returning({ id: schema.ingestionRuns.id });
  const started = Date.now();
  try {
    const outcome = await fn();
    const status = outcome.status ?? "success";
    await db
      .update(schema.ingestionRuns)
      .set({ status, finishedAt: new Date(), itemsProcessed: outcome.items, details: { ...outcome.details, ms: Date.now() - started } })
      .where(eq(schema.ingestionRuns.id, run.id));
    if (status !== "skipped") await recordProviderSuccess(provider, outcome.dataAsOf ?? null);
    log.info("ingestion run finished", { job, provider, status, items: outcome.items, ms: Date.now() - started });
    return { status, items: outcome.items, details: outcome.details };
  } catch (err) {
    const rateLimited = err instanceof ProviderError && err.kind === "rate_limited";
    await db
      .update(schema.ingestionRuns)
      .set({ status: "failed", finishedAt: new Date(), rateLimited, error: errorMessage(err).slice(0, 1000) })
      .where(eq(schema.ingestionRuns.id, run.id));
    await recordProviderFailure(provider, err);
    log.error("ingestion run failed", { job, provider, error: errorMessage(err) });
    return { status: "failed" as const, items: 0, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------------ upserts

async function upsertCompetition(tx: Tx, c: NormCompetition, entityProvider: string, flags: { hasPlayerStats: boolean; hasLiveData: boolean }) {
  const [row] = await tx
    .insert(schema.competitions)
    .values({ code: c.code, name: c.name, country: c.country, season: c.season, provider: entityProvider, providerRef: c.providerRef, ...flags })
    .onConflictDoUpdate({
      target: [schema.competitions.code, schema.competitions.season],
      set: { name: c.name, country: c.country, provider: entityProvider, providerRef: c.providerRef, ...flags, updatedAt: new Date() },
    })
    .returning();
  return row;
}

async function upsertClubs(tx: Tx, competitionId: number, entityProvider: string, clubs: FixtureBundle["clubs"]) {
  const map = new Map<string, number>();
  for (const c of clubs) {
    const [row] = await tx
      .insert(schema.clubs)
      .values({ competitionId, provider: entityProvider, providerRef: c.providerRef, name: c.name, shortName: c.shortName })
      .onConflictDoUpdate({
        target: [schema.clubs.provider, schema.clubs.providerRef, schema.clubs.competitionId],
        set: { name: c.name, shortName: c.shortName, updatedAt: new Date() },
      })
      .returning({ id: schema.clubs.id });
    map.set(c.providerRef, row.id);
  }
  return map;
}

async function upsertFixtures(tx: Tx, competitionId: number, entityProvider: string, clubIds: Map<string, number>, fixtures: NormFixture[]) {
  let changed = 0;
  for (const f of fixtures) {
    const values = {
      round: f.round,
      kickoffAt: f.kickoffAt,
      homeClubId: f.homeRef ? (clubIds.get(f.homeRef) ?? null) : null,
      awayClubId: f.awayRef ? (clubIds.get(f.awayRef) ?? null) : null,
      homeName: f.homeName,
      awayName: f.awayName,
      homeScore: f.homeScore,
      awayScore: f.awayScore,
      status: f.status,
      minute: f.minute,
      sourceUpdatedAt: f.sourceUpdatedAt,
      updatedAt: new Date(),
    };
    const res = await tx
      .insert(schema.fixtures)
      .values({ competitionId, provider: entityProvider, providerRef: f.providerRef, statsFinal: f.statsFinal, ...values })
      .onConflictDoUpdate({
        target: [schema.fixtures.provider, schema.fixtures.providerRef, schema.fixtures.competitionId],
        // A settled fixture can never become un-final again.
        set: { ...values, statsFinal: sql`(${schema.fixtures.settledAt} IS NOT NULL) OR ${f.statsFinal}` },
      })
      .returning({ id: schema.fixtures.id });
    if (res.length) changed++;
  }
  return changed;
}

// ------------------------------------------------------------------ jobs

export async function syncFixtures(provider: MarketDataProvider) {
  const bundle = await provider.fetchFixtures();
  const live = provider.mode === "live" && provider.capabilities.live;
  const result = await db.transaction(async (tx) => {
    const comp = await upsertCompetition(tx, bundle.competition, provider.entityProvider, { hasPlayerStats: true, hasLiveData: live });
    const clubIds = await upsertClubs(tx, comp.id, provider.entityProvider, bundle.clubs);
    const n = await upsertFixtures(tx, comp.id, provider.entityProvider, clubIds, bundle.fixtures);
    return { competitionId: comp.id, fixtures: n };
  });
  await setDataStatus({ dataProvider: provider.source, dataMode: provider.mode, ...(bundle.dataAsOf ? { dataAsOf: bundle.dataAsOf } : {}) });
  return {
    items: result.fixtures,
    dataAsOf: bundle.dataAsOf,
    details: {
      competitionId: result.competitionId,
      live: bundle.fixtures.filter((f) => f.status === "live").length,
      finished: bundle.fixtures.filter((f) => f.status === "finished").length,
    },
  };
}

export async function syncFixtureOnlyCompetition(provider: FixtureOnlyProvider, code: string) {
  const bundle = await provider.fetchCompetitionFixtures(code);
  const n = await db.transaction(async (tx) => {
    const comp = await upsertCompetition(tx, bundle.competition, provider.entityProvider, { hasPlayerStats: false, hasLiveData: provider.capabilities.live });
    const clubIds = await upsertClubs(tx, comp.id, provider.entityProvider, bundle.clubs);
    return upsertFixtures(tx, comp.id, provider.entityProvider, clubIds, bundle.fixtures);
  });
  return { items: n, dataAsOf: bundle.dataAsOf, details: { competition: code } };
}

/** Season-open timestamp for initial IPOs: one day before the first fixture of the competition. */
async function seasonOpenAt(competitionId: number): Promise<Date | null> {
  const [row] = await db
    .select({ first: sql<Date | null>`min(${schema.fixtures.kickoffAt})` })
    .from(schema.fixtures)
    .where(eq(schema.fixtures.competitionId, competitionId));
  return row?.first ? new Date(new Date(row.first).getTime() - 24 * 3600_000) : null;
}

export async function syncReference(provider: MarketDataProvider) {
  const bundle = await provider.fetchReference();
  const ep = provider.entityProvider;
  const live = provider.mode === "live" && provider.capabilities.live;

  const { competitionId, inserted, updated, deactivated } = await db.transaction(async (tx) => {
    const comp = await upsertCompetition(tx, bundle.competition, ep, { hasPlayerStats: true, hasLiveData: live });
    const clubIds = await upsertClubs(tx, comp.id, ep, bundle.clubs);
    const existing = await tx
      .select({ id: schema.players.id, providerRef: schema.players.providerRef, slug: schema.players.slug })
      .from(schema.players)
      .where(eq(schema.players.provider, ep));
    const byRef = new Map(existing.map((p) => [p.providerRef, p]));
    const slugs = new Set((await tx.select({ slug: schema.players.slug }).from(schema.players)).map((r) => r.slug));
    let ins = 0;
    let upd = 0;
    const seen = new Set<string>();
    for (const p of bundle.players) {
      seen.add(p.providerRef);
      const fields = {
        providerSeasonRef: p.seasonRef,
        firstName: p.firstName,
        lastName: p.lastName,
        displayName: p.displayName,
        clubId: p.clubRef ? (clubIds.get(p.clubRef) ?? null) : null,
        competitionId: comp.id,
        position: p.position,
        nationality: p.nationality,
        birthDate: p.birthDate,
        squadNumber: p.squadNumber,
        availability: p.availability,
        availabilityNote: p.availabilityNote,
        chanceOfPlaying: p.chanceOfPlaying,
        availabilityUpdatedAt: p.availabilityUpdatedAt,
        isTradable: p.active,
        sourceUpdatedAt: bundle.dataAsOf,
        updatedAt: new Date(),
      };
      const found = byRef.get(p.providerRef);
      if (found) {
        await tx.update(schema.players).set(fields).where(eq(schema.players.id, found.id));
        upd++;
      } else {
        let slug = slugify(`${p.firstName} ${p.lastName}`) || slugify(p.displayName) || `player-${p.providerRef}`;
        if (slugs.has(slug)) slug = `${slug}-${slugify(p.providerRef)}`;
        slugs.add(slug);
        await tx.insert(schema.players).values({ provider: ep, providerRef: p.providerRef, slug, ...fields });
        ins++;
      }
    }
    // Players no longer listed by the provider become sell-only.
    let deact = 0;
    for (const p of existing) {
      if (!seen.has(p.providerRef)) {
        await tx.update(schema.players).set({ isTradable: false, updatedAt: new Date() }).where(eq(schema.players.id, p.id));
        deact++;
      }
    }
    return { competitionId: comp.id, inserted: ins, updated: upd, deactivated: deact };
  });

  const ipos = await ipoMissingPlayers(competitionId, ep);
  await setDataStatus({ dataProvider: provider.source, dataMode: provider.mode });
  return { items: inserted + updated, dataAsOf: bundle.dataAsOf, details: { inserted, updated, deactivated, ipos } };
}

/** Give every player without a price an IPO price, exactly once (unique ipo tick per player). */
export async function ipoMissingPlayers(competitionId: number, entityProvider: string) {
  const missing = await db
    .select({ id: schema.players.id, providerRef: schema.players.providerRef, position: schema.players.position })
    .from(schema.players)
    .leftJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
    .where(and(eq(schema.players.competitionId, competitionId), isNull(schema.playerPrices.playerId)));
  if (missing.length === 0) return 0;

  const [{ count: existingIpos }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.priceTicks)
    .innerJoin(schema.players, eq(schema.players.id, schema.priceTicks.playerId))
    .where(and(eq(schema.priceTicks.reason, "ipo"), eq(schema.players.competitionId, competitionId)));
  const open = await seasonOpenAt(competitionId);
  const now = new Date();
  // Initial listing is dated to season open so price history starts there; later listings are dated now.
  const effectiveAt = existingIpos === 0 && open && open < now ? open : now;

  await db.transaction(async (tx) => {
    const version = await lockAndBumpMarketVersion(tx);
    for (const p of missing) {
      const s = ipoState(p.position as Position, priorFor(entityProvider, p.providerRef));
      const inserted = await tx
        .insert(schema.playerPrices)
        .values({
          playerId: p.id,
          priceCents: s.priceCents,
          previousPriceCents: s.priceCents,
          ipoPriceCents: s.priceCents,
          settledPriceCents: s.priceCents,
          fundamentalCents: fundamentalCents(s),
          qualityIndex: 0,
          ...stateColumns(s),
          marketVersion: version,
        })
        .onConflictDoNothing()
        .returning({ id: schema.playerPrices.playerId });
      if (inserted.length === 0) continue;
      await tx
        .insert(schema.priceTicks)
        .values({ playerId: p.id, reason: "ipo", priceCents: s.priceCents, previousPriceCents: s.priceCents, marketVersion: version, effectiveAt })
        .onConflictDoNothing();
    }
    await audit({ actor: "system", action: "market.ipo", metadata: { players: missing.length, competitionId, effectiveAt: effectiveAt.toISOString() } }, tx);
  });
  return missing.length;
}

/** Fixtures that need stats work: in play, or finished but not yet settled. */
async function fixturesNeedingStats(entityProvider: string) {
  return db
    .select()
    .from(schema.fixtures)
    .where(
      and(
        eq(schema.fixtures.provider, entityProvider),
        or(eq(schema.fixtures.status, "live"), and(eq(schema.fixtures.status, "finished"), isNull(schema.fixtures.settledAt))),
      ),
    )
    .orderBy(asc(schema.fixtures.kickoffAt), asc(schema.fixtures.id));
}

async function toNormFixtures(rows: (typeof schema.fixtures.$inferSelect)[]): Promise<NormFixture[]> {
  const clubIds = [...new Set(rows.flatMap((r) => [r.homeClubId, r.awayClubId]).filter((x): x is number => x !== null))];
  const clubs = clubIds.length ? await db.select({ id: schema.clubs.id, ref: schema.clubs.providerRef }).from(schema.clubs).where(inArray(schema.clubs.id, clubIds)) : [];
  const refOf = new Map(clubs.map((c) => [c.id, c.ref]));
  return rows.map((r) => ({
    providerRef: r.providerRef,
    round: r.round,
    kickoffAt: r.kickoffAt,
    homeRef: r.homeClubId ? (refOf.get(r.homeClubId) ?? null) : null,
    awayRef: r.awayClubId ? (refOf.get(r.awayClubId) ?? null) : null,
    homeName: r.homeName,
    awayName: r.awayName,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    status: r.status,
    minute: r.minute,
    statsFinal: r.statsFinal,
    sourceUpdatedAt: r.sourceUpdatedAt,
  }));
}

/** Store stats rows, writing only when the stats fingerprint changed. Returns rows written. */
async function storeMatchStats(provider: MarketDataProvider, rows: NormPlayerMatch[], fixtureIdByRef: Map<string, number>) {
  const ep = provider.entityProvider;
  const players = await db
    .select({ id: schema.players.id, seasonRef: schema.players.providerSeasonRef, position: schema.players.position, clubId: schema.players.clubId })
    .from(schema.players)
    .where(eq(schema.players.provider, ep));
  const bySeasonRef = new Map(players.filter((p) => p.seasonRef).map((p) => [p.seasonRef!, p]));
  const fixtureIds = [...new Set([...fixtureIdByRef.values()])];
  const existing = fixtureIds.length
    ? await db
        .select({ playerId: schema.playerMatchStats.playerId, fixtureId: schema.playerMatchStats.fixtureId, hash: schema.playerMatchStats.statsHash, isFinal: schema.playerMatchStats.isFinal })
        .from(schema.playerMatchStats)
        .where(inArray(schema.playerMatchStats.fixtureId, fixtureIds))
    : [];
  const prior = new Map(existing.map((e) => [`${e.playerId}:${e.fixtureId}`, e]));
  let written = 0;
  let unknownPlayers = 0;
  for (const r of rows) {
    const p = bySeasonRef.get(r.playerSeasonRef);
    const fixtureId = fixtureIdByRef.get(r.fixtureRef);
    if (!p || !fixtureId) {
      unknownPlayers++;
      continue;
    }
    const hash = statsFingerprint(r.stats);
    const before = prior.get(`${p.id}:${fixtureId}`);
    if (before && before.hash === hash && before.isFinal === r.isFinal) continue;
    const scored = scoreMatch(r.stats, p.position as Position);
    const s = r.stats;
    const values = {
      clubId: p.clubId,
      minutes: s.minutes,
      started: s.started,
      goals: s.goals ?? null,
      assists: s.assists ?? null,
      shots: s.shots ?? null,
      shotsOnTarget: s.shotsOnTarget ?? null,
      keyPasses: s.keyPasses ?? null,
      xg: s.xg ?? null,
      xa: s.xa ?? null,
      dribbles: s.dribbles ?? null,
      tackles: s.tackles ?? null,
      interceptions: s.interceptions ?? null,
      clearances: s.clearances ?? null,
      cbi: s.cbi ?? null,
      recoveries: s.recoveries ?? null,
      saves: s.saves ?? null,
      cleanSheet: s.cleanSheet ?? null,
      goalsConceded: s.goalsConceded ?? null,
      xgc: s.xgc,
      ownGoals: s.ownGoals ?? null,
      penaltiesSaved: s.penaltiesSaved ?? null,
      penaltiesMissed: s.penaltiesMissed ?? null,
      yellowCards: s.yellowCards ?? null,
      redCards: s.redCards ?? null,
      performanceScore: s.minutes > 0 ? scored.score : null,
      expectedScore: s.minutes > 0 ? scored.expected : null,
      scoreBreakdown: s.minutes > 0 ? { ...scored.breakdown, z: scored.z } : null,
      isFinal: r.isFinal,
      statsHash: hash,
      source: provider.source,
      sourceUpdatedAt: r.sourceUpdatedAt,
      ingestedAt: new Date(),
    };
    await db
      .insert(schema.playerMatchStats)
      .values({ playerId: p.id, fixtureId, ...values })
      .onConflictDoUpdate({ target: [schema.playerMatchStats.playerId, schema.playerMatchStats.fixtureId], set: values });
    written++;
  }
  return { written, unknownPlayers };
}

export interface SettlementMove {
  playerId: number;
  before: number;
  after: number;
  ret: number;
}

/** Settle one finished fixture exactly once. Returns null if already settled or no stats. */
export async function settleFixture(fixtureId: number, now = new Date()): Promise<{ version: number; moves: SettlementMove[] } | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ id: number; settled_at: Date | null; kickoff_at: Date | null; stats_final: boolean }>(
      sql`SELECT id, settled_at, kickoff_at, stats_final FROM fixtures WHERE id = ${fixtureId} FOR UPDATE`,
    );
    const fx = locked.rows[0];
    if (!fx || fx.settled_at || !fx.stats_final) return null;
    const has = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM player_match_stats WHERE fixture_id = ${fixtureId}`);
    if (Number(has.rows[0]?.n ?? 0) === 0) return null;

    // Market first, then prices (global lock order — see market/state.ts).
    const version = await lockAndBumpMarketVersion(tx);
    const rows = await tx
      .select({ stats: schema.playerMatchStats, price: schema.playerPrices, position: schema.players.position })
      .from(schema.playerMatchStats)
      .innerJoin(schema.players, eq(schema.players.id, schema.playerMatchStats.playerId))
      .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.playerMatchStats.playerId))
      .where(eq(schema.playerMatchStats.fixtureId, fixtureId))
      .orderBy(asc(schema.playerMatchStats.playerId))
      .for("update", { of: schema.playerPrices });
    const kickoff = fx.kickoff_at ? new Date(fx.kickoff_at) : null;
    const effectiveAt = kickoff && kickoff.getTime() + MATCH_LENGTH_MS < now.getTime() ? new Date(kickoff.getTime() + MATCH_LENGTH_MS) : now;
    const moves: SettlementMove[] = [];

    for (const { stats, price, position } of rows) {
      const settled = settledStateFromRow(price, position as Position);
      const scored = scoreMatch(stats, position as Position);
      const step = applyMatch(settled, scored.z, stats.minutes);
      const after = step.state.priceCents;
      await tx
        .update(schema.playerPrices)
        .set({
          priceCents: after,
          previousPriceCents: step.played ? settled.priceCents : price.previousPriceCents,
          settledPriceCents: after,
          fundamentalCents: step.fundamentalCents,
          qualityIndex: step.quality,
          ...stateColumns(step.state),
          liveFixtureId: price.liveFixtureId === fixtureId ? null : price.liveFixtureId,
          marketVersion: version,
          updatedAt: now,
        })
        .where(eq(schema.playerPrices.playerId, price.playerId));
      if (step.played) {
        await tx.insert(schema.priceTicks).values({
          playerId: price.playerId,
          fixtureId,
          reason: "match_final",
          priceCents: after,
          previousPriceCents: settled.priceCents,
          performanceScore: scored.score,
          zScore: scored.z,
          marketVersion: version,
          statsHash: stats.statsHash,
          effectiveAt,
        });
        moves.push({ playerId: price.playerId, before: settled.priceCents, after, ret: step.ret });
      }
      if (!stats.isFinal) {
        await tx.update(schema.playerMatchStats).set({ isFinal: true }).where(eq(schema.playerMatchStats.id, stats.id));
      }
    }
    await tx.update(schema.fixtures).set({ settledAt: now, updatedAt: now }).where(eq(schema.fixtures.id, fixtureId));
    await audit({ actor: "system", action: "market.fixture_settled", entityType: "fixture", entityId: fixtureId, metadata: { version, priced: moves.length } }, tx);
    return { version, moves };
  });
}

/** Provisional prices for players in a live fixture (recomputed from the settled base each time). */
export async function applyLiveTicks(fixtureId: number, now = new Date()) {
  return db.transaction(async (tx) => {
    await lockMarket(tx); // market first, then prices
    const rows = await tx
      .select({ stats: schema.playerMatchStats, price: schema.playerPrices, position: schema.players.position })
      .from(schema.playerMatchStats)
      .innerJoin(schema.players, eq(schema.players.id, schema.playerMatchStats.playerId))
      .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.playerMatchStats.playerId))
      .where(eq(schema.playerMatchStats.fixtureId, fixtureId))
      .orderBy(asc(schema.playerMatchStats.playerId))
      .for("update", { of: schema.playerPrices });
    const changes = rows
      .map(({ stats, price, position }) => {
        const settled = settledStateFromRow(price, position as Position);
        const scored = scoreMatch(stats, position as Position);
        const next = livePrice(settled, scored.z, stats.minutes);
        return { stats, price, next, scored, settled };
      })
      .filter((c) => c.next !== c.price.priceCents || (c.stats.minutes > 0 && c.price.liveFixtureId !== fixtureId));
    await tx.update(schema.fixtures).set({ lastStatsSyncAt: now }).where(eq(schema.fixtures.id, fixtureId));
    if (changes.length === 0) return { version: null as number | null, changed: 0 };
    const version = await lockAndBumpMarketVersion(tx);
    for (const c of changes) {
      await tx
        .update(schema.playerPrices)
        .set({ priceCents: c.next, previousPriceCents: c.settled.priceCents, liveFixtureId: fixtureId, marketVersion: version, updatedAt: now })
        .where(eq(schema.playerPrices.playerId, c.price.playerId));
      await tx.insert(schema.priceTicks).values({
        playerId: c.price.playerId,
        fixtureId,
        reason: "match_live",
        priceCents: c.next,
        previousPriceCents: c.price.priceCents,
        performanceScore: c.scored.score,
        zScore: c.scored.z,
        marketVersion: version,
        statsHash: c.stats.statsHash,
        effectiveAt: now,
      });
    }
    return { version, changed: changes.length };
  });
}

export async function syncStats(provider: MarketDataProvider, now = new Date()) {
  const candidates = await fixturesNeedingStats(provider.entityProvider);
  if (candidates.length === 0) return { items: 0, status: "skipped" as const, details: { reason: "no live or unsettled fixtures" } };
  const norm = await toNormFixtures(candidates);
  const stats = await provider.fetchMatchStats(norm);
  const fixtureIdByRef = new Map(candidates.map((c) => [c.providerRef, c.id]));
  const { written, unknownPlayers } = await storeMatchStats(provider, stats, fixtureIdByRef);
  const withStats = new Set(stats.map((s) => s.fixtureRef));

  let settled = 0;
  let liveChanged = 0;
  const allMoves: { fixtureId: number; moves: SettlementMove[] }[] = [];
  for (const fx of candidates) {
    if (!withStats.has(fx.providerRef)) continue;
    if (fx.status === "finished" && fx.statsFinal) {
      const res = await settleFixture(fx.id, now);
      if (res) {
        settled++;
        allMoves.push({ fixtureId: fx.id, moves: res.moves });
      }
    } else if (fx.status === "live" || (fx.status === "finished" && !fx.statsFinal)) {
      const res = await applyLiveTicks(fx.id, now);
      liveChanged += res.changed;
    }
  }
  if (allMoves.length) await notifyHoldersOfMoves(allMoves).catch((e) => log.warn("move notifications failed", { error: String(e) }));
  const missingStats = candidates.filter((c) => !withStats.has(c.providerRef)).length;
  return {
    items: written,
    status: missingStats > 0 && settled === 0 && liveChanged === 0 ? ("partial" as const) : ("success" as const),
    details: { candidates: candidates.length, written, settled, liveChanged, unknownPlayers, awaitingStats: missingStats },
  };
}

/** Notify holders when a settlement moves one of their players by ≥ BIG_MOVE_NOTIFY. */
async function notifyHoldersOfMoves(batches: { fixtureId: number; moves: SettlementMove[] }[]) {
  for (const { fixtureId, moves } of batches) {
    const big = moves.filter((m) => Math.abs(m.ret) >= BIG_MOVE_NOTIFY);
    if (big.length === 0) continue;
    const [fx] = await db.select().from(schema.fixtures).where(eq(schema.fixtures.id, fixtureId));
    const holders = await db
      .select({ userId: schema.positions.userId, playerId: schema.positions.playerId, name: schema.players.displayName, slug: schema.players.slug })
      .from(schema.positions)
      .innerJoin(schema.players, eq(schema.players.id, schema.positions.playerId))
      .innerJoin(schema.users, eq(schema.users.id, schema.positions.userId))
      .where(and(inArray(schema.positions.playerId, big.map((b) => b.playerId)), sql`${schema.positions.quantity} > 0`, eq(schema.users.notifyTrades, true)));
    const byPlayer = new Map(big.map((b) => [b.playerId, b]));
    const score = fx && fx.homeScore !== null ? `${fx.homeName} ${fx.homeScore}–${fx.awayScore} ${fx.awayName}` : "their latest match";
    if (holders.length === 0) continue;
    await db.insert(schema.notifications).values(
      holders.map((h) => {
        const mv = byPlayer.get(h.playerId)!;
        const pct = ((mv.after - mv.before) / mv.before) * 100;
        return {
          userId: h.userId,
          kind: "market_move",
          title: `${h.name} ${pct >= 0 ? "rose" : "fell"} ${Math.abs(pct).toFixed(1)}%`,
          body: `Settled after ${score}.`,
          link: `/players/${h.slug}`,
        };
      }),
    );
  }
}
