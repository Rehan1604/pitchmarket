/**
 * La Liga, Bundesliga, Serie A, Ligue 1 and the Champions League from ESPN's
 * public site feed (site.api.espn.com).
 *
 * RISK — read docs/DATA_LICENSING.md: this feed is undocumented and ESPN/Disney's
 * terms of use forbid automated access without written permission. It is opt-in
 * (ESPN_ENABLED=true), the operator chose to accept that risk, and requests are
 * kept low and polite (small concurrency, caching, provider-level backoff).
 *
 * Identity: ESPN athlete ids are global across ESPN competitions, so a Real Madrid
 * player's La Liga and Champions League matches move one price. Player stats per
 * match: goals, assists, shots, shots on target, saves (GK), goals conceded while
 * on the pitch, own goals and cards. Minutes are derived from starts, substitution
 * times and red cards. Anything ESPN doesn't publish is null (never zero).
 */
import type { Position } from "@/server/market/scoring";
import { fetchJson, ProviderError, type FetchOptions } from "../http";
import type {
  FixtureBundle,
  FixtureState,
  MarketDataProvider,
  NormClub,
  NormCompetition,
  NormFixture,
  NormPlayer,
  NormPlayerMatch,
  ProviderCapabilities,
  ReferenceBundle,
} from "./types";

export const ESPN_ENTITY = "espn";
/** Stats are treated as final this long after kickoff (≈45–55 minutes after full time). */
export const ESPN_FINAL_AFTER_MIN = 165;
const CONCURRENCY = 3;

export const ESPN_LEAGUES: Record<string, { code: string; name: string; country: string | null }> = {
  "esp.1": { code: "PD", name: "La Liga", country: "Spain" },
  "ger.1": { code: "BL1", name: "Bundesliga", country: "Germany" },
  "ita.1": { code: "SA", name: "Serie A", country: "Italy" },
  "fra.1": { code: "FL1", name: "Ligue 1", country: "France" },
  "uefa.champions": { code: "CL", name: "Champions League", country: null },
};
export const ESPN_CUP_SLUGS = new Set(["uefa.champions"]);

const CAPS: ProviderCapabilities = {
  playerMatchStats: true,
  live: true,
  expectedStats: false,
  availability: false,
  typicalDelay: "about 1–2 minutes during matches; prices settle ~45 minutes after full time",
};

// ------------------------------------------------------------------ raw shapes (only what we read)

interface EspnTeam {
  id: string;
  displayName?: string;
  shortDisplayName?: string;
  abbreviation?: string;
}
interface EspnStatus {
  displayClock?: string;
  period?: number;
  type?: { name?: string; state?: string; completed?: boolean; detail?: string };
}
export interface EspnEvent {
  id: string;
  date?: string;
  status?: EspnStatus;
  competitions?: { competitors?: { id: string; homeAway?: string; score?: string | number; team?: EspnTeam }[] }[];
}
export interface EspnScoreboard {
  leagues?: { slug?: string; season?: { year?: number; startDate?: string; endDate?: string }; calendar?: unknown[] }[];
  events?: EspnEvent[];
}
export interface EspnAthlete {
  id: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  shortName?: string;
  jersey?: string;
  position?: { abbreviation?: string };
  dateOfBirth?: string;
  citizenship?: string;
  status?: { type?: string };
}
export interface EspnRoster {
  team?: EspnTeam;
  athletes?: EspnAthlete[];
}
interface EspnTeamsResponse {
  sports?: { leagues?: { teams?: { team: EspnTeam }[] }[] }[];
}
interface EspnPlay {
  clock?: { displayValue?: string };
  substitution?: boolean;
  redCard?: boolean;
}
interface EspnRosterEntry {
  starter?: boolean;
  subbedIn?: boolean;
  subbedOut?: boolean;
  athlete?: { id?: string; displayName?: string };
  position?: { abbreviation?: string };
  stats?: { name?: string; value?: number | string | null }[];
  plays?: EspnPlay[];
}
export interface EspnSummary {
  header?: { id?: string; competitions?: { status?: EspnStatus; competitors?: { id: string; homeAway?: string; score?: string }[] }[] };
  rosters?: { team?: EspnTeam; roster?: EspnRosterEntry[] }[];
}

// ------------------------------------------------------------------ pure normalisation (unit-tested)

