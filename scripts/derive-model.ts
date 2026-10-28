/**
 * Derives the scoring baselines and per-player IPO priors from a completed
 * Premier League season (default 2025-26) using the public FPL archive
 * (github.com/vaastav/Fantasy-Premier-League, MIT-licensed repository of FPL API dumps).
 *
 *   npm run data:derive                     # downloads from GitHub
 *   npm run data:derive -- --dir /path/to/2025-26   # or use local CSVs
 *
 * Outputs (committed to the repo so builds are reproducible offline):
 *   src/server/market/model-baselines.json   per-position rates per 90, clean-sheet rate, σ
 *   data/priors/fpl-2025-26.json             per-player prior quality keyed by FPL `code`
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { fplToMatchStats, FPL_POSITION, type FplRecord } from "@/server/ingestion/providers/fpl-mapping";
import { COUNT_STATS, POSITIONS, RICH_STATS, scoreMatch, type CountStat, type Position, type ScoringModel } from "@/server/market/scoring";
import { minutesWeight } from "@/server/market/pricing";

const SEASON = process.env.PRIOR_SEASON ?? "2025-26";
const BASE = process.env.FPL_ARCHIVE_BASE_URL ?? "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";

/**
 * Provisional per-90 rates for stats FPL does not publish (used only when a
 * provider such as API-Football supplies them). Approximate top-flight averages;
 * flagged as provisional in the output and docs.
 */
const PROVISIONAL: Record<Position, Partial<Record<CountStat, number>>> = {
  GK: { shots: 0.01, shotsOnTarget: 0, keyPasses: 0.05, dribbles: 0.01, interceptions: 0.1, clearances: 0.8 },
  DEF: { shots: 0.6, shotsOnTarget: 0.18, keyPasses: 0.6, dribbles: 0.3, interceptions: 1.0, clearances: 3.5 },
  MID: { shots: 1.3, shotsOnTarget: 0.45, keyPasses: 1.1, dribbles: 0.8, interceptions: 0.8, clearances: 1.0 },
  FWD: { shots: 2.6, shotsOnTarget: 1.0, keyPasses: 0.9, dribbles: 1.0, interceptions: 0.3, clearances: 0.6 },
};

