import { eq, sql } from "drizzle-orm";
import { db, schema, type DbOrTx, type Tx } from "@/db";
import type { PlayerMarketState } from "./pricing";
import type { Position } from "./scoring";

export type PlayerPriceRow = typeof schema.playerPrices.$inferSelect;

/** Rebuild the pure engine state from the settled columns of a player_prices row. */
export function settledStateFromRow(row: PlayerPriceRow, position: Position): PlayerMarketState {
  return {
    position,
    priceCents: row.settledPriceCents,
    priorQuality: row.priorQuality,
    priorWeight: row.priorWeight,
    qualitySum: row.qualitySum,
    qualityWeight: row.qualityWeight,
    formIndex: row.formIndex,
    priorRole: row.priorRole,
    priorRoleWeight: row.priorRoleWeight,
    roleSum: row.roleSum,
    roleMatches: row.roleMatches,
    matchesPriced: row.matchesPriced,
  };
}

export function stateColumns(s: PlayerMarketState) {
  return {
    priorQuality: s.priorQuality,
    priorWeight: s.priorWeight,
    qualitySum: s.qualitySum,
    qualityWeight: s.qualityWeight,
    formIndex: s.formIndex,
    priorRole: s.priorRole,
    priorRoleWeight: s.priorRoleWeight,
    roleSum: s.roleSum,
    roleMatches: s.roleMatches,
    matchesPriced: s.matchesPriced,
  };
}

export async function getMarketState(tx: DbOrTx = db) {
  const [row] = await tx.select().from(schema.marketState).where(eq(schema.marketState.id, 1));
  if (row) return row;
  await tx.insert(schema.marketState).values({ id: 1 }).onConflictDoNothing();
  const [created] = await tx.select().from(schema.marketState).where(eq(schema.marketState.id, 1));
  return created;
}

/**
 * Lock ordering (prevents deadlocks): every transaction that touches prices
 * locks market_state FIRST, then player_prices rows. Trades take a SHARE lock
 * on market_state; price writers take an exclusive lock via lockMarket().
 */
export async function lockMarket(tx: Tx): Promise<number> {
  const res = await tx.execute<{ version: string }>(sql`SELECT version FROM market_state WHERE id = 1 FOR UPDATE`);
  return Number(res.rows[0].version);
}

/**
 * Lock the market row and bump the version. All price writers go through this,
 * which serialises price updates against each other and against in-flight
 * trades (trades hold a share lock on the same row).
 */
export async function lockAndBumpMarketVersion(tx: Tx): Promise<number> {
  const res = await tx.execute<{ version: string }>(
    sql`UPDATE market_state SET version = version + 1, last_price_update_at = now(), updated_at = now() WHERE id = 1 RETURNING version`,
  );
  return Number(res.rows[0].version);
}

export async function setDataStatus(fields: { dataProvider?: string; dataMode?: string; dataAsOf?: Date | null }, tx: DbOrTx = db) {
  await getMarketState(tx);
  await tx
    .update(schema.marketState)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(schema.marketState.id, 1));
}