export function espnSeasonLabel(year: number): string {
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

export function espnCompetition(slug: string, seasonYear: number): NormCompetition {
  const meta = ESPN_LEAGUES[slug];
  if (!meta) throw new Error(`Unknown ESPN league ${slug}`);
  return { code: meta.code, name: meta.name, country: meta.country, season: espnSeasonLabel(seasonYear), providerRef: `espn-${slug}` };
}

/** ESPN uses G/D/M/F on squad lists and detailed slots (RB, AM-L, LF…) on match sheets. */
export function mapEspnPosition(abbr: string | undefined | null): Position | null {
  const a = (abbr ?? "").toUpperCase().trim();
  if (!a || a === "SUB") return null;
  if (a === "G" || a === "GK") return "GK";
  const parts = a.split("-");
  const head = parts[0];
  if (["D", "CB", "CD", "LB", "RB", "LWB", "RWB", "SW", "DF"].includes(head)) return "DEF";
  if (["F", "CF", "ST", "LF", "RF", "LW", "RW", "FW", "SS"].includes(head)) return "FWD";
  if (["M", "DM", "CM", "AM", "LM", "RM", "MF"].includes(head)) return "MID";
  return null;
}

export function mapEspnStatus(status: EspnStatus | undefined): FixtureState {
  const name = (status?.type?.name ?? "").toUpperCase();
  const state = status?.type?.state;
  if (name.includes("POSTPONED") || name.includes("DELAYED")) return "postponed";
  if (name.includes("CANCELED") || name.includes("CANCELLED") || name.includes("ABANDONED") || name.includes("FORFEIT")) return "cancelled";
  if (state === "in" || name.includes("HALFTIME") || name.includes("IN_PROGRESS") || name.includes("FIRST_HALF") || name.includes("SECOND_HALF") || name.includes("EXTRA") || name.includes("SHOOTOUT")) return "live";
  if (state === "post" || status?.type?.completed || name.includes("FINAL") || name.includes("FULL_TIME")) return "finished";
  return "scheduled";
}

/** "62'" → 62, "90'+4'" → 90 (stoppage time folds into the base minute, like FPL minutes). */
export function parseClockMinute(display: string | undefined | null): number | null {
  if (!display) return null;
  const m = /^(\d+)/.exec(display.trim());
  return m ? Number(m[1]) : null;
}

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

export function normaliseEspnEvent(ev: EspnEvent, now: Date = new Date()): { fixture: NormFixture; clubs: NormClub[] } {
  const comp = ev.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === "home") ?? comp?.competitors?.[0];
  const away = comp?.competitors?.find((c) => c.homeAway === "away") ?? comp?.competitors?.[1];
  const status = mapEspnStatus(ev.status);
  const kickoffAt = ev.date ? new Date(ev.date) : null;
  const started = status === "live" || status === "finished";
  const finalAfter = kickoffAt ? kickoffAt.getTime() + ESPN_FINAL_AFTER_MIN * 60_000 : Infinity;
  const clubs: NormClub[] = [home, away]
    .filter((c): c is NonNullable<typeof c> => Boolean(c?.team?.id))
    .map((c) => ({ providerRef: String(c.team!.id), name: c.team!.displayName ?? `Club ${c.team!.id}`, shortName: c.team!.shortDisplayName ?? c.team!.displayName ?? c.team!.abbreviation ?? `Club ${c.team!.id}` }));
  return {
    clubs,
    fixture: {
      providerRef: String(ev.id),
      round: null,
      kickoffAt,
      homeRef: home?.team?.id ? String(home.team.id) : null,
      awayRef: away?.team?.id ? String(away.team.id) : null,
      homeName: home?.team?.displayName ?? "TBC",
      awayName: away?.team?.displayName ?? "TBC",
      homeScore: started ? toInt(home?.score) : null,
      awayScore: started ? toInt(away?.score) : null,
      status,
      minute: status === "live" ? parseClockMinute(ev.status?.displayClock) : null,
      statsFinal: status === "finished" && now.getTime() >= finalAfter,
      sourceUpdatedAt: now,
    },
  };
}

export function normaliseEspnAthlete(a: EspnAthlete, teamRef: string): NormPlayer | null {
  const position = mapEspnPosition(a.position?.abbreviation);
  if (!position || !a.id) return null;
  const displayName = (a.displayName ?? `${a.firstName ?? ""} ${a.lastName ?? ""}`).trim();
  const first = (a.firstName ?? "").trim();
  const last = (a.lastName ?? "").trim();
  // Mononyms (Pedri, Raphinha) come as firstName only.
  const lastName = last || first || displayName;
  const firstName = last ? first : "";
  return {
    providerRef: String(a.id),
    seasonRef: String(a.id),
    firstName,
    lastName,
    displayName,
    clubRef: teamRef,
    position,
    nationality: a.citizenship ?? null,
    birthDate: a.dateOfBirth ? a.dateOfBirth.slice(0, 10) : null,
    squadNumber: toInt(a.jersey),
    // ESPN's soccer squad lists carry no injury data: say "unknown", don't guess.
    availability: "unknown",
    availabilityNote: null,
    chanceOfPlaying: null,
    availabilityUpdatedAt: null,
    active: (a.status?.type ?? "active") === "active",
  };
}

