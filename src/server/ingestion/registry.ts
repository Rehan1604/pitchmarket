import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/server/env";
import { log } from "@/server/log";
import { ESPN_LEAGUES, EspnProvider } from "./providers/espn";
import { FootballDataProvider } from "./providers/football-data";
import { FplApiProvider, FplArchiveProvider } from "./providers/fpl";
import type { FixtureOnlyProvider, MarketDataProvider } from "./providers/types";
import { recordProviderFailure, recordProviderSuccess } from "./pipeline";

const REPROBE_MS = 30 * 60_000;
let choice: { at: number; provider: MarketDataProvider } | null = null;

export function fplApiProvider() {
  const e = env();
  return new FplApiProvider(e.FPL_BASE_URL, e.FPL_SEASON);
}

export function fplArchiveProvider() {
  const e = env();
  return new FplArchiveProvider(e.FPL_ARCHIVE_BASE_URL, e.FPL_SEASON, {}, e.FPL_ARCHIVE_LOCAL_DIR);
}

/**
 * The tradable-market provider. With DATA_PROVIDER=auto the live FPL API is
 * preferred; if it is unreachable from this server we fall back to the public
 * snapshot and say so everywhere (market_state.data_mode = "snapshot").
 */
export async function resolveMarketProvider(opts: { forceProbe?: boolean } = {}): Promise<MarketDataProvider> {
  const mode = env().DATA_PROVIDER;
  if (mode === "fpl") return fplApiProvider();
  if (mode === "fpl-archive") return fplArchiveProvider();
  if (!opts.forceProbe && choice && Date.now() - choice.at < REPROBE_MS) return choice.provider;

  // Avoid re-probing on every serverless invocation after a recent failure.
  const [status] = await db.select().from(schema.providerStatus).where(eq(schema.providerStatus.provider, "fpl-api"));
  const recentFailure = status?.lastErrorAt && Date.now() - status.lastErrorAt.getTime() < REPROBE_MS && (!status.lastSuccessAt || status.lastSuccessAt < status.lastErrorAt);
  const live = fplApiProvider();
  let reachable = false;
  if (!recentFailure || opts.forceProbe) {
    reachable = await live.probe();
    if (reachable) await recordProviderSuccess("fpl-api", null);
    else await recordProviderFailure("fpl-api", new Error("FPL API unreachable from this server (probe failed)"));
  }
  const provider = reachable ? live : fplArchiveProvider();
  if (!reachable) log.warn("FPL API unreachable — using public snapshot", { source: provider.source });
  choice = { at: Date.now(), provider };
  return provider;
}

let espnCache: { key: string; providers: EspnProvider[] } | null = null;

/** Tradable ESPN competitions (empty unless ESPN_ENABLED=true). Instances are reused across ticks (metadata cache). */
export function espnProviders(): EspnProvider[] {
  const e = env();
  if (!e.ESPN_ENABLED) return [];
  const slugs = e.ESPN_LEAGUES.split(",").map((x) => x.trim()).filter((x) => x && ESPN_LEAGUES[x]);
  const key = `${e.ESPN_BASE_URL}|${slugs.join(",")}`;
  if (!espnCache || espnCache.key !== key) espnCache = { key, providers: slugs.map((slug) => new EspnProvider(slug, e.ESPN_BASE_URL)) };
  return espnCache.providers;
}

export function fixtureOnlyProvider(): { provider: FixtureOnlyProvider; competitions: string[] } | null {
  const e = env();
  if (!e.FOOTBALL_DATA_API_KEY) return null;
  const year = Number(e.FPL_SEASON.slice(0, 4));
  const tradable = new Set(["PL", ...espnProviders().map((p) => p.code)]);
  const competitions = e.FOOTBALL_DATA_COMPETITIONS.split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c && !tradable.has(c)); // these come with player data from FPL / ESPN
  return { provider: new FootballDataProvider(e.FOOTBALL_DATA_API_KEY, year), competitions };
}

/** Reset cached provider choice (tests, admin "re-probe"). */
export function resetProviderChoice() {
  choice = null;
}
