/**
 * Premier League data from Fantasy Premier League.
 *
 *  - FplApiProvider:     the public FPL API (fantasy.premierleague.com/api). Live,
 *                        in-play per-player stats, xG/xA, availability. Unofficial
 *                        and undocumented: see docs/DATA_LICENSING.md for the risk.
 *  - FplArchiveProvider: the public GitHub archive of the same API
 *                        (github.com/vaastav/Fantasy-Premier-League, MIT). Delayed
 *                        by days; used as the honest "snapshot" fallback when the
 *                        live API is unreachable from the server.
 *
 * Both share entity ids (FPL `code` for players, FPL ids for clubs/fixtures), so
 * the market can switch between them without duplicating players or fixtures.
 */
import { parse } from "csv-parse/sync";
import { fetchJson, fetchText, type FetchOptions } from "../http";
import { fplAvailability, fplToMatchStats, FPL_POSITION, type FplRecord } from "./fpl-mapping";
import type {
  FixtureBundle,
  MarketDataProvider,
  NormClub,
  NormCompetition,
  NormFixture,
  NormPlayer,
  NormPlayerMatch,
  ProviderCapabilities,
  ReferenceBundle,
} from "./types";

export const FPL_ENTITY = "fpl";
const MATCH_LENGTH_MS = 115 * 60_000;

export function plCompetition(season: string): NormCompetition {
  return { code: "PL", name: "Premier League", country: "England", season, providerRef: "fpl-PL" };
}