/** Per-player rows for one match summary. Pure: everything comes from `summary` and `fixture`. */
export function espnMatchRows(summary: EspnSummary, fixture: NormFixture, now: Date = new Date()): NormPlayerMatch[] {
  const hdrStatus = summary.header?.competitions?.[0]?.status;
  const statusName = (hdrStatus?.type?.name ?? "").toUpperCase();
  const live = fixture.status === "live" || mapEspnStatus(hdrStatus) === "live";
  const matchEnd = statusName.includes("AET") || statusName.includes("PEN") || statusName.includes("EXTRA") || statusName.includes("SHOOTOUT") ? 120 : 90;
  const clockNow = live ? (parseClockMinute(hdrStatus?.displayClock) ?? fixture.minute ?? 0) : matchEnd;
  const endBase = Math.min(Math.max(clockNow, 0), matchEnd);
  const out: NormPlayerMatch[] = [];

  for (const team of summary.rosters ?? []) {
    const clubRef = team.team?.id ? String(team.team.id) : null;
    for (const p of team.roster ?? []) {
      const id = p.athlete?.id;
      if (!id) continue;
      const played = Boolean(p.starter || p.subbedIn);
      const subs = (p.plays ?? []).filter((x) => x.substitution).map((x) => parseClockMinute(x.clock?.displayValue)).filter((x): x is number => x !== null);
      const red = (p.plays ?? []).find((x) => x.redCard);
      const redMinute = red ? parseClockMinute(red.clock?.displayValue) : null;
      const start = p.starter ? 0 : (subs[0] ?? endBase);
      const subOff = p.starter ? (p.subbedOut ? subs[0] : undefined) : p.subbedOut ? subs[1] : undefined;
      let end = endBase;
      if (subOff !== undefined) end = Math.min(end, subOff);
      if (redMinute !== null) end = Math.min(end, redMinute);
      // Not yet on (live, sub minute ahead of the clock) → 0; a stoppage-time cameo → 1.
      const minutes = !played || start > end ? 0 : Math.max(1, Math.min(130, end - start));

      const stat = (name: string): number | null => {
        const s = p.stats?.find((x) => x.name === name);
        return s ? toInt(s.value) : null;
      };
      const conceded = played ? stat("goalsConceded") : null;
      out.push({
        playerSeasonRef: String(id),
        fixtureRef: fixture.providerRef,
        clubRef,
        isFinal: fixture.statsFinal,
        sourceUpdatedAt: now,
        stats: {
          minutes,
          started: Boolean(p.starter),
          goals: played ? stat("totalGoals") : null,
          assists: played ? stat("goalAssists") : null,
          shots: played ? stat("totalShots") : null,
          shotsOnTarget: played ? stat("shotsOnTarget") : null,
          saves: played ? stat("saves") : null,
          goalsConceded: conceded,
          cleanSheet: played && conceded !== null ? minutes >= 60 && conceded === 0 : null,
          ownGoals: played ? stat("ownGoals") : null,
          yellowCards: played ? stat("yellowCards") : null,
          redCards: played ? stat("redCards") : null,
          xg: null,
          xa: null,
          keyPasses: null,
          dribbles: null,
          tackles: null,
          interceptions: null,
          clearances: null,
          cbi: null,
          recoveries: null,
          penaltiesSaved: null,
          penaltiesMissed: null,
          xgc: null,
        },
      });
    }
  }
  return out;
}

