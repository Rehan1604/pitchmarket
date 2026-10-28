import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { linkSquad, matchClubBySquad, normName, type PersonLike } from "@/server/ingestion/linking";
import {
  EspnProvider,
  espnMatchRows,
  espnSeasonLabel,
  mapEspnPosition,
  mapEspnStatus,
  normaliseEspnAthlete,
  normaliseEspnEvent,
  parseClockMinute,
  recentMonths,
  seasonMonths,
  type EspnEvent,
  type EspnScoreboard,
  type EspnSummary,
} from "@/server/ingestion/providers/espn";
import { isLimitedProfile, scoreMatch } from "@/server/market/scoring";

const dir = path.join(process.cwd(), "tests/fixtures/espn");
const load = <T,>(f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as T;
const summary = load<EspnSummary>("summary-401882832.json");
const scoreboard = load<EspnScoreboard>("scoreboard-esp1.json");
const after = new Date("2026-10-26T02:00:00Z");

describe("ESPN normalisation", () => {
  it("maps statuses, clocks, positions and seasons", () => {
    expect(mapEspnStatus({ type: { name: "STATUS_FULL_TIME", state: "post", completed: true } })).toBe("finished");
    expect(mapEspnStatus({ type: { name: "STATUS_SECOND_HALF", state: "in" } })).toBe("live");
    expect(mapEspnStatus({ type: { name: "STATUS_HALFTIME", state: "in" } })).toBe("live");
    expect(mapEspnStatus({ type: { name: "STATUS_SCHEDULED", state: "pre" } })).toBe("scheduled");
    expect(mapEspnStatus({ type: { name: "STATUS_POSTPONED", state: "post" } })).toBe("postponed");
    expect(mapEspnStatus({ type: { name: "STATUS_CANCELED", state: "post" } })).toBe("cancelled");
    expect(parseClockMinute("62'")).toBe(62);
    expect(parseClockMinute("90'+4'")).toBe(90);
    expect(parseClockMinute("")).toBeNull();
    expect(["G", "D", "M", "F", "RB", "AM-L", "LF", "CD-R", "DM", "SUB"].map(mapEspnPosition)).toEqual(["GK", "DEF", "MID", "FWD", "DEF", "MID", "FWD", "DEF", "MID", null]);
    expect(espnSeasonLabel(2026)).toBe("2026-27");
    expect(espnSeasonLabel(2099)).toBe("2099-00");
  });

  it("normalises fixtures, holding settlement until stats have had time to settle", () => {
    const [clasico, upcoming] = scoreboard.events as EspnEvent[];
    const soon = normaliseEspnEvent(clasico, new Date("2026-10-25T22:00:00Z")).fixture;
    expect(soon).toMatchObject({ providerRef: "401882832", homeRef: "83", awayRef: "86", homeName: "Barcelona", awayName: "Real Madrid", homeScore: 1, awayScore: 2, status: "finished", statsFinal: false });
    expect(normaliseEspnEvent(clasico, after).fixture.statsFinal).toBe(true);
    const next = normaliseEspnEvent(upcoming, after);
    expect(next.fixture).toMatchObject({ status: "scheduled", homeScore: null, awayScore: null, statsFinal: false });
    expect(next.clubs.map((c) => c.providerRef).sort()).toEqual(["83", "86"]);
  });

  it("finds the months to fetch from the calendar, or around today", () => {
    expect(seasonMonths(scoreboard)).toEqual(["202608", "202610"]);
    expect(seasonMonths({ leagues: [{ season: { startDate: "2026-08-01T00:00Z", endDate: "2026-10-15T00:00Z" } }] })).toEqual(["202608", "202609", "202610"]);
    expect(recentMonths(new Date("2026-10-30T12:00:00Z"))).toEqual(["202610", "202611"]);
  });

  it("normalises squad players, including mononyms, without inventing availability", () => {
    const pedri = normaliseEspnAthlete({ id: "250465", firstName: "Pedri", displayName: "Pedri", position: { abbreviation: "M" }, dateOfBirth: "2002-11-25T08:00Z", citizenship: "Spain", jersey: "8" }, "83");
    expect(pedri).toMatchObject({ providerRef: "250465", firstName: "", lastName: "Pedri", displayName: "Pedri", position: "MID", birthDate: "2002-11-25", squadNumber: 8, availability: "unknown", clubRef: "83", active: true });
    expect(normaliseEspnAthlete({ id: "1", displayName: "Coach", position: { abbreviation: "" } }, "83")).toBeNull();
  });
});

describe("ESPN match sheets", () => {
  const fixture = normaliseEspnEvent((scoreboard.events as EspnEvent[])[0], after).fixture;
  const rows = espnMatchRows(summary, fixture, after);
  const by = (id: string) => rows.find((r) => r.playerSeasonRef === id)!.stats;

  it("derives minutes from starts, substitutions and full time", () => {
    expect(by("297362").minutes).toBe(90); // GK, full match
    expect(by("231050").minutes).toBe(86); // Raphinha off at 86'
    expect(by("403582").minutes).toBe(30); // off at 30'
    expect(by("285150").minutes).toBe(10); // Camavinga on at 80'
    expect(by("402479").minutes).toBe(90); // off at 90'+4' → 90
    expect(by("131634").minutes).toBe(0); // unused substitute
  });

  it("maps goals, assists, shots, saves, cards and on-pitch goals conceded", () => {
    expect(by("231388")).toMatchObject({ goals: 2, assists: 0, shots: 3, shotsOnTarget: 2, yellowCards: 1, started: true, cleanSheet: false });
    expect(by("285150")).toMatchObject({ assists: 1, started: false, goalsConceded: 0, cleanSheet: false }); // < 60 minutes
    expect(by("297362")).toMatchObject({ saves: 3, goalsConceded: 2, cleanSheet: false });
    expect(by("231050")).toMatchObject({ goals: 1, saves: null, xg: null, tackles: null });
    expect(by("131634")).toMatchObject({ goals: null, cleanSheet: null });
    expect(rows.find((r) => r.playerSeasonRef === "231388")).toMatchObject({ clubRef: "86", fixtureRef: "401882832", isFinal: true });
  });

  it("uses live clocks during play", () => {
    const live = { ...fixture, status: "live" as const, statsFinal: false, minute: 55 };
    const liveSummary: EspnSummary = { ...summary, header: { competitions: [{ status: { displayClock: "55'", type: { name: "STATUS_SECOND_HALF", state: "in" } } }] } };
    const lrows = espnMatchRows(liveSummary, live, after);
    expect(lrows.find((r) => r.playerSeasonRef === "297362")!.stats.minutes).toBe(55);
    expect(lrows.find((r) => r.playerSeasonRef === "403582")!.stats.minutes).toBe(30);
    expect(lrows.find((r) => r.playerSeasonRef === "285150")!.stats.minutes).toBe(0); // not on yet
    expect(lrows.every((r) => r.isFinal === false)).toBe(true);
  });

  it("scores ESPN rows on the basic stat profile, so a brace moves a price like it should", () => {
    const mbappe = by("231388");
    expect(isLimitedProfile(mbappe)).toBe(true);
    const z = scoreMatch(mbappe, "FWD").z;
    expect(z).toBeGreaterThan(1.8);
    expect(scoreMatch(by("403582"), "DEF").z).toBeLessThan(0.5); // 30 quiet minutes
  });
});

describe("ESPN provider", () => {
  const files: Record<string, string> = {
    "esp.1/scoreboard": "scoreboard-esp1.json",
    "esp.1/teams": "teams-esp1.json",
    "all/summary": "summary-401882832.json",
  };
  const rosters = load<Record<string, { athletes: unknown[] }>>("rosters-esp1.json");
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/apis/site/v2/sports/soccer/", "");
    const roster = /esp\.1\/teams\/(\d+)\/roster/.exec(p);
    if (p === "all/summary" && url.searchParams.get("event") !== "401882832") return new Response("not found", { status: 404 });
    const body = roster ? rosters[roster[1]] : files[p] ? load(files[p]) : null;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("not found", { status: 404 });
  };
  const provider = new EspnProvider("esp.1", "https://site.api.espn.com/apis/site/v2/sports/soccer", { fetchImpl: fakeFetch, retries: 0 }, () => after);

  it("builds fixtures, squads and match stats from the feed", async () => {
    const fx = await provider.fetchFixtures();
    expect(fx.competition).toMatchObject({ code: "PD", name: "La Liga", season: "2026-27", country: "Spain" });
    expect(fx.fixtures.map((f) => f.providerRef).sort()).toEqual(["401882832", "401882840"]);
    const ref = await provider.fetchReference();
    expect(ref.clubs).toHaveLength(2);
    expect(ref.players.find((p) => p.providerRef === "231388")).toMatchObject({ position: "FWD", clubRef: "86", lastName: "Mbappé" });
    const stats = await provider.fetchMatchStats(fx.fixtures.filter((f) => f.status === "finished"));
    expect(stats).toHaveLength(12);
  });

  it("does not let one missing match sheet hide the others, but fails when all are missing", async () => {
    const fx = await provider.fetchFixtures();
    const ghost = { ...fx.fixtures[0], providerRef: "999" };
    const stats = await provider.fetchMatchStats([ghost, fx.fixtures.find((f) => f.providerRef === "401882832")!]);
    expect(stats.length).toBe(12);
    await expect(provider.fetchMatchStats([ghost])).rejects.toThrow();
  });
});

