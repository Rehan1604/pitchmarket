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
import type { FixtureBundle, FixtureOnlyProvider, MarketDataProvider, NormCompetition, NormFixture, NormPlayerMatch, ReferenceBundle } from "./providers/types";
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

export async function syncFixtures(provider: MarketDataProvider, opts: { window?: "full" | "recent" } = {}) {
  const bundle = await provider.fetchFixtures(opts);
  const live = provider.mode === "live" && provider.capabilities.live;
  const result = await db.transaction(async (tx) => {
    const comp = await upsertCompetition(tx, bundle.competition, provider.entityProvider, { hasPlayerStats: true, hasLiveData: live });
    const clubIds = await upsertClubs(tx, comp.id, provider.entityProvider, bundle.clubs);
    const n = await upsertFixtures(tx, comp.id, provider.entityProvider, clubIds, bundle.fixtures);
    return { competitionId: comp.id, fixtures: n };
  });
  if (provider.primary !== false) {
    await setDataStatus({ dataProvider: provider.source, dataMode: provider.mode, ...(bundle.dataAsOf ? { dataAsOf: bundle.dataAsOf } : {}) });
  }
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
  return applyReferenceBundle(provider, await provider.fetchReference());
}

/** Upsert a reference bundle; players of this competition missing from it become sell-only. */
export async function applyReferenceBundle(provider: MarketDataProvider, bundle: ReferenceBundle) {
  const ep = provider.entityProvider;
  const live = provider.mode === "live" && provider.capabilities.live;

  const { competitionId, inserted, updated, deactivated } = await db.transaction(async (tx) => {
    const comp = await upsertCompetition(tx, bundle.competition, ep, { hasPlayerStats: true, hasLiveData: live });
    const clubIds = await upsertClubs(tx, comp.id, ep, bundle.clubs);
    const existing = await tx
      .select({ id: schema.players.id, providerRef: schema.players.providerRef, slug: schema.players.slug, competitionId: schema.players.competitionId })
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
    // Players of this competition no longer listed by the provider become sell-only.
    // (A feed can serve several competitions; each sync only judges its own.)
    let deact = 0;
    for (const p of existing) {
      if (p.competitionId === comp.id && !seen.has(p.providerRef)) {
        await tx.update(schema.players).set({ isTradable: false, updatedAt: new Date() }).where(eq(schema.players.id, p.id));
        deact++;
      }
    }
    return { competitionId: comp.id, inserted: ins, updated: upd, deactivated: deact };
  });

  const ipos = await ipoMissingPlayers(competitionId, ep);
  if (provider.primary !== false) await setDataStatus({ dataProvider: provider.source, dataMode: provider.mode });
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

  // Initial listing (nothing in this competition settled yet) is dated to season open so
  // price history starts there; players added once matches have been priced are dated now.
  // (Counting existing IPO ticks instead would misfire when one player was first listed
  // through another competition, e.g. a squad overlap between two ESPN leagues.)
  const [{ count: settledCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.fixtures)
    .where(and(eq(schema.fixtures.competitionId, competitionId), sql`${schema.fixtures.settledAt} IS NOT NULL`));
  const open = await seasonOpenAt(competitionId);
  const now = new Date();
  const effectiveAt = settledCount === 0 && open && open < now ? open : now;

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

type FixtureRef = { id: number; competitionId: number };

/**
 * Store stats rows, writing only when the stats fingerprint changed.
 * Players resolve by the feed's own ids, or through entity_links when the feed
 * reports a player whose market identity lives in another feed (e.g. ESPN's
 * Champions League sheet for an FPL-listed Premier League player).
 */
async function storeMatchStats(provider: MarketDataProvider, rows: NormPlayerMatch[], fixtureByRef: Map<string, FixtureRef>) {
  const ep = provider.entityProvider;
  type P = { id: number; seasonRef: string | null; position: string; clubId: number | null };
  const own = await db
    .select({ id: schema.players.id, seasonRef: schema.players.providerSeasonRef, position: schema.players.position, clubId: schema.players.clubId })
    .from(schema.players)
    .where(eq(schema.players.provider, ep));
  const byRef = new Map<string, P>(own.filter((p) => p.seasonRef).map((p) => [p.seasonRef!, p]));
  const linked = await db
    .select({ ref: schema.entityLinks.providerRef, id: schema.players.id, position: schema.players.position, clubId: schema.players.clubId })
    .from(schema.entityLinks)
    .innerJoin(schema.players, eq(schema.players.id, schema.entityLinks.localId))
    .where(and(eq(schema.entityLinks.kind, "player"), eq(schema.entityLinks.provider, ep)));
  for (const l of linked) if (!byRef.has(l.ref)) byRef.set(l.ref, { id: l.id, seasonRef: l.ref, position: l.position, clubId: l.clubId });

  // A club row exists per competition; the stats row points at the club as it appears in this fixture.
  const clubRows = await db.select({ id: schema.clubs.id, ref: schema.clubs.providerRef, competitionId: schema.clubs.competitionId }).from(schema.clubs).where(eq(schema.clubs.provider, ep));
  const clubIn = new Map(clubRows.map((c) => [`${c.competitionId}:${c.ref}`, c.id]));

  const fixtureIds = [...new Set([...fixtureByRef.values()].map((f) => f.id))];
  const existing = fixtureIds.length
    ? await db
        .select({ playerId: schema.playerMatchStats.playerId, fixtureId: schema.playerMatchStats.fixtureId, hash: schema.playerMatchStats.statsHash, isFinal: schema.playerMatchStats.isFinal })
        .from(schema.playerMatchStats)
        .where(inArray(schema.playerMatchStats.fixtureId, fixtureIds))
    : [];
  const prior = new Map(existing.map((e) => [`${e.playerId}:${e.fixtureId}`, e]));
  let written = 0;
  let unknownPlayers = 0;
  const knownByFixture = new Map<number, number>();
  for (const r of rows) {
    const p = byRef.get(r.playerSeasonRef);
    const fx = fixtureByRef.get(r.fixtureRef);
    if (!p || !fx) {
      unknownPlayers++;
      continue;
    }
    knownByFixture.set(fx.id, (knownByFixture.get(fx.id) ?? 0) + 1);
    const fixtureId = fx.id;
    const hash = statsFingerprint(r.stats);
    const before = prior.get(`${p.id}:${fixtureId}`);
    if (before && before.hash === hash && before.isFinal === r.isFinal) continue;
    const scored = scoreMatch(r.stats, p.position as Position);
    const s = r.stats;
    const clubId = (r.clubRef ? clubIn.get(`${fx.competitionId}:${r.clubRef}`) : undefined) ?? p.clubId;
    const values = {
      clubId,
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
  return { written, unknownPlayers, knownByFixture };
}

/**
 * For feeds that only list the matchday squad: once a match is final, every other
 * tradable player of both clubs gets a 0-minute row so the minutes-share (role)
 * model sees the match they missed. Never overwrites a real row.
 */
export async function fillSquadZeroRows(fixtureId: number, source: string) {
  const hash = statsFingerprint({ minutes: 0 });
  const res = await db.execute(sql`
    INSERT INTO player_match_stats (player_id, fixture_id, club_id, minutes, started, is_final, stats_hash, source, ingested_at)
    SELECT DISTINCT p.id, f.id, fc.id, 0, false, true, ${hash}, ${source}, now()
    FROM fixtures f
    JOIN clubs fc ON fc.id IN (f.home_club_id, f.away_club_id)
    JOIN clubs pc ON pc.provider = fc.provider AND pc.provider_ref = fc.provider_ref
    JOIN players p ON p.club_id = pc.id AND p.provider = fc.provider AND p.is_tradable
    WHERE f.id = ${fixtureId}
    ON CONFLICT (player_id, fixture_id) DO NOTHING`);
  return res.rowCount ?? 0;
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

    // Price paths are strictly chronological: a match older than the player's
    // latest priced match (e.g. a backfilled cup tie from another feed) is kept
    // as stats but not priced, so replaying the path always reproduces the price.
    const lastPriced = await lastPricedKickoffs(tx, rows.map((r) => r.price.playerId));
    let outOfOrder = 0;

    for (const { stats, price, position } of rows) {
      const last = lastPriced.get(price.playerId);
      if (kickoff && last !== undefined && last > kickoff.getTime()) {
        outOfOrder++;
        await tx.update(schema.playerMatchStats).set({ isFinal: true, pricingNote: "out_of_order" }).where(eq(schema.playerMatchStats.id, stats.id));
        continue;
      }
      const move = await priceSettledRow(tx, { stats, price, position: position as Position, fixtureId, version, effectiveAt, now });
      if (move) moves.push(move);
    }
    await tx.update(schema.fixtures).set({ settledAt: now, updatedAt: now }).where(eq(schema.fixtures.id, fixtureId));
    await audit({ actor: "system", action: "market.fixture_settled", entityType: "fixture", entityId: fixtureId, metadata: { version, priced: moves.length, outOfOrder } }, tx);
    return { version, moves };
  });
}

type StatsRow = typeof schema.playerMatchStats.$inferSelect;
type PriceRow = typeof schema.playerPrices.$inferSelect;

/** Latest kickoff among each player's priced (match_final) fixtures. */
async function lastPricedKickoffs(tx: Tx, playerIds: number[]) {
  const out = new Map<number, number>();
  if (playerIds.length === 0) return out;
  const res = await tx.execute<{ player_id: number; last: Date }>(sql`
    SELECT pt.player_id, max(f.kickoff_at) AS last FROM price_ticks pt JOIN fixtures f ON f.id = pt.fixture_id
    WHERE pt.reason = 'match_final' AND pt.player_id IN (${sql.join(playerIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY pt.player_id`);
  for (const r of res.rows) if (r.last) out.set(Number(r.player_id), new Date(r.last).getTime());
  return out;
}

/** Apply one final stats row to a player's settled state (one match_final tick if he played). */
async function priceSettledRow(
  tx: Tx,
  a: { stats: StatsRow; price: PriceRow; position: Position; fixtureId: number; version: number; effectiveAt: Date; now: Date },
): Promise<SettlementMove | null> {
  const { stats, price, position, fixtureId, version, effectiveAt, now } = a;
  const settled = settledStateFromRow(price, position);
  const scored = scoreMatch(stats, position);
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
  if (!stats.isFinal || stats.pricingNote) {
    await tx.update(schema.playerMatchStats).set({ isFinal: true, pricingNote: null }).where(eq(schema.playerMatchStats.id, stats.id));
  }
  if (!step.played) return null;
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
  return { playerId: price.playerId, before: settled.priceCents, after, ret: step.ret };
}

/**
 * One-off repair: price rows an earlier release skipped as "before_listing"
 * (players whose listing was mis-dated to the sync time). Per player, in kickoff
 * order, still never out of order. Idempotent: priced rows lose their note.
 */
export async function repriceSkippedRows(note = "before_listing", opts: { maxMs?: number; batch?: number } = {}, now = new Date()) {
  const started = Date.now();
  const maxMs = opts.maxMs ?? 12 * 60_000;
  let priced = 0;
  let outOfOrder = 0;
  let playersDone = 0;
  for (;;) {
    if (Date.now() - started > maxMs) break;
    const batch = await db
      .selectDistinct({ playerId: schema.playerMatchStats.playerId })
      .from(schema.playerMatchStats)
      .where(eq(schema.playerMatchStats.pricingNote, note))
      .limit(opts.batch ?? 100);
    if (batch.length === 0) break;
    const r = await repriceBatch(batch.map((b) => b.playerId), note, now);
    priced += r.priced;
    outOfOrder += r.outOfOrder;
    playersDone += batch.length;
  }
  return { items: priced, status: playersDone ? ("success" as const) : ("skipped" as const), details: { players: playersDone, priced, outOfOrder, ms: Date.now() - started } };
}

async function repriceBatch(playerIds: number[], note: string, now: Date) {
  let priced = 0;
  let outOfOrder = 0;
  for (const playerId of playerIds) {
    await db.transaction(async (tx) => {
      const version = await lockAndBumpMarketVersion(tx);
      const rows = await tx
        .select({ stats: schema.playerMatchStats, fixture: schema.fixtures, position: schema.players.position })
        .from(schema.playerMatchStats)
        .innerJoin(schema.fixtures, eq(schema.fixtures.id, schema.playerMatchStats.fixtureId))
        .innerJoin(schema.players, eq(schema.players.id, schema.playerMatchStats.playerId))
        .where(and(eq(schema.playerMatchStats.playerId, playerId), eq(schema.playerMatchStats.pricingNote, note), sql`${schema.fixtures.settledAt} IS NOT NULL`))
        .orderBy(asc(schema.fixtures.kickoffAt), asc(schema.fixtures.id));
      for (const r of rows) {
        const [price] = await tx.select().from(schema.playerPrices).where(eq(schema.playerPrices.playerId, playerId)).for("update");
        const last = (await lastPricedKickoffs(tx, [playerId])).get(playerId);
        const kickoff = r.fixture.kickoffAt;
        if (!price || !kickoff || (last !== undefined && last > kickoff.getTime())) {
          await tx.update(schema.playerMatchStats).set({ pricingNote: "out_of_order" }).where(eq(schema.playerMatchStats.id, r.stats.id));
          outOfOrder++;
          continue;
        }
        const effectiveAt = new Date(Math.min(kickoff.getTime() + MATCH_LENGTH_MS, now.getTime()));
        await priceSettledRow(tx, { stats: r.stats, price, position: r.position as Position, fixtureId: r.fixture.id, version, effectiveAt, now });
        priced++;
      }
    });
  }
  return { priced, outOfOrder };
}

/** The stats fingerprint without the minutes component ("m:63|goals:1|…" → "goals:1|…"). */
export function eventPart(hash: string | null): string {
  return (hash ?? "").replace(/^m:[^|]*\|?/, "");
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
    // History rows only when something happened (goal, shot, card, sub…), not for
    // the per-minute drift of expected output — keeps the append-only tick ledger
    // small enough for a free database across a whole season of five leagues.
    const lastTick = new Map<number, string | null>();
    const prev = await tx.execute<{ player_id: number; stats_hash: string | null }>(sql`
      SELECT DISTINCT ON (player_id) player_id, stats_hash FROM price_ticks
      WHERE fixture_id = ${fixtureId} AND reason = 'match_live' ORDER BY player_id, id DESC`);
    for (const r of prev.rows) lastTick.set(Number(r.player_id), r.stats_hash);
    for (const c of changes) {
      await tx
        .update(schema.playerPrices)
        .set({ priceCents: c.next, previousPriceCents: c.settled.priceCents, liveFixtureId: fixtureId, marketVersion: version, updatedAt: now })
        .where(eq(schema.playerPrices.playerId, c.price.playerId));
      const before = lastTick.get(c.price.playerId);
      if (before !== undefined && eventPart(before) === eventPart(c.stats.statsHash)) continue;
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

export async function syncStats(provider: MarketDataProvider, now = new Date(), opts: { maxFixtures?: number } = {}) {
  const all = await fixturesNeedingStats(provider.entityProvider);
  if (all.length === 0) return { items: 0, status: "skipped" as const, details: { reason: "no live or unsettled fixtures" } };
  // Live matches always; then the oldest unsettled ones (chronological settlement), capped per run.
  const live = all.filter((c) => c.status === "live");
  const rest = all.filter((c) => c.status !== "live");
  const cap = opts.maxFixtures ?? Infinity;
  const candidates = [...live, ...rest.slice(0, Math.max(0, cap - live.length))].sort(
    (a, b) => (a.kickoffAt?.getTime() ?? 0) - (b.kickoffAt?.getTime() ?? 0) || a.id - b.id,
  );
  const backlog = all.length - candidates.length;
  const norm = await toNormFixtures(candidates);
  const stats = await provider.fetchMatchStats(norm);
  const fixtureByRef = new Map(candidates.map((c) => [c.providerRef, { id: c.id, competitionId: c.competitionId }]));
  const { written, unknownPlayers, knownByFixture } = await storeMatchStats(provider, stats, fixtureByRef);
  const withStats = new Set(stats.map((s) => s.fixtureRef));
  const attemptedFinished = candidates.filter((c) => c.status === "finished").map((c) => c.id);
  if (attemptedFinished.length) await db.update(schema.fixtures).set({ lastStatsSyncAt: now }).where(inArray(schema.fixtures.id, attemptedFinished));

  let settled = 0;
  let liveChanged = 0;
  let emptySettled = 0;
  const allMoves: { fixtureId: number; moves: SettlementMove[] }[] = [];
  for (const fx of candidates) {
    if (!withStats.has(fx.providerRef)) continue;
    if (fx.status === "finished" && fx.statsFinal) {
      if ((knownByFixture.get(fx.id) ?? 0) === 0) {
        // Match sheet fetched but none of its players are listed here (e.g. a qualifier
        // between clubs that never reached the league phase): nothing to price.
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.playerMatchStats).where(eq(schema.playerMatchStats.fixtureId, fx.id));
        if (n === 0) {
          await db.update(schema.fixtures).set({ settledAt: now, updatedAt: now }).where(and(eq(schema.fixtures.id, fx.id), isNull(schema.fixtures.settledAt)));
          emptySettled++;
          continue;
        }
      }
      if (provider.fillSquadOnFinal) await fillSquadZeroRows(fx.id, provider.source);
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
    details: { candidates: candidates.length, written, settled, emptySettled, liveChanged, unknownPlayers, awaitingStats: missingStats, backlog },
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
