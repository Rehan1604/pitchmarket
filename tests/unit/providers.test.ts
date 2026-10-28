import { describe, expect, it, vi } from "vitest";
import { fetchJson, ProviderError } from "@/server/ingestion/http";
import { mapFdStatus, normaliseFdMatches, seasonLabel } from "@/server/ingestion/providers/football-data";
import { normaliseFplFixture, normaliseFplPlayer, splitLiveElements } from "@/server/ingestion/providers/fpl";
import { fplToMatchStats } from "@/server/ingestion/providers/fpl-mapping";
import type { NormFixture } from "@/server/ingestion/providers/types";

describe("FPL normalisation", () => {
  it("maps players with availability and keeps the stable code as identity", () => {
    const p = normaliseFplPlayer({ id: 351, code: 223094, first_name: "Erling", second_name: "Haaland", web_name: "Haaland", team: 13, element_type: 4, status: "d", news: "Knock - 75% chance", chance_of_playing_next_round: 75, news_added: "2026-10-01T10:00:00Z", removed: "False" });
    expect(p).toMatchObject({ providerRef: "223094", seasonRef: "351", position: "FWD", availability: "doubtful", chanceOfPlaying: 75, active: true, nationality: null });
  });

  it("maps fixture states, including postponed and provisional finishes", () => {
    const name = (r: string) => `Club ${r}`;
    expect(normaliseFplFixture({ id: 1, event: 1, kickoff_time: "2026-08-21T19:00:00Z", team_h: 1, team_a: 2, started: true, finished: false, finished_provisional: false, minutes: 63, team_h_score: 1, team_a_score: 0 }, name)).toMatchObject({ status: "live", minute: 63, homeScore: 1, statsFinal: false });
    expect(normaliseFplFixture({ id: 2, event: 1, kickoff_time: "2026-08-21T19:00:00Z", team_h: 1, team_a: 2, started: true, finished: false, finished_provisional: true, minutes: 90, team_h_score: 2, team_a_score: 2 }, name)).toMatchObject({ status: "finished", statsFinal: false });
    expect(normaliseFplFixture({ id: 3, event: null, kickoff_time: null, team_h: 1, team_a: 2, started: false, finished: false }, name)).toMatchObject({ status: "postponed", homeScore: null });
    expect(normaliseFplFixture({ id: 4, event: 2, kickoff_time: "2026-08-28T19:00:00Z", team_h: 1, team_a: 2, started: "True", finished: "True", finished_provisional: "True", team_h_score: "3.0", team_a_score: "0.0" }, name)).toMatchObject({ status: "finished", statsFinal: true, homeScore: 3 });
  });

  it("maps stats and marks unpublished stats as unavailable, not zero", () => {
    const s = fplToMatchStats({ minutes: "90", goals_scored: "1", assists: "0", expected_goals: "0.71", clean_sheets: "1", tackles: "", starts: "1" });
    expect(s).toMatchObject({ minutes: 90, goals: 1, xg: 0.71, cleanSheet: true, tackles: null, shots: null, keyPasses: null, started: true });
  });

  it("splits double gameweeks per fixture using explain data", () => {
    const fx = (id: string, h: string, a: string): NormFixture => ({ providerRef: id, round: 30, kickoffAt: new Date(), homeRef: h, awayRef: a, homeName: h, awayName: a, homeScore: null, awayScore: null, status: "finished", minute: null, statsFinal: true, sourceUpdatedAt: null });
    const fixtures = [fx("100", "1", "2"), fx("101", "3", "1"), fx("102", "4", "5")];
    const wanted = new Map(fixtures.map((f) => [f.providerRef, f]));
    const teamOf = new Map<string, string | null>([["10", "1"], ["20", "4"]]);
    const rows = splitLiveElements(
      [
        {
          id: 10,
          stats: { minutes: 180, goals_scored: 2, expected_goals: 1.5 },
          explain: [
            { fixture: 100, stats: [{ identifier: "minutes", value: 90, points: 2 }, { identifier: "goals_scored", value: 2, points: 8 }] },
            { fixture: 101, stats: [{ identifier: "minutes", value: 90, points: 2 }] },
          ],
        },
        { id: 20, stats: { minutes: 0 }, explain: [] },
      ],
      fixtures,
      wanted,
      teamOf,
    );
    const p10 = rows.filter((r) => r.playerSeasonRef === "10");
    expect(p10).toHaveLength(2);
    expect(p10.find((r) => r.fixtureRef === "100")!.stats).toMatchObject({ minutes: 90, goals: 2, xg: null });
    expect(p10.find((r) => r.fixtureRef === "101")!.stats).toMatchObject({ minutes: 90, goals: 0, assists: 0 });
    // The unused substitute still gets a 0-minute row (role tracking, no price move).
    expect(rows.find((r) => r.playerSeasonRef === "20")).toMatchObject({ fixtureRef: "102" });
  });
});

describe("football-data.org normalisation", () => {
  it("maps statuses and builds clubs from matches", () => {
    expect(mapFdStatus("IN_PLAY")).toBe("live");
    expect(mapFdStatus("TIMED")).toBe("scheduled");
    expect(mapFdStatus("AWARDED")).toBe("finished");
    expect(mapFdStatus("SUSPENDED")).toBe("postponed");
    expect(seasonLabel(2026)).toBe("2026-27");
    const out = normaliseFdMatches({
      competition: { id: 2014, name: "La Liga", code: "PD" },
      matches: [
        { id: 9, utcDate: "2026-11-01T20:00:00Z", status: "FINISHED", matchday: 11, homeTeam: { id: 86, name: "Real Madrid CF", shortName: "Real Madrid", tla: "RMA" }, awayTeam: { id: 81, name: "FC Barcelona", shortName: "Barça", tla: "FCB" }, score: { fullTime: { home: 2, away: 1 } }, lastUpdated: "2026-11-01T22:00:00Z" },
        { id: 10, utcDate: "2026-11-08T20:00:00Z", status: "SCHEDULED", matchday: 12, homeTeam: { id: 81, name: "FC Barcelona" }, awayTeam: { id: null, name: null }, score: { fullTime: { home: null, away: null } } },
      ],
    });
    expect(out.clubs.map((c) => c.providerRef).sort()).toEqual(["81", "86"]);
    expect(out.fixtures[0]).toMatchObject({ status: "finished", homeScore: 2, awayScore: 1, statsFinal: true, homeName: "Real Madrid" });
    expect(out.fixtures[1]).toMatchObject({ status: "scheduled", awayRef: null, homeScore: null });
  });
});

describe("resilient provider HTTP", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("retries transient 5xx errors with backoff, then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(ok({ a: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { data } = await fetchJson<{ a: number }>("https://example.test/x", { fetchImpl, sleep, retries: 2 });
    expect(data.a).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("surfaces rate limits immediately with Retry-After for provider-level backoff", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "120" } }));
    const err = await fetchJson("https://example.test/x", { fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 120 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry auth failures and reports network errors after retries", async () => {
    const auth = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    await expect(fetchJson("https://example.test/x", { fetchImpl: auth, sleep: async () => {} })).rejects.toMatchObject({ kind: "auth" });
    expect(auth).toHaveBeenCalledTimes(1);
    const net = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchJson("https://example.test/x", { fetchImpl: net, sleep: async () => {}, retries: 2 })).rejects.toMatchObject({ kind: "network" });
    expect(net).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid JSON as a parse error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(fetchJson("https://example.test/x", { fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ kind: "parse" });
  });
});
