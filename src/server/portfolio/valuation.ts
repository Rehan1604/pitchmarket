/**
 * Portfolio valuation. Everything here is derived from persisted server state:
 * cash_accounts (locked running total of cash_entries), positions (aggregate of
 * the trade ledger) and player_prices. Nothing the browser sends is trusted.
 *
 * Identities (all integer cents):
 *   holdings value = Σ qty × price
 *   total value    = cash + holdings value
 *   unrealized P/L = Σ (qty × price − cost basis)
 *   total return   = total value − starting cash = realized + unrealized
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/db";
import { changeBps, divRoundHalfUp } from "@/lib/money";

export interface HoldingView {
  playerId: number;
  slug: string;
  name: string;
  firstName: string;
  lastName: string;
  position: string;
  club: string | null;
  quantity: number;
  costBasisCents: number;
  avgCostCents: number;
  priceCents: number;
  previousPriceCents: number;
  valueCents: number;
  unrealizedCents: number;
  unrealizedBps: number;
  realizedCents: number;
  allocationBps: number;
  isTradable: boolean;
  liveFixtureId: number | null;
}

export interface PortfolioSummary {
  cashCents: number;
  startingCents: number;
  holdingsValueCents: number;
  totalValueCents: number;
  costBasisCents: number;
  unrealizedCents: number;
  realizedCents: number;
  totalReturnCents: number;
  returnBps: number;
  holdings: HoldingView[];
}

export function summarise(cashCents: number, startingCents: number, rows: Omit<HoldingView, "allocationBps" | "avgCostCents" | "valueCents" | "unrealizedCents" | "unrealizedBps">[], realizedTotal: number): PortfolioSummary {
  let holdingsValue = 0;
  let basis = 0;
  const holdings: HoldingView[] = rows.map((r) => {
    const value = r.quantity * r.priceCents;
    holdingsValue += value;
    basis += r.costBasisCents;
    return {
      ...r,
      valueCents: value,
      avgCostCents: r.quantity > 0 ? divRoundHalfUp(r.costBasisCents, r.quantity) : 0,
      unrealizedCents: value - r.costBasisCents,
      unrealizedBps: changeBps(r.costBasisCents, value),
      allocationBps: 0,
    };
  });
  const total = cashCents + holdingsValue;
  for (const h of holdings) h.allocationBps = total > 0 ? Math.round((h.valueCents / total) * 10_000) : 0;
  holdings.sort((a, b) => b.valueCents - a.valueCents || a.name.localeCompare(b.name));
  return {
    cashCents,
    startingCents,
    holdingsValueCents: holdingsValue,
    totalValueCents: total,
    costBasisCents: basis,
    unrealizedCents: holdingsValue - basis,
    realizedCents: realizedTotal,
    totalReturnCents: total - startingCents,
    returnBps: changeBps(startingCents, total),
    holdings,
  };
}

export async function getPortfolio(userId: string, tx: DbOrTx = db): Promise<PortfolioSummary | null> {
  const [account] = await tx.select().from(schema.cashAccounts).where(eq(schema.cashAccounts.userId, userId));
  if (!account) return null;
  const rows = await tx
    .select({
      playerId: schema.positions.playerId,
      quantity: schema.positions.quantity,
      costBasisCents: schema.positions.costBasisCents,
      realizedCents: schema.positions.realizedPnlCents,
      slug: schema.players.slug,
      name: schema.players.displayName,
      firstName: schema.players.firstName,
      lastName: schema.players.lastName,
      position: schema.players.position,
      club: schema.clubs.shortName,
      isTradable: schema.players.isTradable,
      priceCents: schema.playerPrices.priceCents,
      previousPriceCents: schema.playerPrices.previousPriceCents,
      liveFixtureId: schema.playerPrices.liveFixtureId,
    })
    .from(schema.positions)
    .innerJoin(schema.players, eq(schema.players.id, schema.positions.playerId))
    .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.positions.playerId))
    .leftJoin(schema.clubs, eq(schema.clubs.id, schema.players.clubId))
    .where(eq(schema.positions.userId, userId));
  const realizedTotal = rows.reduce((a, r) => a + r.realizedCents, 0);
  return summarise(
    account.balanceCents,
    account.startingCents,
    rows.filter((r) => r.quantity > 0),
    realizedTotal,
  );
}

/** SQL fragment: current portfolio value per user (cash + Σ qty × price). */
export function portfolioValuesQuery() {
  return sql`
    SELECT ca.user_id,
           ca.balance_cents::bigint AS cash_cents,
           ca.starting_cents::bigint AS starting_cents,
           COALESCE(SUM(p.quantity::bigint * pp.price_cents), 0)::bigint AS holdings_cents
    FROM cash_accounts ca
    JOIN users u ON u.id = ca.user_id AND u.deleted_at IS NULL
    LEFT JOIN positions p ON p.user_id = ca.user_id AND p.quantity > 0
    LEFT JOIN player_prices pp ON pp.player_id = p.player_id
    GROUP BY ca.user_id, ca.balance_cents, ca.starting_cents`;
}

export async function getTrades(userId: string, opts: { limit?: number; before?: Date; playerId?: number } = {}) {
  const conds = [eq(schema.trades.userId, userId)];
  if (opts.playerId) conds.push(eq(schema.trades.playerId, opts.playerId));
  if (opts.before) conds.push(sql`${schema.trades.createdAt} < ${opts.before}`);
  return db
    .select({
      id: schema.trades.id,
      side: schema.trades.side,
      quantity: schema.trades.quantity,
      priceCents: schema.trades.priceCents,
      grossCents: schema.trades.grossCents,
      feeCents: schema.trades.feeCents,
      cashDeltaCents: schema.trades.cashDeltaCents,
      realizedPnlCents: schema.trades.realizedPnlCents,
      cashAfterCents: schema.trades.cashAfterCents,
      positionAfterQty: schema.trades.positionAfterQty,
      marketVersion: schema.trades.marketVersion,
      createdAt: schema.trades.createdAt,
      playerId: schema.trades.playerId,
      playerName: schema.players.displayName,
      playerSlug: schema.players.slug,
      position: schema.players.position,
    })
    .from(schema.trades)
    .innerJoin(schema.players, eq(schema.players.id, schema.trades.playerId))
    .where(and(...conds))
    .orderBy(desc(schema.trades.createdAt))
    .limit(Math.min(200, opts.limit ?? 50));
}

export async function getValueHistory(userId: string, days = 90) {
  const rows = await db
    .select({ day: schema.portfolioSnapshots.day, valueCents: schema.portfolioSnapshots.valueCents })
    .from(schema.portfolioSnapshots)
    .where(and(eq(schema.portfolioSnapshots.userId, userId), gt(schema.portfolioSnapshots.day, isoDay(new Date(Date.now() - days * 86400_000)))))
    .orderBy(schema.portfolioSnapshots.day);
  return rows;
}

export function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}