describe("linking ESPN Champions League squads to FPL players", () => {
  const data = load<{ espn: Record<string, string[][]>; fpl: Record<string, (string | null)[][]> }>("pl-link.json");
  const people = (rows: (string | null)[][]): PersonLike[] => rows.map(([ref, first, last, display, dob]) => ({ ref: ref!, firstName: first ?? "", lastName: last ?? "", displayName: display ?? "", birthDate: dob || null }));
  const fplByClub = new Map(Object.entries(data.fpl).map(([club, rows]) => [club, people(rows)]));

  it("normalises names across alphabets and accents", () => {
    expect(normName("Joško Gvardiol")).toBe("josko gvardiol");
    expect(normName("Martin Ødegaard")).toBe("martin odegaard");
    expect(normName("Altay Bayındır")).toBe("altay bayindir");
  });

  it("recognises the club from squad birthdays, not its name", () => {
    expect(matchClubBySquad(people(data.espn["Man City"]), fplByClub)).toBe("Man City");
    expect(matchClubBySquad(people(data.espn["Man Utd"]), fplByClub)).toBe("Man Utd");
    const strangers = people([["1", "A", "B", "A B", "1990-01-01"], ["2", "C", "D", "C D", "1991-01-01"]]);
    expect(matchClubBySquad(strangers, fplByClub)).toBeNull();
  });

  it("links nearly every player, including twins and name variants, and never guesses", () => {
    const city = linkSquad(people(data.espn["Man City"]), fplByClub.get("Man City")!);
    expect(city.get("253989")?.localRef).toBe("223094"); // Haaland
    expect(city.get("234878")?.localRef).toBe("171314"); // Rúben Dias ↔ "dos Santos Gato Alves Dias"
    expect(city.get("299910")?.localRef).toBe("477424"); // Josko ↔ Joško
    expect(city.get("361434")?.localRef).toBe("616222"); // "Vitor Reis" mononym
    expect(city.get("382966")?.localRef).toBe("624777"); // Allan Elias ↔ Allan Andrade Elias
    expect(city.has("413855")).toBe(false); // not in FPL squad
    expect(city.has("3129530")).toBe(false); // no birthday, no FPL match
    const utd = linkSquad(people(data.espn["Man Utd"]), fplByClub.get("Man Utd")!);
    expect(utd.get("205081")?.localRef).toBe("547037"); // Jack Fletcher
    expect(utd.get("393138")?.localRef).toBe("519913"); // Tyler Fletcher (same birthday)
    const linked = [...city.values(), ...utd.values()].map((v) => v.localRef);
    expect(new Set(linked).size).toBe(linked.length); // one-to-one
    expect(city.size + utd.size).toBeGreaterThanOrEqual(50);
  });
});
