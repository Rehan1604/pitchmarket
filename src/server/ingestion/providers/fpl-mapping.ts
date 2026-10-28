/**
 * Mapping from Fantasy Premier League (FPL) field names to our normalised
 * MatchStats. Shared by the live FPL adapter (event/{gw}/live) and the
 * archive adapter (vaastav/Fantasy-Premier-League CSV dumps of the same API).
 *
 * FPL does NOT supply shots, key passes, dribbles, or separate interceptions /
 * clearances; those are returned as null (unavailable), never 0.
 */
import type { MatchStats, Position } from "@/server/market/scoring";

export type FplRecord = Record<string, string | number | boolean | null | undefined>;

export const FPL_POSITION: Record<string, Position> = {
  "1": "GK",
  "2": "DEF",
  "3": "MID",
  "4": "FWD",
  GK: "GK",
  GKP: "GK",
  DEF: "DEF",
  MID: "MID",
  FWD: "FWD",
};

function num(v: FplRecord[string]): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: FplRecord[string]): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

export function fplToMatchStats(r: FplRecord): MatchStats & { started: boolean | null; xgc: number | null } {
  const minutes = int(r.minutes) ?? 0;
  const cs = int(r.clean_sheets);
  return {
    minutes,
    started: int(r.starts) === null ? null : int(r.starts)! > 0,
    goals: int(r.goals_scored),
    assists: int(r.assists),
    xg: num(r.expected_goals),
    xa: num(r.expected_assists),
    shots: null,
    shotsOnTarget: null,
    keyPasses: null,
    dribbles: null,
    tackles: int(r.tackles),
    interceptions: null,
    clearances: null,
    cbi: int(r.clearances_blocks_interceptions),
    recoveries: int(r.recoveries),
    saves: int(r.saves),
    // FPL only credits a clean sheet after 60+ minutes; scoring ignores CS below 60 anyway.
    cleanSheet: cs === null ? null : cs > 0,
    goalsConceded: int(r.goals_conceded),
    xgc: num(r.expected_goals_conceded),
    ownGoals: int(r.own_goals),
    penaltiesSaved: int(r.penalties_saved),
    penaltiesMissed: int(r.penalties_missed),
    yellowCards: int(r.yellow_cards),
    redCards: int(r.red_cards),
  };
}

/** FPL availability status codes → our enum. */
export function fplAvailability(status: string | null | undefined): "available" | "doubtful" | "injured" | "suspended" | "unavailable" | "unknown" {
  switch (status) {
    case "a":
      return "available";
    case "d":
      return "doubtful";
    case "i":
      return "injured";
    case "s":
      return "suspended";
    case "u":
    case "n":
      return "unavailable";
    default:
      return "unknown";
  }
}