const bool = (v: unknown) => v === true || v === "True" || v === "true" || v === 1 || v === "1";
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "" || v === "None") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dateOrNull = (v: unknown): Date | null => {
  if (!v || v === "None") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function normaliseFplClub(t: FplRecord): NormClub {
  return { providerRef: String(t.id), name: String(t.name), shortName: String(t.short_name ?? t.name) };
}

export function normaliseFplPlayer(e: FplRecord): NormPlayer | null {
  const position = FPL_POSITION[String(e.element_type)];
  if (!position) return null;
  const first = String(e.first_name ?? "").trim();
  const last = String(e.second_name ?? "").trim();
  const chance = numOrNull(e.chance_of_playing_next_round);
  const status = String(e.status ?? "");
  const news = String(e.news ?? "").trim();
  return {
    providerRef: String(e.code),
    seasonRef: String(e.id),
    firstName: first || String(e.web_name),
    lastName: last,
    displayName: String(e.web_name ?? `${first} ${last}`).trim(),
    clubRef: e.team === null || e.team === undefined || e.team === "" ? null : String(e.team),
    position,
    nationality: null, // not published by FPL
    birthDate: e.birth_date && e.birth_date !== "None" ? String(e.birth_date).slice(0, 10) : null,
    squadNumber: numOrNull(e.squad_number),
    availability: fplAvailability(status),
    availabilityNote: news || null,
    chanceOfPlaying: chance,
    availabilityUpdatedAt: dateOrNull(e.news_added),
    active: !bool(e.removed),
  };
}

export function normaliseFplFixture(f: FplRecord, clubName: (ref: string) => string): NormFixture {
  const kickoff = dateOrNull(f.kickoff_time);
  const started = bool(f.started);
  const finished = bool(f.finished);
  const finishedProvisional = bool(f.finished_provisional);
  let status: NormFixture["status"] = "scheduled";
  if (!kickoff) status = "postponed";
  else if (finished || finishedProvisional) status = "finished";
  else if (started) status = "live";
  const homeRef = String(f.team_h);
  const awayRef = String(f.team_a);
  return {
    providerRef: String(f.id),
    round: numOrNull(f.event),
    kickoffAt: kickoff,
    homeRef,
    awayRef,
    homeName: clubName(homeRef),
    awayName: clubName(awayRef),
    homeScore: status === "scheduled" || status === "postponed" ? null : numOrNull(f.team_h_score),
    awayScore: status === "scheduled" || status === "postponed" ? null : numOrNull(f.team_a_score),
    status,
    minute: status === "live" ? numOrNull(f.minutes) : null,
    statsFinal: finished,
    sourceUpdatedAt: null,
  };
}

function latestFinishedAt(fixtures: NormFixture[]): Date | null {
  let max = 0;
  for (const f of fixtures) {
    if (f.status === "finished" && f.kickoffAt) max = Math.max(max, f.kickoffAt.getTime() + MATCH_LENGTH_MS);
  }
  return max ? new Date(max) : null;
}

// ------------------------------------------------------------------ live FPL API

interface FplBootstrap {
  teams: FplRecord[];
  elements: FplRecord[];
  events: FplRecord[];
}
interface FplLiveElement {
  id: number;
  stats: FplRecord;
  explain: { fixture: number; stats: { identifier: string; value: number; points: number }[] }[];
  modified?: boolean;
}

const FPL_CAPS: ProviderCapabilities = {
  playerMatchStats: true,
  live: true,
  expectedStats: true,
  availability: true,
  typicalDelay: "about 1–2 minutes during matches; bonus/final stats ~1 hour after full time",
};

export class FplApiProvider implements MarketDataProvider {
  entityProvider = FPL_ENTITY;
  source = "fpl-api";
  label = "Fantasy Premier League API";
  mode = "live" as const;
  attribution = "Premier League player data: Fantasy Premier League (fantasy.premierleague.com). Unofficial use; not endorsed by the Premier League.";
  capabilities = FPL_CAPS;
  private bootstrap: { at: number; data: FplBootstrap } | null = null;

  constructor(
    private baseUrl: string,
    private season: string,
    private http: FetchOptions = {},
  ) {}

  private async getBootstrap(maxAgeMs = 60_000): Promise<FplBootstrap> {
    if (this.bootstrap && Date.now() - this.bootstrap.at < maxAgeMs) return this.bootstrap.data;
    const { data } = await fetchJson<FplBootstrap>(`${this.baseUrl}/bootstrap-static/`, this.http);
    if (!Array.isArray(data?.elements) || !Array.isArray(data?.teams)) throw new Error("FPL bootstrap-static: unexpected shape");
    this.bootstrap = { at: Date.now(), data };
    return data;
  }

  /** Lightweight reachability probe used by DATA_PROVIDER=auto. */
  async probe(): Promise<boolean> {
    try {
      await fetchText(`${this.baseUrl}/event-status/`, { ...this.http, retries: 0, timeoutMs: 8_000 });
      return true;
    } catch {
      return false;
    }
  }

  async fetchReference(): Promise<ReferenceBundle> {
    const b = await this.getBootstrap(0);
    const players = b.elements.map(normaliseFplPlayer).filter((p): p is NormPlayer => p !== null);
    let asOf = 0;
    for (const p of players) if (p.availabilityUpdatedAt) asOf = Math.max(asOf, p.availabilityUpdatedAt.getTime());
    return { competition: plCompetition(this.season), clubs: b.teams.map(normaliseFplClub), players, dataAsOf: new Date() };
  }

  async fetchFixtures(): Promise<FixtureBundle> {
    const b = await this.getBootstrap();
    const clubs = b.teams.map(normaliseFplClub);
    const names = new Map(clubs.map((c) => [c.providerRef, c.name]));
    const { data } = await fetchJson<FplRecord[]>(`${this.baseUrl}/fixtures/`, this.http);
    if (!Array.isArray(data)) throw new Error("FPL fixtures: unexpected shape");
    const fixtures = data.map((f) => normaliseFplFixture(f, (r) => names.get(r) ?? `Club ${r}`));
    return { competition: plCompetition(this.season), clubs, fixtures, dataAsOf: new Date() };
  }

  async fetchMatchStats(fixtures: NormFixture[]): Promise<NormPlayerMatch[]> {
    const b = await this.getBootstrap();
    const teamOf = new Map(b.elements.map((e) => [String(e.id), e.team === undefined || e.team === null ? null : String(e.team)]));
    const wanted = new Map(fixtures.map((f) => [f.providerRef, f]));
    const rounds = [...new Set(fixtures.map((f) => f.round).filter((r): r is number => r !== null))].sort((a, b) => a - b);
    const out: NormPlayerMatch[] = [];
    for (const round of rounds) {
      const { data } = await fetchJson<{ elements: FplLiveElement[] }>(`${this.baseUrl}/event/${round}/live/`, this.http);
      const roundFixtures = fixtures.filter((f) => f.round === round);
      out.push(...splitLiveElements(data.elements ?? [], roundFixtures, wanted, teamOf));
    }
    return out;
  }
}

/**
 * Turn FPL `event/{gw}/live` elements into per-fixture rows.
 *  - One fixture for the player's team in the round → the full stats object (incl. xG, tackles…).
 *  - Several (double gameweek) → per-fixture values from `explain`; stats FPL does not
 *    split per fixture (xG, xA, tackles, CBI, recoveries) are null for those rows.
 *  - Players whose team played but who have no minutes → 0-minute rows (role tracking).
 */
export function splitLiveElements(
  elements: FplLiveElement[],
  roundFixtures: NormFixture[],
  wanted: Map<string, NormFixture>,
  teamOf: Map<string, string | null>,
): NormPlayerMatch[] {
  const out: NormPlayerMatch[] = [];
  for (const el of elements) {
    const team = teamOf.get(String(el.id)) ?? null;
    const teamFixtures = roundFixtures.filter((f) => team && (f.homeRef === team || f.awayRef === team));
    if (teamFixtures.length === 0) continue;
    const isFinalFor = (f: NormFixture) => f.statsFinal;
    if (teamFixtures.length === 1) {
      const f = teamFixtures[0];
      if (!wanted.has(f.providerRef)) continue;
      out.push({
        playerSeasonRef: String(el.id),
        fixtureRef: f.providerRef,
        clubRef: team,
        stats: fplToMatchStats(el.stats),
        isFinal: isFinalFor(f),
        sourceUpdatedAt: new Date(),
      });
      continue;
    }
    for (const f of teamFixtures) {
      if (!wanted.has(f.providerRef)) continue;
      const ex = (el.explain ?? []).find((x) => String(x.fixture) === f.providerRef);
      const rec: FplRecord = {};
      for (const s of ex?.stats ?? []) rec[s.identifier] = s.value;
      const stats = fplToMatchStats({ ...rec, minutes: rec.minutes ?? 0 });
      // explain only carries point-scoring stats; mark the rest as unavailable.
      for (const k of ["goals_scored", "assists", "clean_sheets", "goals_conceded", "own_goals", "penalties_saved", "penalties_missed", "yellow_cards", "red_cards", "saves"] as const) {
        if (rec[k] === undefined && stats.minutes > 0) {
          // A point-scoring stat absent from explain means it was zero in that fixture.
          (stats as unknown as Record<string, unknown>)[mapKey(k)] = k === "clean_sheets" ? false : 0;
        }
      }
      stats.xg = null;
      stats.xa = null;
      stats.tackles = null;
      stats.cbi = null;
      stats.recoveries = null;
      stats.xgc = null;
      out.push({ playerSeasonRef: String(el.id), fixtureRef: f.providerRef, clubRef: team, stats, isFinal: isFinalFor(f), sourceUpdatedAt: new Date() });
    }
  }
  return out;
}

function mapKey(k: string): string {
  return (
    {
      goals_scored: "goals",
      assists: "assists",
      clean_sheets: "cleanSheet",
      goals_conceded: "goalsConceded",
      own_goals: "ownGoals",
      penalties_saved: "penaltiesSaved",
      penalties_missed: "penaltiesMissed",
      yellow_cards: "yellowCards",
      red_cards: "redCards",
      saves: "saves",
    } as Record<string, string>
  )[k];
}

// ------------------------------------------------------------------ GitHub archive

const ARCHIVE_CAPS: ProviderCapabilities = {
  playerMatchStats: true,
  live: false,
  expectedStats: true,
  availability: true,
  typicalDelay: "days — community snapshot updated irregularly after gameweeks",
};

export class FplArchiveProvider implements MarketDataProvider {
  entityProvider = FPL_ENTITY;
  source = "fpl-archive";
  label = "FPL public archive (GitHub snapshot)";
  mode = "snapshot" as const;
  attribution =
    "Premier League player data: Fantasy Premier League, via the public archive github.com/vaastav/Fantasy-Premier-League (MIT). Delayed snapshot, not live.";
  capabilities = ARCHIVE_CAPS;
  private cache = new Map<string, { at: number; rows: FplRecord[] }>();

  constructor(
    private baseUrl: string,
    private season: string,
    private http: FetchOptions = {},
    /** Optional local directory with the season's CSVs (tests / offline). */
    private localDir?: string,
  ) {}

  private async csv(file: string, maxAgeMs = 5 * 60_000): Promise<FplRecord[]> {
    const hit = this.cache.get(file);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.rows;
    let text: string;
    if (this.localDir) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      text = await fs.readFile(path.join(this.localDir, file), "utf8");
    } else {
      text = (await fetchText(`${this.baseUrl}/${this.season}/${file}`, { ...this.http, timeoutMs: 30_000 })).text;
    }
    const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true }) as FplRecord[];
    this.cache.set(file, { at: Date.now(), rows });
    return rows;
  }

  async fetchReference(): Promise<ReferenceBundle> {
    const [teams, players] = await Promise.all([this.csv("teams.csv"), this.csv("players_raw.csv")]);
    const norm = players.map(normaliseFplPlayer).filter((p): p is NormPlayer => p !== null);
    let asOf = 0;
    for (const p of norm) if (p.availabilityUpdatedAt) asOf = Math.max(asOf, p.availabilityUpdatedAt.getTime());
    return { competition: plCompetition(this.season), clubs: teams.map(normaliseFplClub), players: norm, dataAsOf: asOf ? new Date(asOf) : null };
  }

  async fetchFixtures(): Promise<FixtureBundle> {
    const [teams, rows] = await Promise.all([this.csv("teams.csv"), this.csv("fixtures.csv")]);
    const clubs = teams.map(normaliseFplClub);
    const names = new Map(clubs.map((c) => [c.providerRef, c.name]));
    const fixtures = rows.map((f) => normaliseFplFixture(f, (r) => names.get(r) ?? `Club ${r}`));
    // A snapshot can never be "live": anything not finished in the snapshot is unknown, not in play.
    for (const f of fixtures) {
      if (f.status === "live") {
        f.status = "scheduled";
        f.homeScore = null;
        f.awayScore = null;
        f.minute = null;
      }
    }
    return { competition: plCompetition(this.season), clubs, fixtures, dataAsOf: latestFinishedAt(fixtures) };
  }

  async fetchMatchStats(fixtures: NormFixture[]): Promise<NormPlayerMatch[]> {
    const wanted = new Map(fixtures.map((f) => [f.providerRef, f]));
    const [rows, players] = await Promise.all([this.csv("gws/merged_gw.csv"), this.csv("players_raw.csv")]);
    const teamOf = new Map(players.map((p) => [String(p.id), p.team === undefined ? null : String(p.team)]));
    const out: NormPlayerMatch[] = [];
    for (const r of rows) {
      const f = wanted.get(String(r.fixture));
      if (!f) continue;
      out.push({
        playerSeasonRef: String(r.element),
        fixtureRef: f.providerRef,
        clubRef: teamOf.get(String(r.element)) ?? null,
        stats: fplToMatchStats(r),
        isFinal: f.statsFinal,
        sourceUpdatedAt: f.kickoffAt ? new Date(f.kickoffAt.getTime() + MATCH_LENGTH_MS) : null,
      });
    }
    return out;
  }
}
