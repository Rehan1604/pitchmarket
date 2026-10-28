import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@/db";
import { applyLiveTicks, settleFixture } from "@/server/ingestion/pipeline";
import { enforceDataFreshness, acquireJob, releaseJob } from "@/server/ingestion/scheduler";
import { applyMatch, ipoState, replay } from "@/server/market/pricing";
import { scoreMatch, type Position } from "@/server/market/scoring";
import { getPlayerDetail, listMarket, marketFilterSchema } from "@/server/market/queries";
import { settledStateFromRow } from "@/server/market/state";

afterAll(() => closeDb());

describe("seeded market from real data", () => {
  it("lists real players with IPO prices and settled real fixtures", async () => {
    const [{ players }] = await db.select({ players: sql<number>`count(*)::int` }).from(schema.playerPrices);
    expect(players).toBeGreaterThan(100);
    const [{ settled }] = await db.select({ settled: sql<number>`count(*)::int` }).from(schema.fixtures).where(sql`${schema.fixtures.settledAt} IS NOT NULL AND ${schema.fixtures.provider} = 'fpl'`);
    expect(settled).toBe(11);
    const [{ ipos }] = await db.select({ ipos: sql<number>`count(*)::int` }).from(schema.priceTicks).where(eq(schema.priceTicks.reason, "ipo"));
    expect(ipos).toBe(players);
    const market = await listMarket(marketFilterSchema.parse({ sort: "price", pageSize: 10 }));
    expect(market.rows).toHaveLength(10);
    expect(market.rows[0].priceCents).toBeGreaterThanOrEqual(market.rows[9].priceCents);
    expect(market.rows.every((r) => r.club)).toBe(true);
  });

  it("filters and paginates the market", async () => {
    const gks = await listMarket(marketFilterSchema.parse({ position: "GK", pageSize: 100 }));
    expect(gks.rows.length).toBeGreaterThan(0);
    expect(gks.rows.every((r) => r.position === "GK")).toBe(true);
    const page1 = await listMarket(marketFilterSchema.parse({ pageSize: 10, page: 1, sort: "name", dir: "asc" }));
    const page2 = await listMarket(marketFilterSchema.parse({ pageSize: 10, page: 2, sort: "name", dir: "asc" }));
    expect(page1.rows.map((r) => r.id)).not.toEqual(page2.rows.map((r) => r.id));
    expect(page1.total).toBe(page2.total);
  });

  it("replays every player's settled price path exactly from recorded stats", async () => {
    const prices = await db
      .select({ price: schema.playerPrices, position: schema.players.position })
      .from(schema.playerPrices)
      .innerJoin(schema.players, eq(schema.players.id, schema.playerPrices.playerId));
    let checked = 0;
    for (const { price, position } of prices) {
      const ticks = await db.select().from(schema.priceTicks).where(eq(schema.priceTicks.playerId, price.playerId)).orderBy(asc(schema.priceTicks.id));
      const ipo = ticks.find((t) => t.reason === "ipo")!;
      const stats = await db
        .select({ s: schema.playerMatchStats, f: schema.fixtures })
        .from(schema.playerMatchStats)
        .innerJoin(schema.fixtures, eq(schema.fixtures.id, schema.playerMatchStats.fixtureId))
        .where(and(eq(schema.playerMatchStats.playerId, price.playerId), sql`${schema.fixtures.settledAt} IS NOT NULL`, sql`${schema.playerMatchStats.pricingNote} IS NULL`))
        .orderBy(asc(schema.fixtures.kickoffAt), asc(schema.fixtures.id));
      // Rebuild the IPO state from stored priors and replay.
      const start = { ...ipoState(position as Position, null), priceCents: ipo.priceCents, priorQuality: price.priorQuality, priorWeight: price.priorWeight, priorRole: price.priorRole, priorRoleWeight: price.priorRoleWeight };
      const { final, path } = replay(start, stats.map(({ s }) => ({ z: scoreMatch(s, position as Position).z, minutes: s.minutes })));
      expect(final.priceCents).toBe(price.settledPriceCents);
      const finals = ticks.filter((t) => t.reason === "match_final").map((t) => t.priceCents);
      const played = path.slice(1).filter((_, i) => stats[i].s.minutes > 0);
      expect(finals).toEqual(played);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("settles each fixture exactly once", async () => {
    const [fx] = await db.select().from(schema.fixtures).where(sql`${schema.fixtures.settledAt} IS NOT NULL`).limit(1);
    expect(await settleFixture(fx.id)).toBeNull();
  });

  it("exposes match-by-match stats, history and holders on the player page", async () => {
    const [row] = await db
      .select({ slug: schema.players.slug })
      .from(schema.players)
      .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
      .where(sql`${schema.playerPrices.matchesPriced} >= 2`)
      .limit(1);
    const d = await getPlayerDetail(row.slug);
    expect(d.history[0].reason).toBe("ipo");
    expect(d.history.length).toBeGreaterThanOrEqual(3);
    expect(d.matches.length).toBeGreaterThanOrEqual(2);
    expect(d.matches[0].source).toBe("fpl-archive");
    expect(d.matches.find((m) => m.minutes > 0)!.performanceScore).not.toBeNull();
  });
});

describe("live price processing", () => {
  it("applies provisional live prices without compounding, then settles from the settled base", async () => {
    // Take an unsettled future fixture and fabricate an in-play state in the TEST database only.
    const [fx] = await db.select().from(schema.fixtures).where(eq(schema.fixtures.status, "scheduled")).orderBy(asc(schema.fixtures.kickoffAt)).limit(1);
    const [pl] = await db
      .select({ p: schema.players, price: schema.playerPrices })
      .from(schema.players)
      .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
      .where(sql`${schema.players.clubId} IN (${fx.homeClubId}, ${fx.awayClubId}) AND ${schema.players.position} = 'FWD'`)
      .limit(1);
    const settledBefore = pl.price.settledPriceCents;
    await db.update(schema.fixtures).set({ status: "live", lastStatsSyncAt: new Date() }).where(eq(schema.fixtures.id, fx.id));
    const stats = { playerId: pl.p.id, fixtureId: fx.id, minutes: 60, goals: 1, assists: 0, xg: 0.6, xa: 0.1, cleanSheet: false, goalsConceded: 0, saves: 0, yellowCards: 0, redCards: 0, ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, tackles: 1, cbi: 1, recoveries: 2, statsHash: "live-1", source: "test", isFinal: false };
    await db.insert(schema.playerMatchStats).values(stats);

    const first = await applyLiveTicks(fx.id);
    expect(first.changed).toBeGreaterThanOrEqual(1);
    const [afterFirst] = await db.select().from(schema.playerPrices).where(eq(schema.playerPrices.playerId, pl.p.id));
    expect(afterFirst.priceCents).toBeGreaterThan(settledBefore);
    expect(afterFirst.settledPriceCents).toBe(settledBefore);
    expect(afterFirst.liveFixtureId).toBe(fx.id);

    const second = await applyLiveTicks(fx.id);
    expect(second.changed).toBe(0); // same stats → no compounding, no new tick
    const [afterSecond] = await db.select().from(schema.playerPrices).where(eq(schema.playerPrices.playerId, pl.p.id));
    expect(afterSecond.priceCents).toBe(afterFirst.priceCents);

    // Full time: settle using final stats from the settled base.
    await db.update(schema.playerMatchStats).set({ minutes: 90, statsHash: "final" }).where(and(eq(schema.playerMatchStats.playerId, pl.p.id), eq(schema.playerMatchStats.fixtureId, fx.id)));
    await db.update(schema.fixtures).set({ status: "finished", statsFinal: true, homeScore: 1, awayScore: 0 }).where(eq(schema.fixtures.id, fx.id));
    const res = await settleFixture(fx.id);
    expect(res).not.toBeNull();
    const [final] = await db.select().from(schema.playerPrices).where(eq(schema.playerPrices.playerId, pl.p.id));
    const expected = applyMatch(settledStateFromRow(pl.price, "FWD"), scoreMatch({ ...stats, minutes: 90 }, "FWD").z, 90).state.priceCents;
    expect(final.settledPriceCents).toBe(expected);
    expect(final.priceCents).toBe(expected);
    expect(final.liveFixtureId).toBeNull();
    expect(final.previousPriceCents).toBe(settledBefore);
    expect(await settleFixture(fx.id)).toBeNull();
  });
});

describe("operations", () => {
  it("auto-halts trading when live data goes stale and reopens when fresh", async () => {
    await db.update(schema.marketState).set({ dataMode: "live", status: "open", statusSetBy: null }).where(eq(schema.marketState.id, 1));
    const [fx] = await db.select().from(schema.fixtures).where(eq(schema.fixtures.status, "scheduled")).limit(1);
    // A match that kicked off 70 minutes ago and has had no data for an hour.
    await db.update(schema.fixtures).set({ status: "live", kickoffAt: new Date(Date.now() - 70 * 60_000), lastStatsSyncAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.fixtures.id, fx.id));
    try {
      expect(await enforceDataFreshness()).toMatchObject({ changed: true, status: "halted" });
      const [m] = await db.select().from(schema.marketState);
      expect(m).toMatchObject({ status: "halted", statusSetBy: "system" });
      await db.update(schema.fixtures).set({ lastStatsSyncAt: new Date() }).where(eq(schema.fixtures.id, fx.id));
      expect(await enforceDataFreshness()).toMatchObject({ changed: true, status: "open" });
    } finally {
      await db.update(schema.fixtures).set({ status: "scheduled", kickoffAt: fx.kickoffAt }).where(eq(schema.fixtures.id, fx.id));
      await db.update(schema.marketState).set({ dataMode: "snapshot", status: "open" }).where(eq(schema.marketState.id, 1));
    }
  });

  it("ignores a fixture stuck as live long after kickoff (feed glitch), so it can't freeze the market", async () => {
    await db.update(schema.marketState).set({ dataMode: "live", status: "open", statusSetBy: null }).where(eq(schema.marketState.id, 1));
    const [fx] = await db.select().from(schema.fixtures).where(eq(schema.fixtures.status, "scheduled")).limit(1);
    await db.update(schema.fixtures).set({ status: "live", kickoffAt: new Date(Date.now() - 6 * 3600_000), lastStatsSyncAt: new Date(Date.now() - 5 * 3600_000) }).where(eq(schema.fixtures.id, fx.id));
    try {
      expect(await enforceDataFreshness()).toMatchObject({ changed: false });
    } finally {
      await db.update(schema.fixtures).set({ status: "scheduled", kickoffAt: fx.kickoffAt }).where(eq(schema.fixtures.id, fx.id));
      await db.update(schema.marketState).set({ dataMode: "snapshot", status: "open" }).where(eq(schema.marketState.id, 1));
    }
  });

  it("never overrides a manual admin halt", async () => {
    await db.update(schema.marketState).set({ dataMode: "live", status: "halted", statusSetBy: "admin" }).where(eq(schema.marketState.id, 1));
    expect(await enforceDataFreshness()).toMatchObject({ changed: false });
    await db.update(schema.marketState).set({ dataMode: "snapshot", status: "open", statusSetBy: null }).where(eq(schema.marketState.id, 1));
  });

  it("runs a scheduled job at most once per interval across concurrent ticks", async () => {
    const job = `test-job-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => acquireJob(job, 60)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await releaseJob(job, "success");
    expect(await acquireJob(job, 60)).toBe(false); // min interval not elapsed
  });
});
