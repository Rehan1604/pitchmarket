/**
 * Match performance scoring — pure, deterministic, position-aware.
 *
 * For one player in one match we compute:
 *   score     s = Σ weight[pos][stat] × value(stat)          over AVAILABLE stats
 *   expected  e = Σ weight[pos][stat] × rate[pos][stat] × min/90  over the SAME stats
 *   z           = (s − e) / σ[pos]
 *
 * A stat the provider does not supply is `null`/`undefined` and is excluded from
 * BOTH s and e, so missing data never reads as a bad performance. Rates and σ
 * come from model-baselines.json, derived from the 2025-26 Premier League season
 * by `npm run data:derive` (scripts/derive-model.ts).
 *
 * Scoring is separate from pricing: pricing.ts turns z into price movements.
 */
import baselines from "./model-baselines.json";

export type Position = "GK" | "DEF" | "MID" | "FWD";
export const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

export interface MatchStats {
  minutes: number;
  goals?: number | null;
  assists?: number | null;
  xg?: number | null;
  xa?: number | null;
  shots?: number | null;
  shotsOnTarget?: number | null;
  keyPasses?: number | null;
  dribbles?: number | null;
  tackles?: number | null;
  interceptions?: number | null;
  clearances?: number | null;
  cbi?: number | null;
  recoveries?: number | null;
  saves?: number | null;
  cleanSheet?: boolean | null;
  goalsConceded?: number | null;
  ownGoals?: number | null;
  penaltiesSaved?: number | null;
  penaltiesMissed?: number | null;
  yellowCards?: number | null;
  redCards?: number | null;
}

/** Count-type stats that are scored per unit. */
export const COUNT_STATS = [
  "goals",
  "assists",
  "xg",
  "xa",
  "shots",
  "shotsOnTarget",
  "keyPasses",
  "dribbles",
  "tackles",
  "interceptions",
  "clearances",
  "cbi",
  "recoveries",
  "saves",
  "goalsConceded",
  "ownGoals",
  "penaltiesSaved",
  "penaltiesMissed",
  "yellowCards",
  "redCards",
] as const;
export type CountStat = (typeof COUNT_STATS)[number];

type PerPosition<T> = Record<Position, T>;

/** Points per unit of each stat, by position. Documented in docs/MARKET_MECHANICS.md. */
export const WEIGHTS: PerPosition<Record<CountStat | "cleanSheet", number>> = {
  GK: {
    goals: 6, assists: 3, xg: 1.5, xa: 1.5, shots: 0.1, shotsOnTarget: 0.3, keyPasses: 0.4, dribbles: 0.3,
    tackles: 0.2, interceptions: 0.2, clearances: 0.05, cbi: 0.05, recoveries: 0.03, saves: 0.5,
    goalsConceded: -0.5, ownGoals: -2, penaltiesSaved: 5, penaltiesMissed: -2, yellowCards: -1, redCards: -3,
    cleanSheet: 4,
  },
  DEF: {
    goals: 6, assists: 3, xg: 1.5, xa: 1.5, shots: 0.1, shotsOnTarget: 0.3, keyPasses: 0.4, dribbles: 0.3,
    tackles: 0.35, interceptions: 0.35, clearances: 0.1, cbi: 0.15, recoveries: 0.06, saves: 0,
    goalsConceded: -0.5, ownGoals: -2, penaltiesSaved: 5, penaltiesMissed: -2, yellowCards: -1, redCards: -3,
    cleanSheet: 4,
  },
  MID: {
    goals: 5, assists: 3, xg: 1.5, xa: 1.5, shots: 0.1, shotsOnTarget: 0.3, keyPasses: 0.4, dribbles: 0.3,
    tackles: 0.3, interceptions: 0.3, clearances: 0.05, cbi: 0.15, recoveries: 0.06, saves: 0,
    goalsConceded: 0, ownGoals: -2, penaltiesSaved: 5, penaltiesMissed: -2, yellowCards: -1, redCards: -3,
    cleanSheet: 1,
  },
  FWD: {
    goals: 4, assists: 3, xg: 1.5, xa: 1.5, shots: 0.1, shotsOnTarget: 0.3, keyPasses: 0.4, dribbles: 0.3,
    tackles: 0.2, interceptions: 0.2, clearances: 0.05, cbi: 0.1, recoveries: 0.06, saves: 0,
    goalsConceded: 0, ownGoals: -2, penaltiesSaved: 5, penaltiesMissed: -2, yellowCards: -1, redCards: -3,
    cleanSheet: 0,
  },
};