/** Months (YYYYMM) that hold matches, from the league calendar or the season range. */
export function seasonMonths(sb: EspnScoreboard, now: Date = new Date()): string[] {
  const league = sb.leagues?.[0];
  const months = new Set<string>();
  const add = (d: Date) => {
    if (!Number.isNaN(d.getTime())) months.add(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const addRange = (from?: string, to?: string) => {
    if (!from) return;
    const d = new Date(from);
    const end = new Date(to ?? from);
    if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) return;
    d.setUTCDate(1);
    for (let guard = 0; d <= end && guard < 24; guard++) {
      add(d);
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  };
  for (const c of league?.calendar ?? []) {
    if (typeof c === "string") add(new Date(c));
    else if (c && typeof c === "object") {
      // Cup calendars list stages ("League Phase", Sep–Jan): every month inside each stage.
      const o = c as { startDate?: string; endDate?: string; entries?: { startDate?: string; endDate?: string }[] };
      for (const e of o.entries?.length ? o.entries : [o]) addRange(e.startDate, e.endDate);
    }
  }
  if (months.size === 0 && league?.season?.startDate && league.season.endDate) {
    const d = new Date(league.season.startDate);
    const end = new Date(league.season.endDate);
    d.setUTCDate(1);
    while (d <= end) {
      add(d);
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  if (months.size === 0) add(now);
  return [...months].sort();
}

export function recentMonths(now: Date = new Date()): string[] {
  const out = new Set<string>();
  for (const offsetDays of [-3, 0, 3]) {
    const d = new Date(now.getTime() + offsetDays * 86_400_000);
    out.add(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return [...out].sort();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

// ------------------------------------------------------------------ provider

export class EspnProvider implements MarketDataProvider {
  entityProvider = ESPN_ENTITY;
  source = "espn";
  label = "ESPN";
  mode = "live" as const;
  primary = false;
  fillSquadOnFinal = true;
  attribution = "Match data: ESPN (unofficial public feed). Not affiliated with or endorsed by ESPN, the leagues or UEFA.";
  capabilities = CAPS;
  private meta: { at: number; sb: EspnScoreboard } | null = null;

  constructor(
    public slug: string,
    private baseUrl: string,
    private http: FetchOptions = {},
    private clock: () => Date = () => new Date(),
  ) {
    if (!ESPN_LEAGUES[slug]) throw new Error(`Unsupported ESPN league: ${slug}`);
  }

  get code() {
    return ESPN_LEAGUES[this.slug].code;
  }
  get isCup() {
    return ESPN_CUP_SLUGS.has(this.slug);
  }

  private get<T>(path: string) {
    return fetchJson<T>(`${this.baseUrl}/${path}`, this.http).then((r) => r.data);
  }

  private async scoreboardMeta(): Promise<EspnScoreboard> {
    if (this.meta && Date.now() - this.meta.at < 6 * 3600_000) return this.meta.sb;
    const sb = await this.get<EspnScoreboard>(`${this.slug}/scoreboard`);
    if (!Array.isArray(sb?.leagues)) throw new ProviderError("parse", `ESPN ${this.slug} scoreboard: unexpected shape`);
    this.meta = { at: Date.now(), sb };
    return sb;
  }

  async competition(): Promise<NormCompetition> {
    const sb = await this.scoreboardMeta();
    const year = sb.leagues?.[0]?.season?.year ?? this.clock().getUTCFullYear();
    return espnCompetition(this.slug, year);
  }

  async fetchFixtures(opts: { window?: "full" | "recent" } = {}): Promise<FixtureBundle> {
    const now = this.clock();
    const sb = await this.scoreboardMeta();
    const months = opts.window === "recent" ? recentMonths(now) : seasonMonths(sb, now);
    const pages = await mapLimit(months, CONCURRENCY, (m) => this.get<EspnScoreboard>(`${this.slug}/scoreboard?dates=${m}&limit=500`));
    const fixtures = new Map<string, NormFixture>();
    const clubs = new Map<string, NormClub>();
    for (const page of pages) {
      for (const ev of page.events ?? []) {
        const n = normaliseEspnEvent(ev, now);
        fixtures.set(n.fixture.providerRef, n.fixture);
        for (const c of n.clubs) clubs.set(c.providerRef, c);
      }
    }
    return { competition: await this.competition(), clubs: [...clubs.values()], fixtures: [...fixtures.values()], dataAsOf: now };
  }

  async fetchTeams(): Promise<NormClub[]> {
    const data = await this.get<EspnTeamsResponse>(`${this.slug}/teams`);
    const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];
    return teams.map(({ team }) => ({ providerRef: String(team.id), name: team.displayName ?? `Club ${team.id}`, shortName: team.shortDisplayName ?? team.displayName ?? String(team.id) }));
  }

  async fetchRoster(teamRef: string): Promise<EspnAthlete[]> {
    const data = await this.get<EspnRoster>(`${this.slug}/teams/${teamRef}/roster`);
    return data.athletes ?? [];
  }

  /** Full reference for one league: every listed squad player. */
  async fetchReference(): Promise<ReferenceBundle> {
    const clubs = await this.fetchTeams();
    const rosters = await mapLimit(clubs, CONCURRENCY, async (c) => ({ club: c, athletes: await this.fetchRoster(c.providerRef) }));
    const players: NormPlayer[] = [];
    for (const { club, athletes } of rosters) {
      for (const a of athletes) {
        const p = normaliseEspnAthlete(a, club.providerRef);
        if (p) players.push(p);
      }
    }
    return { competition: await this.competition(), clubs, players, dataAsOf: this.clock() };
  }

  async fetchMatchStats(fixtures: NormFixture[]): Promise<NormPlayerMatch[]> {
    const now = this.clock();
    let lastErr: unknown = null;
    let ok = 0;
    const results = await mapLimit(fixtures, CONCURRENCY, async (f) => {
      try {
        const summary = await this.get<EspnSummary>(`all/summary?event=${encodeURIComponent(f.providerRef)}`);
        ok++;
        return espnMatchRows(summary, f, now);
      } catch (e) {
        lastErr = e;
        // One missing match sheet must not block the others; it is retried next run.
        return [];
      }
    });
    if (ok === 0 && fixtures.length > 0 && lastErr) throw lastErr;
    return results.flat();
  }
}
