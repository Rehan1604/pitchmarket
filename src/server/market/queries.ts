import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { notFound } from "@/server/http";
import { getMarketState } from "./state";
import { roleShare } from "./pricing";

export const marketFilterSchema = z.object({
  q: z.string().trim().max(60).optional(),
  position: z.enum(["GK", "DEF", "MID", "FWD"]).optional(),
  club: z.coerce.number().int().positive().optional(),
  competition: z.string().trim().max(10).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  sort: z.enum(["price", "change", "quality", "form", "name", "held"]).default("price"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(30),
  watchlist: z.enum(["1", "true"]).optional(),
  tradable: z.enum(["all", "tradable"]).default("tradable"),
});
export type MarketFilter = z.infer<typeof marketFilterSchema>;

const changeExpr = sql<number>`(${schema.playerPrices.priceCents} - ${schema.playerPrices.previousPriceCents})::float / NULLIF(${schema.playerPrices.previousPriceCents}, 0)`;
const heldExpr = sql<number>`(SELECT COALESCE(SUM(quantity), 0)::int FROM positions WHERE player_id = ${schema.players.id} AND quantity > 0)`;

export async function listMarket(filter: MarketFilter, viewerId?: string | null) {
  const conds: SQL[] = [];
  if (filter.tradable === "tradable") conds.push(eq(schema.players.isTradable, true));
  if (filter.q) {
    const q = `%${filter.q.replace(/[%_\\]/g, "")}%`;
    conds.push(or(ilike(schema.players.displayName, q), ilike(schema.players.firstName, q), ilike(schema.players.lastName, q), ilike(schema.clubs.name, q))!);
  }
  if (filter.position) conds.push(eq(schema.players.position, filter.position));
  if (filter.club) conds.push(eq(schema.players.clubId, filter.club));
  if (filter.competition) conds.push(eq(schema.competitions.code, filter.competition.toUpperCase()));
  if (filter.minPrice !== undefined) conds.push(gte(schema.playerPrices.priceCents, Math.round(filter.minPrice * 100)));
  if (filter.maxPrice !== undefined) conds.push(lte(schema.playerPrices.priceCents, Math.round(filter.maxPrice * 100)));
  if (filter.watchlist && viewerId) {
    conds.push(sql`${schema.players.id} IN (SELECT player_id FROM watchlist WHERE user_id = ${viewerId}::uuid)`);
  }
  const order = (() => {
    const d = filter.dir === "asc" ? asc : desc;
    switch (filter.sort) {
      case "change":
        return [d(changeExpr), asc(schema.players.displayName)];
      case "quality":
        return [d(schema.playerPrices.qualityIndex), asc(schema.players.displayName)];
      case "form":
        return [d(schema.playerPrices.formIndex), asc(schema.players.displayName)];
      case "name":
        return [d(schema.players.displayName), asc(schema.players.id)];
      case "held":
        return [d(heldExpr), desc(schema.playerPrices.priceCents)];
      default:
        return [d(schema.playerPrices.priceCents), asc(schema.players.displayName)];
    }
  })();
  const where = conds.length ? and(...conds) : undefined;
  const base = db
    .select({
      id: schema.players.id,
      slug: schema.players.slug,
      name: schema.players.displayName,
      firstName: schema.players.firstName,
      lastName: schema.players.lastName,
      position: schema.players.position,
      club: schema.clubs.shortName,
      clubName: schema.clubs.name,
      clubId: schema.players.clubId,
      competition: schema.competitions.code,
      availability: schema.players.availability,
      chanceOfPlaying: schema.players.chanceOfPlaying,
      isTradable: schema.players.isTradable,
      priceCents: schema.playerPrices.priceCents,
      previousPriceCents: schema.playerPrices.previousPriceCents,
      ipoPriceCents: schema.playerPrices.ipoPriceCents,
      qualityIndex: schema.playerPrices.qualityIndex,
      formIndex: schema.playerPrices.formIndex,
      matchesPriced: schema.playerPrices.matchesPriced,
      liveFixtureId: schema.playerPrices.liveFixtureId,
      sharesHeld: heldExpr,
    })
    .from(schema.players)
    .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
    .innerJoin(schema.competitions, eq(schema.competitions.id, schema.players.competitionId))
    .leftJoin(schema.clubs, eq(schema.clubs.id, schema.players.clubId));
  const rows = await base
    .where(where)
    .orderBy(...order)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.players)
    .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
    .innerJoin(schema.competitions, eq(schema.competitions.id, schema.players.competitionId))
    .leftJoin(schema.clubs, eq(schema.clubs.id, schema.players.clubId))
    .where(where);
  const watch = viewerId && rows.length
    ? new Set(
        (
          await db
            .select({ id: schema.watchlist.playerId })
            .from(schema.watchlist)
            .where(and(eq(schema.watchlist.userId, viewerId), inArray(schema.watchlist.playerId, rows.map((r) => r.id))))
        ).map((r) => r.id),
      )
    : new Set<number>();
  const sparks = await sparklines(rows.map((r) => r.id));
  return {
    rows: rows.map((r) => ({ ...r, watched: watch.has(r.id), spark: sparks.get(r.id) ?? [] })),
    total,
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

/** Last N settled prices per player (real price ticks only). */
export async function sparklines(playerIds: number[], points = 12) {
  const out = new Map<number, number[]>();
  if (playerIds.length === 0) return out;
  const res = await db.execute<{ player_id: number; prices: string[] }>(sql`
    SELECT player_id, array_agg(price_cents ORDER BY effective_at) AS prices FROM (
      SELECT player_id, price_cents, effective_at,
             row_number() OVER (PARTITION BY player_id ORDER BY effective_at DESC, id DESC) AS rn
      FROM price_ticks
      WHERE player_id IN (${sql.join(playerIds.map((id) => sql`${id}`), sql`, `)}) AND reason IN ('ipo', 'match_final')
    ) t WHERE rn <= ${points} GROUP BY player_id`);
  for (const r of res.rows) out.set(Number(r.player_id), r.prices.map(Number));
  return out;
}

export async function listClubs(competitionCode?: string) {
  const conds = [eq(schema.competitions.hasPlayerStats, true)];
  if (competitionCode) conds.push(eq(schema.competitions.code, competitionCode));
  return db
    .select({ id: schema.clubs.id, name: schema.clubs.name, shortName: schema.clubs.shortName, competition: schema.competitions.code })
    .from(schema.clubs)
    .innerJoin(schema.competitions, eq(schema.competitions.id, schema.clubs.competitionId))
    .where(and(...conds))
    .orderBy(asc(schema.clubs.name));
}

export async function getPlayerDetail(slug: string, viewerId?: string | null) {
  const [row] = await db
    .select({
      player: schema.players,
      price: schema.playerPrices,
      club: schema.clubs,
      competition: schema.competitions,
    })
    .from(schema.players)
    .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
    .innerJoin(schema.competitions, eq(schema.competitions.id, schema.players.competitionId))
    .leftJoin(schema.clubs, eq(schema.clubs.id, schema.players.clubId))
    .where(eq(schema.players.slug, slug));
  if (!row) throw notFound("Player not found.");
  const p = row.player;

  const history = await db
    .select({
      priceCents: schema.priceTicks.priceCents,
      previousPriceCents: schema.priceTicks.previousPriceCents,
      reason: schema.priceTicks.reason,
      effectiveAt: schema.priceTicks.effectiveAt,
      fixtureId: schema.priceTicks.fixtureId,
      zScore: schema.priceTicks.zScore,
    })
    .from(schema.priceTicks)
    .where(and(eq(schema.priceTicks.playerId, p.id), inArray(schema.priceTicks.reason, ["ipo", "match_final", "admin"])))
    .orderBy(asc(schema.priceTicks.effectiveAt), asc(schema.priceTicks.id));

  const liveTicks = row.price.liveFixtureId
    ? await db
        .select({ priceCents: schema.priceTicks.priceCents, effectiveAt: schema.priceTicks.effectiveAt })
        .from(schema.priceTicks)
        .where(and(eq(schema.priceTicks.playerId, p.id), eq(schema.priceTicks.fixtureId, row.price.liveFixtureId), eq(schema.priceTicks.reason, "match_live")))
        .orderBy(asc(schema.priceTicks.effectiveAt))
    : [];

  const matches = await db
    .select({ stats: schema.playerMatchStats, fixture: schema.fixtures })
    .from(schema.playerMatchStats)
    .innerJoin(schema.fixtures, eq(schema.fixtures.id, schema.playerMatchStats.fixtureId))
    .where(eq(schema.playerMatchStats.playerId, p.id))
    .orderBy(desc(schema.fixtures.kickoffAt));

  const priceAfter = new Map(history.filter((h) => h.fixtureId).map((h) => [h.fixtureId!, h]));
  const matchRows = matches.map(({ stats, fixture }) => {
    const home = fixture.homeClubId === (stats.clubId ?? p.clubId);
    const tick = priceAfter.get(fixture.id);
    return {
      fixtureId: fixture.id,
      round: fixture.round,
      kickoffAt: fixture.kickoffAt,
      opponent: home ? fixture.awayName : fixture.homeName,
      home,
      score: fixture.homeScore !== null ? `${fixture.homeScore}–${fixture.awayScore}` : null,
      status: fixture.status,
      settled: Boolean(fixture.settledAt),
      minutes: stats.minutes,
      goals: stats.goals,
      assists: stats.assists,
      xg: stats.xg,
      xa: stats.xa,
      shots: stats.shots,
      keyPasses: stats.keyPasses,
      tackles: stats.tackles,
      cbi: stats.cbi,
      interceptions: stats.interceptions,
      recoveries: stats.recoveries,
      saves: stats.saves,
      cleanSheet: stats.cleanSheet,
      goalsConceded: stats.goalsConceded,
      yellowCards: stats.yellowCards,
      redCards: stats.redCards,
      performanceScore: stats.performanceScore,
      expectedScore: stats.expectedScore,
      z: stats.scoreBreakdown ? (stats.scoreBreakdown as Record<string, number>).z ?? null : null,
      breakdown: stats.scoreBreakdown,
      priceAfterCents: tick?.priceCents ?? null,
      priceBeforeCents: tick?.previousPriceCents ?? null,
      source: stats.source,
    };
  });

  const season = matchRows.reduce(
    (acc, m) => {
      if (m.minutes > 0) acc.apps += 1;
      acc.minutes += m.minutes;
      acc.goals += m.goals ?? 0;
      acc.assists += m.assists ?? 0;
      if (m.xg !== null) acc.xg = (acc.xg ?? 0) + m.xg;
      if (m.xa !== null) acc.xa = (acc.xa ?? 0) + m.xa;
      if (m.saves !== null) acc.saves = (acc.saves ?? 0) + m.saves;
      if (m.cleanSheet && m.minutes >= 60) acc.cleanSheets += 1;
      if (m.tackles !== null) acc.tackles = (acc.tackles ?? 0) + m.tackles;
      if (m.recoveries !== null) acc.recoveries = (acc.recoveries ?? 0) + m.recoveries;
      acc.yellow += m.yellowCards ?? 0;
      acc.red += m.redCards ?? 0;
      if (m.performanceScore !== null && m.minutes > 0) acc.scoreSum += m.performanceScore;
      return acc;
    },
    { apps: 0, minutes: 0, goals: 0, assists: 0, xg: null as number | null, xa: null as number | null, saves: null as number | null, cleanSheets: 0, tackles: null as number | null, recoveries: null as number | null, yellow: 0, red: 0, scoreSum: 0 },
  );

  const now = new Date();
  const nextFixtures = p.clubId
    ? await db
        .select()
        .from(schema.fixtures)
        .where(
          and(
            or(eq(schema.fixtures.homeClubId, p.clubId), eq(schema.fixtures.awayClubId, p.clubId)),
            or(eq(schema.fixtures.status, "live"), and(eq(schema.fixtures.status, "scheduled"), gte(schema.fixtures.kickoffAt, now))),
          ),
        )
        .orderBy(asc(schema.fixtures.kickoffAt))
        .limit(3)
    : [];

  const [holders] = await db
    .select({ shares: sql<number>`COALESCE(SUM(${schema.positions.quantity}), 0)::int`, managers: sql<number>`count(*) FILTER (WHERE ${schema.positions.quantity} > 0)::int` })
    .from(schema.positions)
    .where(eq(schema.positions.playerId, p.id));

  let viewer: { watched: boolean; quantity: number; costBasisCents: number; realizedCents: number } | null = null;
  if (viewerId) {
    const [w] = await db.select().from(schema.watchlist).where(and(eq(schema.watchlist.userId, viewerId), eq(schema.watchlist.playerId, p.id)));
    const [pos] = await db.select().from(schema.positions).where(and(eq(schema.positions.userId, viewerId), eq(schema.positions.playerId, p.id)));
    viewer = { watched: Boolean(w), quantity: pos?.quantity ?? 0, costBasisCents: pos?.costBasisCents ?? 0, realizedCents: pos?.realizedPnlCents ?? 0 };
  }

  return {
    player: {
      id: p.id,
      slug: p.slug,
      name: p.displayName,
      firstName: p.firstName,
      lastName: p.lastName,
      position: p.position,
      nationality: p.nationality,
      birthDate: p.birthDate,
      squadNumber: p.squadNumber,
      availability: p.availability,
      availabilityNote: p.availabilityNote,
      chanceOfPlaying: p.chanceOfPlaying,
      availabilityUpdatedAt: p.availabilityUpdatedAt,
      isTradable: p.isTradable,
      club: row.club ? { id: row.club.id, name: row.club.name, shortName: row.club.shortName } : null,
      competition: { code: row.competition.code, name: row.competition.name, season: row.competition.season },
      sourceUpdatedAt: p.sourceUpdatedAt,
    },
    price: {
      priceCents: row.price.priceCents,
      previousPriceCents: row.price.previousPriceCents,
      settledPriceCents: row.price.settledPriceCents,
      ipoPriceCents: row.price.ipoPriceCents,
      fundamentalCents: row.price.fundamentalCents,
      qualityIndex: row.price.qualityIndex,
      formIndex: row.price.formIndex,
      matchesPriced: row.price.matchesPriced,
      role: roleShare(row.price),
      liveFixtureId: row.price.liveFixtureId,
      marketVersion: row.price.marketVersion,
      updatedAt: row.price.updatedAt,
    },
    history,
    liveTicks,
    matches: matchRows,
    season,
    nextFixtures,
    holders: { shares: holders?.shares ?? 0, managers: holders?.managers ?? 0, heldValueCents: (holders?.shares ?? 0) * row.price.priceCents },
    viewer,
  };
}

export async function topMovers(limit = 6) {
  const cols = {
    id: schema.players.id,
    slug: schema.players.slug,
    name: schema.players.displayName,
    position: schema.players.position,
    club: schema.clubs.shortName,
    priceCents: schema.playerPrices.priceCents,
    previousPriceCents: schema.playerPrices.previousPriceCents,
    liveFixtureId: schema.playerPrices.liveFixtureId,
  };
  const q = () =>
    db
      .select(cols)
      .from(schema.playerPrices)
      .innerJoin(schema.players, eq(schema.players.id, schema.playerPrices.playerId))
      .leftJoin(schema.clubs, eq(schema.clubs.id, schema.players.clubId))
      .where(and(eq(schema.players.isTradable, true), sql`${schema.playerPrices.priceCents} <> ${schema.playerPrices.previousPriceCents}`));
  const [risers, fallers] = await Promise.all([q().orderBy(desc(changeExpr)).limit(limit), q().orderBy(asc(changeExpr)).limit(limit)]);
  return { risers: risers.filter((r) => r.priceCents > r.previousPriceCents), fallers: fallers.filter((r) => r.priceCents < r.previousPriceCents) };
}

export async function listFixtures(opts: { competition?: string; status?: "upcoming" | "live" | "results"; limit?: number }) {
  const conds: SQL[] = [];
  if (opts.competition) conds.push(eq(schema.competitions.code, opts.competition));
  const now = new Date();
  if (opts.status === "live") conds.push(eq(schema.fixtures.status, "live"));
  if (opts.status === "upcoming") conds.push(or(and(eq(schema.fixtures.status, "scheduled"), gte(schema.fixtures.kickoffAt, new Date(now.getTime() - 3 * 3600_000))), eq(schema.fixtures.status, "postponed"))!);
  if (opts.status === "results") conds.push(eq(schema.fixtures.status, "finished"));
  return db
    .select({
      id: schema.fixtures.id,
      competition: schema.competitions.code,
      competitionName: schema.competitions.name,
      tradable: schema.competitions.hasPlayerStats,
      round: schema.fixtures.round,
      kickoffAt: schema.fixtures.kickoffAt,
      homeName: schema.fixtures.homeName,
      awayName: schema.fixtures.awayName,
      homeClubId: schema.fixtures.homeClubId,
      awayClubId: schema.fixtures.awayClubId,
      homeScore: schema.fixtures.homeScore,
      awayScore: schema.fixtures.awayScore,
      status: schema.fixtures.status,
      minute: schema.fixtures.minute,
      statsFinal: schema.fixtures.statsFinal,
      settledAt: schema.fixtures.settledAt,
      lastStatsSyncAt: schema.fixtures.lastStatsSyncAt,
      provider: schema.fixtures.provider,
    })
    .from(schema.fixtures)
    .innerJoin(schema.competitions, eq(schema.competitions.id, schema.fixtures.competitionId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(opts.status === "results" ? desc(schema.fixtures.kickoffAt) : asc(schema.fixtures.kickoffAt))
    .limit(Math.min(200, opts.limit ?? 40));
}

/** Biggest settled movers for a fixture (fixture detail on the Fixtures screen). */
export async function fixtureMovers(fixtureId: number, limit = 8) {
  return db
    .select({
      slug: schema.players.slug,
      name: schema.players.displayName,
      position: schema.players.position,
      club: schema.clubs.shortName,
      priceCents: schema.priceTicks.priceCents,
      previousPriceCents: schema.priceTicks.previousPriceCents,
      performanceScore: schema.priceTicks.performanceScore,
      reason: schema.priceTicks.reason,
    })
    .from(schema.priceTicks)
    .innerJoin(schema.players, eq(schema.players.id, schema.priceTicks.playerId))
    .leftJoin(schema.clubs, eq(schema.clubs.id, schema.players.clubId))
    .where(and(eq(schema.priceTicks.fixtureId, fixtureId), eq(schema.priceTicks.reason, "match_final")))
    .orderBy(desc(sql`abs(${schema.priceTicks.priceCents} - ${schema.priceTicks.previousPriceCents})::float / ${schema.priceTicks.previousPriceCents}`))
    .limit(limit);
}

/** Anonymous market activity: most-traded players over the last 24 hours. */
export async function mostTraded(limit = 6) {
  const since = new Date(Date.now() - 24 * 3600_000);
  return db
    .select({
      slug: schema.players.slug,
      name: schema.players.displayName,
      position: schema.players.position,
      club: schema.clubs.shortName,
      trades: sql<number>`count(*)::int`,
      shares: sql<number>`sum(${schema.trades.quantity})::int`,
      buys: sql<number>`count(*) filter (where ${schema.trades.side} = 'buy')::int`,
      priceCents: schema.playerPrices.priceCents,
    })
    .from(schema.trades)
    .innerJoin(schema.players, eq(schema.players.id, schema.trades.playerId))
    .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
    .leftJoin(schema.clubs, eq(schema.clubs.id, schema.players.clubId))
    .where(gte(schema.trades.createdAt, since))
    .groupBy(schema.players.id, schema.clubs.shortName, schema.playerPrices.priceCents)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}

/** Everything the UI needs to show honest data status. */
export async function dataStatus() {
  const market = await getMarketState();
  const statuses = await db.select().from(schema.providerStatus);
  const [live] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.fixtures).where(eq(schema.fixtures.status, "live"));
  const [lastSettled] = await db
    .select({ at: sql<Date | null>`max(${schema.fixtures.settledAt})` })
    .from(schema.fixtures)
    .where(isNotNull(schema.fixtures.settledAt));
  const source = statuses.find((s) => s.provider === market.dataProvider);
  return {
    marketStatus: market.status,
    marketReason: market.statusReason,
    marketVersion: market.version,
    dataMode: market.dataMode as "live" | "snapshot" | "none",
    dataProvider: market.dataProvider,
    dataAsOf: market.dataAsOf,
    lastPriceUpdateAt: market.lastPriceUpdateAt,
    lastSuccessAt: source?.lastSuccessAt ?? null,
    lastErrorAt: source?.lastErrorAt ?? null,
    liveMatches: live?.n ?? 0,
    lastSettledAt: lastSettled?.at ?? null,
  };
}