async function readCsv(file: string, dir?: string): Promise<FplRecord[]> {
  let text: string;
  if (dir) {
    text = fs.readFileSync(path.join(dir, path.basename(file)), "utf8");
  } else {
    const url = `${BASE}/${SEASON}/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    text = await res.text();
  }
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true }) as FplRecord[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dir = arg("dir");
  const [gws, playersRaw] = await Promise.all([readCsv("gws/merged_gw.csv", dir), readCsv("players_raw.csv", dir)]);
  const codeByElement = new Map<string, { code: string; name: string }>();
  for (const p of playersRaw) {
    codeByElement.set(String(p.id), { code: String(p.code), name: `${p.first_name} ${p.second_name}`.trim() });
  }

  // ---- pass 1: per-90 rates by position (FPL-available stats only) + clean-sheet rate
  const totals: Record<Position, { minutes: number; sums: Partial<Record<CountStat, number>>; cs60: number; n60: number; apps: number }> = {
    GK: { minutes: 0, sums: {}, cs60: 0, n60: 0, apps: 0 },
    DEF: { minutes: 0, sums: {}, cs60: 0, n60: 0, apps: 0 },
    MID: { minutes: 0, sums: {}, cs60: 0, n60: 0, apps: 0 },
    FWD: { minutes: 0, sums: {}, cs60: 0, n60: 0, apps: 0 },
  };
  const rows = gws
    .map((r) => ({ r, pos: FPL_POSITION[String(r.position)], stats: fplToMatchStats(r) }))
    .filter((x) => x.pos && x.stats.minutes > 0);
  for (const { pos, stats } of rows) {
    const t = totals[pos];
    t.minutes += stats.minutes;
    t.apps += 1;
    for (const k of COUNT_STATS) {
      const v = stats[k];
      if (typeof v === "number") t.sums[k] = (t.sums[k] ?? 0) + v;
    }
    if (stats.minutes >= 60 && typeof stats.cleanSheet === "boolean") {
      t.n60 += 1;
      if (stats.cleanSheet) t.cs60 += 1;
    }
  }
  const model: ScoringModel = {
    ratesPer90: { GK: {}, DEF: {}, MID: {}, FWD: {} },
    cleanSheetRate: { GK: 0, DEF: 0, MID: 0, FWD: 0 },
    sigma: { GK: 1, DEF: 1, MID: 1, FWD: 1 },
  };
  for (const pos of POSITIONS) {
    const t = totals[pos];
    for (const k of COUNT_STATS) {
      if (t.sums[k] !== undefined) model.ratesPer90[pos][k] = round((t.sums[k]! / t.minutes) * 90, 5);
      else if (PROVISIONAL[pos][k] !== undefined) model.ratesPer90[pos][k] = PROVISIONAL[pos][k]!;
    }
    model.cleanSheetRate[pos] = round(t.cs60 / Math.max(1, t.n60), 4);
  }

  // ---- pass 2: σ of (score − expected) over ≥60-minute appearances
  const resid: Record<Position, number[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const { pos, stats } of rows) {
    if (stats.minutes < 60) continue;
    const s = scoreMatch(stats, pos, model);
    resid[pos].push(s.score - s.expected);
  }
  for (const pos of POSITIONS) {
    const xs = resid[pos];
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1);
    model.sigma[pos] = round(Math.sqrt(variance), 4);
  }

  // ---- pass 2b: σ for the basic stat profile (feeds without xG/xA/defensive stats, e.g. ESPN)
  const residLimited: Record<Position, number[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  const basicModel: ScoringModel = { ...model, sigmaLimited: undefined };
  for (const { pos, stats } of rows) {
    if (stats.minutes < 60) continue;
    const basic = { ...stats };
    for (const k of RICH_STATS) basic[k] = null;
    const s = scoreMatch(basic, pos, basicModel);
    residLimited[pos].push(s.score - s.expected);
  }
  model.sigmaLimited = { GK: 1, DEF: 1, MID: 1, FWD: 1 };
  for (const pos of POSITIONS) {
    const xs = residLimited[pos];
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1);
    model.sigmaLimited[pos] = round(Math.sqrt(variance), 4);
  }
  model.source = {
    dataset: `FPL archive ${SEASON} (github.com/vaastav/Fantasy-Premier-League, gws/merged_gw.csv)`,
    appearances: rows.length,
    appearancesByPosition: Object.fromEntries(POSITIONS.map((p) => [p, totals[p].apps])),
    provisionalStats: ["shots", "shotsOnTarget", "keyPasses", "dribbles", "interceptions", "clearances"],
    generatedAt: new Date().toISOString(),
  };

  // ---- pass 3: per-player prior quality (minutes-weighted mean z) and role (minutes share).
  // Role counts every team match the player was registered for, including 0-minute rows.
  const acc = new Map<string, { code: string; name: string; pos: Position; zm: number; m: number; apps: number; registered: number }>();
  for (const r of gws) {
    const id = codeByElement.get(String(r.element));
    const pos = FPL_POSITION[String(r.position)];
    if (!id || !pos) continue;
    const stats = fplToMatchStats(r);
    const cur = acc.get(id.code) ?? { code: id.code, name: id.name, pos, zm: 0, m: 0, apps: 0, registered: 0 };
    cur.registered += 1;
    cur.pos = pos;
    if (stats.minutes > 0) {
      const s = scoreMatch(stats, pos, model);
      const m = minutesWeight(stats.minutes);
      cur.zm += s.z * m;
      cur.m += m;
      cur.apps += 1;
    }
    acc.set(id.code, cur);
  }
  const priors: Record<string, { name: string; position: Position; quality: number; weight: number; role: number; roleMatches: number; appearances: number }> = {};
  for (const v of [...acc.values()].sort((a, b) => Number(a.code) - Number(b.code))) {
    priors[v.code] = {
      name: v.name,
      position: v.pos,
      quality: v.m > 0 ? round(v.zm / v.m, 4) : 0,
      weight: round(v.m, 3),
      role: round(v.m / Math.max(1, v.registered), 4),
      roleMatches: v.registered,
      appearances: v.apps,
    };
  }

  const baselinesPath = path.join(process.cwd(), "src/server/market/model-baselines.json");
  fs.writeFileSync(baselinesPath, JSON.stringify(model, null, 2) + "\n");
  const priorsDir = path.join(process.cwd(), "data/priors");
  fs.mkdirSync(priorsDir, { recursive: true });
  const priorsPath = path.join(priorsDir, `fpl-${SEASON}.json`);
  fs.writeFileSync(
    priorsPath,
    JSON.stringify({ season: SEASON, source: model.source.dataset, generatedAt: model.source.generatedAt, players: priors }, null, 1) + "\n",
  );
  console.log(JSON.stringify({ msg: "derived model", sigma: model.sigma, cleanSheetRate: model.cleanSheetRate, players: Object.keys(priors).length }));
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
