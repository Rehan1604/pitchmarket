import { sql } from "drizzle-orm";
import { db } from "@/db";
import { json } from "@/server/http";
import { dataStatus } from "@/server/market/queries";

/** Readiness: database reachable, migrations applied, market initialised; reports data freshness. */
export async function GET() {
  const started = Date.now();
  try {
    const res = await db.execute<{ migrations: number; players: number }>(sql`
      SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations,
             (SELECT count(*)::int FROM player_prices) AS players`);
    const status = await dataStatus();
    const row = res.rows[0];
    const ready = row.migrations > 0 && row.players > 0;
    return json(
      {
        ready,
        checks: { database: "ok", migrationsApplied: row.migrations, listedPlayers: row.players },
        market: { status: status.marketStatus, dataMode: status.dataMode, dataProvider: status.dataProvider, dataAsOf: status.dataAsOf, lastPriceUpdateAt: status.lastPriceUpdateAt, liveMatches: status.liveMatches },
        ms: Date.now() - started,
      },
      { status: ready ? 200 : 503 },
    );
  } catch (e) {
    return json({ ready: false, checks: { database: "error" }, error: e instanceof Error ? e.message.split("\n")[0] : "unknown" }, { status: 503 });
  }
}
