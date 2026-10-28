/**
 * ESPN leagues + Champions League through the real pipeline and database, with
 * the HTTP layer replaced by recorded (trimmed) ESPN responses. Covers: listing
 * a league squad, settling a match, squad zero-rows, cross-feed links for a
 * Premier League club in the Champions League, chronological pricing, and that
 * the secondary feed never overwrites the primary data status.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@/db";
import { syncEspnReference } from "@/server/ingestion/espn-sync";
import { syncFixtures, syncReference, syncStats } from "@/server/ingestion/pipeline";
import { EspnProvider } from "@/server/ingestion/providers/espn";
import { getMarketState } from "@/server/market/state";
import { sameClubIds } from "@/server/market/clubs";

const dir = path.join(process.cwd(), "tests/fixtures/espn");
const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const after = new Date("2026-10-26T02:00:00Z");

type Json = Record<string, unknown>;
const routes = new Map<string, Json>();
const summaries = new Map<string, Json>();
const fakeFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  const p = url.pathname.replace("/apis/site/v2/sports/soccer/", "");
  if (p === "all/summary") {
    const s = summaries.get(url.searchParams.get("event") ?? "");
    return s ? new Response(JSON.stringify(s)) : new Response("nope", { status: 404 });
  }
  const body = routes.get(p);
  return body ? new Response(JSON.stringify(body)) : new Response("nope", { status: 404 });
};
const make = (slug: string) => new EspnProvider(slug, BASE, { fetchImpl: fakeFetch, retries: 0 }, () => after);

let fplClubId: number;
let fplPlayers: { id: number; firstName: string; lastName: string; displayName: string; birthDate: string | null; position: string }[];

beforeAll(async () => {
  // ---- La Liga (real, trimmed)
  routes.set("esp.1/scoreboard", load("scoreboard-esp1.json"));
  routes.set("esp.1/teams", load("teams-esp1.json"));
  const rosters = load("rosters-esp1.json") as Record<string, Json>;
  for (const [id, r] of Object.entries(rosters)) routes.set(`esp.1/teams/${id}/roster`, r);
  summaries.set("401882832", load("summary-401882832.json"));

  // ---- Champions League: Real Madrid (covered by La Liga), a Premier League club
  // from the test market (rebuilt as ESPN would list it), and a club only in the cup.
  const [club] = await db
    .select({ id: schema.clubs.id, name: schema.clubs.name, n: sql<number>`count(${schema.players.id})::int` })
    .from(schema.clubs)
    .innerJoin(schema.players, eq(schema.players.clubId, schema.clubs.id))
    .where(and(eq(schema.clubs.provider, "fpl"), isNotNull(schema.players.birthDate)))
    .groupBy(schema.clubs.id)
    .orderBy(sql`count(${schema.players.id}) desc`)
    .limit(1);
  fplClubId = club.id;
  fplPlayers = await db
    .select({ id: schema.players.id, firstName: schema.players.firstName, lastName: schema.players.lastName, displayName: schema.players.displayName, birthDate: schema.players.birthDate, position: schema.players.position })
    .from(schema.players)
    .where(and(eq(schema.players.clubId, fplClubId), isNotNull(schema.players.birthDate)))
    .orderBy(asc(schema.players.id));
  const posAbbr: Record<string, string> = { GK: "G", DEF: "D", MID: "M", FWD: "F" };
  const plRoster = fplPlayers.map((p) => ({ id: `e${p.id}`, firstName: p.firstName, lastName: p.lastName, displayName: `${p.firstName} ${p.lastName}`, position: { abbreviation: posAbbr[p.position] }, dateOfBirth: `${p.birthDate}T08:00Z`, status: { type: "active" } }));
  const cupOnly = [
    { id: "c1", firstName: "Cup", lastName: "Keeper", displayName: "Cup Keeper", position: { abbreviation: "G" }, dateOfBirth: "1995-01-01T08:00Z", status: { type: "active" } },
    { id: "c2", firstName: "Cup", lastName: "Striker", displayName: "Cup Striker", position: { abbreviation: "F" }, dateOfBirth: "1996-02-02T08:00Z", status: { type: "active" } },
  ];
  routes.set("uefa.champions/teams", { sports: [{ leagues: [{ teams: [{ team: { id: "86", displayName: "Real Madrid" } }, { team: { id: "7001", displayName: club.name + " (ESPN)" } }, { team: { id: "7002", displayName: "Cup Only FC" } }] }] }] });
  routes.set("uefa.champions/teams/7001/roster", { athletes: plRoster });
  routes.set("uefa.champions/teams/7002/roster", { athletes: cupOnly });
  const ev = (id: string, date: string) => ({
    id,
    date,
    status: { displayClock: "90'+3'", type: { name: "STATUS_FULL_TIME", state: "post", completed: true } },
    competitions: [{ competitors: [{ id: "7001", homeAway: "home", score: "2", team: { id: "7001", displayName: club.name } }, { id: "7002", homeAway: "away", score: "0", team: { id: "7002", displayName: "Cup Only FC" } }] }],
  });
  // An old tie (before the club's priced league matches) and a recent one that sits
  // between the club's last settled league match and the next scheduled one.
  const [w] = await db
    .select({
      lastSettled: sql<string>`max(${schema.fixtures.kickoffAt}) filter (where ${schema.fixtures.settledAt} is not null and (${schema.fixtures.homeClubId} = ${fplClubId} or ${schema.fixtures.awayClubId} = ${fplClubId}))`,
      firstScheduled: sql<string>`min(${schema.fixtures.kickoffAt}) filter (where ${schema.fixtures.status} = 'scheduled')`,
    })
    .from(schema.fixtures)
    .where(eq(schema.fixtures.provider, "fpl"));
  const lo = new Date(w.lastSettled).getTime();
  const hi = new Date(w.firstScheduled).getTime();
  const recent = new Date(Math.floor((lo + Math.max(hi, lo + 2 * 3600_000)) / 2));
  const month = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  routes.set("uefa.champions/scoreboard", { leagues: [{ slug: "uefa.champions", season: { year: 2026 }, calendar: ["2026-07-01T07:00Z", recent.toISOString()] }], events: [] });
  routes.set("uefa.champions/scoreboard?dates=202607", { events: [ev("cl-old", "2026-07-01T19:00Z")] });
  routes.set(`uefa.champions/scoreboard?dates=${month(recent)}`, { events: [ev("cl-new", recent.toISOString())] });
  const star = plRoster.find((p) => p.position.abbreviation === "F") ?? plRoster[0];
  const sheet = (id: string) => ({
    header: { id, competitions: [{ status: { type: { name: "STATUS_FULL_TIME", state: "post", completed: true } } }] },
    rosters: [
      { team: { id: "7001" }, roster: [{ starter: true, athlete: { id: star.id }, position: { abbreviation: "F" }, stats: [{ name: "totalGoals", value: 2 }, { name: "goalAssists", value: 0 }, { name: "totalShots", value: 4 }, { name: "shotsOnTarget", value: 3 }, { name: "goalsConceded", value: 0 }, { name: "yellowCards", value: 0 }, { name: "redCards", value: 0 }, { name: "ownGoals", value: 0 }], plays: [] }] },
      { team: { id: "7002" }, roster: [{ starter: true, athlete: { id: "c1" }, position: { abbreviation: "G" }, stats: [{ name: "goalsConceded", value: 2 }, { name: "saves", value: 6 }, { name: "yellowCards", value: 0 }, { name: "redCards", value: 0 }, { name: "ownGoals", value: 0 }, { name: "totalGoals", value: 0 }, { name: "goalAssists", value: 0 }], plays: [] }] },
    ],
  });
  summaries.set("cl-old", sheet("cl-old"));
  summaries.set("cl-new", sheet("cl-new"));
  (globalThis as { __star?: string }).__star = star.id;
});

afterAll(() => closeDb());

// The fake router keys months as part of the path for the cup scoreboard.
const monthAware: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const dates = url.searchParams.get("dates");
  if (url.pathname.endsWith("uefa.champions/scoreboard") && dates) {
    const body = routes.get(`uefa.champions/scoreboard?dates=${dates}`) ?? { events: [] };
    return new Response(JSON.stringify(body));
  }
  return fakeFetch(input, init);
};

describe("ESPN league market", () => {
  it("lists a La Liga squad, settles the Clásico and leaves the primary data status alone", async () => {
    const before = await getMarketState();
    const laLiga = make("esp.1");
    await syncFixtures(laLiga, { window: "full" });
    const ref = await syncReference(laLiga);
    expect(ref.details).toMatchObject({ inserted: 13 });
    const stats = await syncStats(laLiga, after, { maxFixtures: 40 });
    expect(stats.details).toMatchObject({ settled: 1 });

    const [mbappe] = await db.select({ p: schema.players, price: schema.playerPrices, comp: schema.competitions.code }).from(schema.players).innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id)).innerJoin(schema.competitions, eq(schema.competitions.id, schema.players.competitionId)).where(and(eq(schema.players.provider, "espn"), eq(schema.players.providerRef, "231388")));
    expect(mbappe.comp).toBe("PD");
    expect(mbappe.price.settledPriceCents).toBeGreaterThan(mbappe.price.ipoPriceCents);
    expect(mbappe.price.matchesPriced).toBe(1);

    // A squad player ESPN didn't list for the match still gets a 0-minute row (role model).
    const [reserve] = await db.select({ id: schema.players.id }).from(schema.players).where(and(eq(schema.players.provider, "espn"), eq(schema.players.providerRef, "900001")));
    const rows = await db.select().from(schema.playerMatchStats).where(eq(schema.playerMatchStats.playerId, reserve.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].minutes).toBe(0);

    const afterState = await getMarketState();
    expect(afterState.dataProvider).toBe(before.dataProvider);
    expect(afterState.dataMode).toBe(before.dataMode);
  });
});

describe("Champions League", () => {
  it("links a Premier League club's squad, lists cup-only clubs and prices matches in order", async () => {
    const cup = new EspnProvider("uefa.champions", BASE, { fetchImpl: monthAware, retries: 0 }, () => after);
    await syncFixtures(cup, { window: "full" });
    await syncEspnReference([make("esp.1"), cup], "test");

    const [clubLink] = await db.select().from(schema.entityLinks).where(and(eq(schema.entityLinks.kind, "club"), eq(schema.entityLinks.providerRef, "7001")));
    expect(clubLink.localId).toBe(fplClubId);
    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.kind, "player"));
    expect(links.length).toBeGreaterThanOrEqual(Math.floor(fplPlayers.length * 0.9));
    // Real Madrid is already listed via La Liga: no duplicate players.
    const [{ n: madrid }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.players).where(and(eq(schema.players.provider, "espn"), eq(schema.players.providerRef, "231388")));
    expect(madrid).toBe(1);
    const cupOnly = await db.select({ ref: schema.players.providerRef, comp: schema.competitions.code }).from(schema.players).innerJoin(schema.competitions, eq(schema.competitions.id, schema.players.competitionId)).where(eq(schema.competitions.code, "CL"));
    expect(cupOnly.map((p) => p.ref).sort()).toEqual(["c1", "c2"]);

    const res = await syncStats(cup, after, { maxFixtures: 40 });
    expect(res.details).toMatchObject({ settled: 2 });

    const starRef = (globalThis as { __star?: string }).__star!;
    const starId = Number(links.find((l) => l.providerRef === starRef)!.localId);
    const ticks = await db
      .select({ ref: schema.fixtures.providerRef })
      .from(schema.priceTicks)
      .innerJoin(schema.fixtures, eq(schema.fixtures.id, schema.priceTicks.fixtureId))
      .where(and(eq(schema.priceTicks.playerId, starId), eq(schema.priceTicks.reason, "match_final"), eq(schema.fixtures.provider, "espn")));
    // The recent tie moves the FPL-listed player's price; the old one (before his
    // already-priced league matches) is recorded but deliberately not priced.
    expect(ticks.map((t) => t.ref)).toEqual(["cl-new"]);
    const [old] = await db
      .select({ note: schema.playerMatchStats.pricingNote })
      .from(schema.playerMatchStats)
      .innerJoin(schema.fixtures, eq(schema.fixtures.id, schema.playerMatchStats.fixtureId))
      .where(and(eq(schema.playerMatchStats.playerId, starId), eq(schema.fixtures.providerRef, "cl-old")));
    expect(old.note).toBe("out_of_order");

    // Cup-only keeper is priced for both ties.
    const [keeper] = await db.select({ id: schema.players.id, n: schema.playerPrices.matchesPriced }).from(schema.players).innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id)).where(eq(schema.players.providerRef, "c1"));
    expect(keeper.n).toBe(2);

    // One real club across feeds: the FPL club and its ESPN cup row are "the same club".
    const same = await db.execute<{ id: number }>(sql`SELECT id FROM ${sameClubIds(fplClubId)} s(id)`);
    const [cupClub] = await db.select({ id: schema.clubs.id }).from(schema.clubs).where(and(eq(schema.clubs.provider, "espn"), eq(schema.clubs.providerRef, "7001")));
    expect(same.rows.map((r) => Number(r.id))).toContain(cupClub.id);
  });
});
