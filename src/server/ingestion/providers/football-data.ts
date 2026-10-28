/**
 * football-data.org v4 — fixtures and results for competitions outside the
 * tradable market (La Liga, Bundesliga, Serie A, Ligue 1, Champions League).
 *
 * Free tier (verified Oct 2026): 12 competitions, 10 requests/minute, delayed
 * scores, NO player-level data (lineups/cards/squads/stats need paid add-ons).
 * So these competitions appear on the Fixtures screen but their players are not
 * tradable. Requires FOOTBALL_DATA_API_KEY (free registration).
 */
import { fetchJson, type FetchOptions } from "../http";
import type { FixtureBundle, FixtureOnlyProvider, NormClub, NormFixture, ProviderCapabilities } from "./types";

export const FOOTBALL_DATA_COMPETITIONS: Record<string, { name: string; country: string | null }> = {
  PL: { name: "Premier League", country: "England" },
  PD: { name: "La Liga", country: "Spain" },
  BL1: { name: "Bundesliga", country: "Germany" },
  SA: { name: "Serie A", country: "Italy" },
  FL1: { name: "Ligue 1", country: "France" },
  CL: { name: "UEFA Champions League", country: null },
};

interface FdTeam {
  id: number | null;
  name: string | null;
  shortName?: string | null;
  tla?: string | null;
}
interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  minute?: number | string | null;
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score: { fullTime: { home: number | null; away: number | null } };
  lastUpdated?: string;
}
interface FdResponse {
  competition: { id: number; name: string; code: string };
  filters?: { season?: string };
  matches: FdMatch[];
}

export function mapFdStatus(status: string): NormFixture["status"] {
  switch (status) {
    case "IN_PLAY":
    case "PAUSED":
    case "LIVE":
      return "live";
    case "FINISHED":
    case "AWARDED":
      return "finished";
    case "POSTPONED":
    case "SUSPENDED":
      return "postponed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "scheduled"; // SCHEDULED, TIMED
  }
}

/** Season label "2026-27" from a season start year. */
export function seasonLabel(startYear: number) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function normaliseFdMatches(data: FdResponse): { clubs: NormClub[]; fixtures: NormFixture[]; dataAsOf: Date | null } {
  const clubs = new Map<string, NormClub>();
  const addClub = (t: FdTeam) => {
    if (t.id === null || t.id === undefined) return null;
    const ref = String(t.id);
    if (!clubs.has(ref)) clubs.set(ref, { providerRef: ref, name: t.name ?? `Team ${ref}`, shortName: t.tla ?? t.shortName ?? t.name ?? ref });
    return ref;
  };
  let asOf = 0;
  const fixtures: NormFixture[] = (data.matches ?? []).map((m) => {
    const status = mapFdStatus(m.status);
    const homeRef = addClub(m.homeTeam);
    const awayRef = addClub(m.awayTeam);
    const updated = m.lastUpdated ? new Date(m.lastUpdated) : null;
    if (updated && !Number.isNaN(updated.getTime())) asOf = Math.max(asOf, updated.getTime());
    const minute = typeof m.minute === "number" ? m.minute : Number.parseInt(String(m.minute ?? ""), 10);
    return {
      providerRef: String(m.id),
      round: m.matchday ?? null,
      kickoffAt: m.utcDate ? new Date(m.utcDate) : null,
      homeRef,
      awayRef,
      homeName: m.homeTeam.shortName ?? m.homeTeam.name ?? "TBD",
      awayName: m.awayTeam.shortName ?? m.awayTeam.name ?? "TBD",
      homeScore: status === "scheduled" ? null : m.score?.fullTime?.home ?? null,
      awayScore: status === "scheduled" ? null : m.score?.fullTime?.away ?? null,
      status,
      minute: status === "live" && Number.isFinite(minute) ? minute : null,
      statsFinal: status === "finished",
      sourceUpdatedAt: updated,
    };
  });
  return { clubs: [...clubs.values()], fixtures, dataAsOf: asOf ? new Date(asOf) : null };
}

export class FootballDataProvider implements FixtureOnlyProvider {
  entityProvider = "football-data";
  source = "football-data.org";
  label = "football-data.org";
  attribution = "Football data provided by the Football-Data.org API";
  capabilities: ProviderCapabilities = {
    playerMatchStats: false,
    live: false,
    expectedStats: false,
    availability: false,
    typicalDelay: "scores delayed on the free tier",
  };

  constructor(
    private apiKey: string,
    private seasonStartYear: number,
    private http: FetchOptions = {},
    private baseUrl = "https://api.football-data.org/v4",
  ) {}

  async fetchCompetitionFixtures(code: string): Promise<FixtureBundle> {
    const meta = FOOTBALL_DATA_COMPETITIONS[code];
    if (!meta) throw new Error(`Unsupported football-data.org competition ${code}`);
    const { data } = await fetchJson<FdResponse>(`${this.baseUrl}/competitions/${code}/matches?season=${this.seasonStartYear}`, {
      ...this.http,
      headers: { "X-Auth-Token": this.apiKey },
      retries: 1,
    });
    const { clubs, fixtures, dataAsOf } = normaliseFdMatches(data);
    return {
      competition: { code, name: meta.name, country: meta.country, season: seasonLabel(this.seasonStartYear), providerRef: `fd-${code}` },
      clubs,
      fixtures,
      dataAsOf: dataAsOf ?? new Date(),
    };
  }
}