export interface ScoringModel {
  /** Expected count per 90 minutes, by position and stat. */
  ratesPer90: PerPosition<Partial<Record<CountStat, number>>>;
  /** Probability of a clean sheet given ≥60 minutes played. */
  cleanSheetRate: PerPosition<number>;
  /** Standard deviation of (s − e) for ≥60-minute appearances. */
  sigma: PerPosition<number>;
  /** Free-form provenance (dataset, rows, generated date). */
  source?: Record<string, unknown>;
}

export const DEFAULT_MODEL: ScoringModel = baselines as unknown as ScoringModel;

const present = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function appearancePoints(minutes: number): number {
  if (minutes <= 0) return 0;
  return minutes >= 60 ? 2 : 1;
}

/**
 * Which stats are scored for this record. Combined `cbi` is only used when the
 * provider does not report interceptions/clearances separately (no double count).
 */
export function scoredStats(stats: MatchStats): CountStat[] {
  const out: CountStat[] = [];
  const separateDefensive = present(stats.interceptions) || present(stats.clearances);
  for (const k of COUNT_STATS) {
    if (k === "cbi" && separateDefensive) continue;
    if (present(stats[k])) out.push(k);
  }
  return out;
}

export interface ScoreResult {
  score: number;
  expected: number;
  z: number;
  /** Per-stat contributions to `score` (useful for the UI and audits). */
  breakdown: Record<string, number>;
  /** Stats that were unavailable and therefore excluded. */
  excluded: string[];
}

export const Z_CLAMP = { min: -3, max: 4 } as const;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function scoreMatch(stats: MatchStats, pos: Position, model: ScoringModel = DEFAULT_MODEL): ScoreResult {
  const minutes = Math.max(0, Math.min(130, Math.floor(stats.minutes || 0)));
  const w = WEIGHTS[pos];
  const breakdown: Record<string, number> = {};
  const excluded: string[] = [];

  if (minutes === 0) {
    return { score: 0, expected: 0, z: 0, breakdown, excluded: [] };
  }

  let score = appearancePoints(minutes);
  let expected = score; // appearance points are deterministic given minutes
  breakdown.appearance = score;

  const scored = new Set(scoredStats(stats));
  for (const k of COUNT_STATS) {
    if (!scored.has(k)) {
      if (k !== "cbi" && !present(stats[k])) excluded.push(k);
      continue;
    }
    const weight = w[k];
    if (weight === 0) continue;
    const value = stats[k] as number;
    const contribution = weight * value;
    score += contribution;
    if (contribution !== 0) breakdown[k] = round4(contribution);
    const rate = model.ratesPer90[pos][k] ?? 0;
    expected += weight * rate * (minutes / 90);
  }

  if (typeof stats.cleanSheet === "boolean") {
    if (minutes >= 60) {
      const cs = stats.cleanSheet ? w.cleanSheet : 0;
      score += cs;
      if (cs) breakdown.cleanSheet = cs;
      expected += w.cleanSheet * model.cleanSheetRate[pos];
    }
  } else {
    excluded.push("cleanSheet");
  }

  const sigma = model.sigma[pos] > 0 ? model.sigma[pos] : 1;
  const rawZ = (score - expected) / sigma;
  const z = Math.max(Z_CLAMP.min, Math.min(Z_CLAMP.max, rawZ));
  return { score: round4(score), expected: round4(expected), z: round4(z), breakdown, excluded };
}

/** Deterministic hash of the stats that matter, used for idempotent ingestion. */
export function statsFingerprint(stats: MatchStats): string {
  const parts: string[] = [`m:${stats.minutes}`];
  for (const k of COUNT_STATS) {
    const v = stats[k];
    parts.push(`${k}:${present(v) ? round4(v) : "-"}`);
  }
  parts.push(`cs:${typeof stats.cleanSheet === "boolean" ? (stats.cleanSheet ? 1 : 0) : "-"}`);
  return parts.join("|");
}
