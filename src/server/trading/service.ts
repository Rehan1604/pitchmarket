/**
 * Server-authoritative trade execution.
 *
 * Guarantees (all enforced inside ONE Postgres transaction):
 *  - Price, fee, cash and P/L are computed here from locked database rows; the
 *    client only supplies player, side, whole-share quantity and an idempotency key.
 *  - The user's cash account row is locked FOR UPDATE, so concurrent orders by the
 *    same user serialise — no double spending.
 *  - market_state is share-locked, so a trade never interleaves with a price update;
 *    each trade records the exact market version it executed against.
 *  - (user_id, idempotency_key) is unique: a retried or double-submitted order
 *    returns the original receipt instead of trading twice.
 *  - The trades and cash_entries ledgers are append-only (DB triggers).
 *
 * Market orders only, whole shares only (documented in docs/MARKET_MECHANICS.md).
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { env } from "@/server/env";
import { conflict, HttpError, notFound } from "@/server/http";
import { addCents, feeForGross, mulCents, releasedBasis } from "@/lib/money";
import { isUniqueViolation } from "@/server/auth/accounts";
import { sameClubIds } from "@/server/market/clubs";

export const tradeInputSchema = z.object({
  playerId: z.number().int().positive(),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_:-]+$/),
  /** Price the user saw on the ticket; if the market moved, the order is rejected with the new price. */
  expectedPriceCents: z.number().int().positive().optional(),
});

export type TradeInput = z.infer<typeof tradeInputSchema> & { userId: string };

export interface TradeReceipt {
  id: string;
  playerId: number;
  side: "buy" | "sell";
  quantity: number;
  priceCents: number;
  grossCents: number;
  feeCents: number;
  cashDeltaCents: number;
  realizedPnlCents: number;
  cashAfterCents: number;
  positionAfterQty: number;
  marketVersion: number;
  createdAt: string;
  replayed: boolean;
}

export type BlockReason = "MARKET_HALTED" | "MARKET_MAINTENANCE" | "PLAYER_IN_PLAY" | "PLAYER_NOT_TRADABLE" | null;

function toReceipt(t: typeof schema.trades.$inferSelect, replayed: boolean): TradeReceipt {
  return {
    id: t.id,
    playerId: t.playerId,
    side: t.side,
    quantity: t.quantity,
    priceCents: t.priceCents,
    grossCents: t.grossCents,
    feeCents: t.feeCents,
    cashDeltaCents: t.cashDeltaCents,
    realizedPnlCents: t.realizedPnlCents,
    cashAfterCents: t.cashAfterCents,
    positionAfterQty: t.positionAfterQty,
    marketVersion: t.marketVersion,
    createdAt: t.createdAt.toISOString(),
    replayed,
  };
}

async function findExisting(userId: string, key: string) {
  const [t] = await db.select().from(schema.trades).where(and(eq(schema.trades.userId, userId), eq(schema.trades.idempotencyKey, key)));
  return t ?? null;
}

function assertSameOrder(t: typeof schema.trades.$inferSelect, input: TradeInput) {
  if (t.playerId !== input.playerId || t.side !== input.side || t.quantity !== input.quantity) {
    throw conflict("IDEMPOTENCY_KEY_REUSED", "This order key was already used for a different order. Refresh and try again.");
  }
}

/** Is this player currently in a live match (for the in-play trading lock)? */
async function playerInPlay(tx: Tx, playerId: number, clubId: number | null, liveFixtureId: number | null) {
  if (liveFixtureId) return true;
  if (!clubId) return false;
  const same = sameClubIds(clubId);
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM fixtures
    WHERE status = 'live' AND (home_club_id IN ${same} OR away_club_id IN ${same})`);
  return Number(res.rows[0]?.n ?? 0) > 0;
}

export async function executeTrade(input: TradeInput): Promise<TradeReceipt> {
  const cfg = env();
  if (input.quantity > cfg.MAX_SHARES_PER_ORDER) {
    throw new HttpError(400, "QUANTITY_TOO_LARGE", `Orders are limited to ${cfg.MAX_SHARES_PER_ORDER.toLocaleString("en-GB")} shares.`);
  }

  const prior = await findExisting(input.userId, input.idempotencyKey);
  if (prior) {
    assertSameOrder(prior, input);
    return toReceipt(prior, true);
  }

  try {
    return await db.transaction(async (tx) => {
      // 1. Market status + version (share lock: blocks concurrent price writers, not other trades).
      const marketRes = await tx.execute<{ version: string; status: string; status_reason: string | null }>(
        sql`SELECT version, status, status_reason FROM market_state WHERE id = 1 FOR SHARE`,
      );
      const market = marketRes.rows[0];
      if (!market) throw new HttpError(503, "MARKET_UNAVAILABLE", "The market is not initialised yet.");
      if (market.status !== "open") {
        throw new HttpError(423, market.status === "maintenance" ? "MARKET_MAINTENANCE" : "MARKET_HALTED", market.status_reason ?? "Trading is paused right now.");
      }
      const marketVersion = Number(market.version);

      // 2. Lock the cash account — serialises all orders for this user.
      const accRes = await tx.execute<{ balance_cents: string }>(sql`SELECT balance_cents FROM cash_accounts WHERE user_id = ${input.userId} FOR UPDATE`);
      if (!accRes.rows[0]) throw new HttpError(403, "NO_ACCOUNT", "Your account has no trading balance.");
      const cash = Number(accRes.rows[0].balance_cents);

      // Re-check idempotency under the lock (a concurrent duplicate may have just committed).
      const dupe = await tx.select().from(schema.trades).where(and(eq(schema.trades.userId, input.userId), eq(schema.trades.idempotencyKey, input.idempotencyKey)));
      if (dupe[0]) {
        assertSameOrder(dupe[0], input);
        return toReceipt(dupe[0], true);
      }

      // 3. Price and player state.
      const priceRes = await tx.execute<{ price_cents: string; live_fixture_id: number | null; is_tradable: boolean; club_id: number | null }>(sql`
        SELECT pp.price_cents, pp.live_fixture_id, p.is_tradable, p.club_id
        FROM player_prices pp JOIN players p ON p.id = pp.player_id
        WHERE pp.player_id = ${input.playerId}
        FOR SHARE OF pp`);
      const pr = priceRes.rows[0];
      if (!pr) throw notFound("That player isn't listed on the market.");
      const price = Number(pr.price_cents);

      if (input.side === "buy" && !pr.is_tradable) {
        throw new HttpError(409, "PLAYER_NOT_TRADABLE", "This player is no longer listed. You can sell existing shares but not buy more.");
      }
      if (cfg.LIVE_TRADING_POLICY === "halt" && (await playerInPlay(tx, input.playerId, pr.club_id, pr.live_fixture_id))) {
        throw new HttpError(423, "PLAYER_IN_PLAY", "Trading in this player is locked while their match is live. It reopens at full time.");
      }
      if (input.expectedPriceCents !== undefined && input.expectedPriceCents !== price) {
        throw conflict("PRICE_CHANGED", "The price moved before your order reached the market. Review the new price.", {
          currentPriceCents: price,
          marketVersion,
        });
      }

      // 4. Position (locked).
      const posRes = await tx.execute<{ quantity: number; cost_basis_cents: string; realized_pnl_cents: string }>(sql`
        SELECT quantity, cost_basis_cents, realized_pnl_cents FROM positions
        WHERE user_id = ${input.userId} AND player_id = ${input.playerId} FOR UPDATE`);
      const pos = posRes.rows[0] ? { qty: Number(posRes.rows[0].quantity), basis: Number(posRes.rows[0].cost_basis_cents), realized: Number(posRes.rows[0].realized_pnl_cents) } : null;

      const gross = mulCents(price, input.quantity);
      const fee = feeForGross(gross, cfg.TRADING_FEE_BPS);
      let cashDelta: number;
      let basisReleased = 0;
      let realized = 0;
      let newQty: number;
      let newBasis: number;

      if (input.side === "buy") {
        const total = addCents(gross, fee);
        if (total > cash) {
          throw new HttpError(422, "INSUFFICIENT_CASH", "You don't have enough Pitch Credits for this order.", { cashCents: cash, requiredCents: total });
        }
        cashDelta = -total;
        newQty = (pos?.qty ?? 0) + input.quantity;
        newBasis = addCents(pos?.basis ?? 0, total);
      } else {
        if (!pos || pos.qty < input.quantity) {
          throw new HttpError(422, "INSUFFICIENT_SHARES", "You can't sell more shares than you hold.", { heldQuantity: pos?.qty ?? 0 });
        }
        const proceeds = gross - fee;
        basisReleased = releasedBasis(pos.basis, input.quantity, pos.qty);
        realized = proceeds - basisReleased;
        cashDelta = proceeds;
        newQty = pos.qty - input.quantity;
        newBasis = pos.basis - basisReleased;
      }
      const cashAfter = addCents(cash, cashDelta);

      // 5. Append to the ledgers and update aggregates.
      const [trade] = await tx
        .insert(schema.trades)
        .values({
          userId: input.userId,
          playerId: input.playerId,
          side: input.side,
          quantity: input.quantity,
          priceCents: price,
          grossCents: gross,
          feeCents: fee,
          cashDeltaCents: cashDelta,
          costBasisReleasedCents: basisReleased,
          realizedPnlCents: realized,
          cashAfterCents: cashAfter,
          positionAfterQty: newQty,
          marketVersion,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      await tx.update(schema.cashAccounts).set({ balanceCents: cashAfter, updatedAt: new Date() }).where(eq(schema.cashAccounts.userId, input.userId));
      await tx.insert(schema.cashEntries).values({ userId: input.userId, kind: "trade", amountCents: cashDelta, balanceAfterCents: cashAfter, tradeId: trade.id });
      if (pos) {
        await tx
          .update(schema.positions)
          .set({ quantity: newQty, costBasisCents: newBasis, realizedPnlCents: pos.realized + realized, updatedAt: new Date(), ...(pos.qty === 0 ? { openedAt: new Date() } : {}) })
          .where(and(eq(schema.positions.userId, input.userId), eq(schema.positions.playerId, input.playerId)));
      } else {
        await tx.insert(schema.positions).values({ userId: input.userId, playerId: input.playerId, quantity: newQty, costBasisCents: newBasis, realizedPnlCents: realized });
      }

      // 6. Social side effects (same transaction so they never describe a trade that didn't happen).
      const [player] = await tx.select({ name: schema.players.displayName, slug: schema.players.slug }).from(schema.players).where(eq(schema.players.id, input.playerId));
      await tx.insert(schema.activityEvents).values({
        userId: input.userId,
        kind: "trade",
        payload: { side: input.side, quantity: input.quantity, playerId: input.playerId, playerName: player?.name, playerSlug: player?.slug, priceCents: price },
      });
      const [prefs] = await tx.select({ notifyTrades: schema.users.notifyTrades }).from(schema.users).where(eq(schema.users.id, input.userId));
      if (prefs?.notifyTrades) {
        await tx.insert(schema.notifications).values({
          userId: input.userId,
          kind: "trade",
          title: `${input.side === "buy" ? "Bought" : "Sold"} ${input.quantity} × ${player?.name ?? "player"}`,
          body: `Executed at ${(price / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 })} PC per share.`,
          link: "/portfolio",
        });
      }
      return toReceipt(trade, false);
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // A concurrent request with the same key won the race — return its receipt.
      const t = await findExisting(input.userId, input.idempotencyKey);
      if (t) {
        assertSameOrder(t, input);
        return toReceipt(t, true);
      }
    }
    throw e;
  }
}

/** Indicative quote for the order ticket. Execution price is always re-read at execution. */
export async function quote(userId: string | null, playerId: number) {
  const cfg = env();
  const [row] = await db
    .select({
      priceCents: schema.playerPrices.priceCents,
      marketVersion: schema.marketState.version,
      marketStatus: schema.marketState.status,
      marketReason: schema.marketState.statusReason,
      isTradable: schema.players.isTradable,
      liveFixtureId: schema.playerPrices.liveFixtureId,
      clubId: schema.players.clubId,
    })
    .from(schema.playerPrices)
    .innerJoin(schema.players, eq(schema.players.id, schema.playerPrices.playerId))
    .innerJoin(schema.marketState, eq(schema.marketState.id, 1))
    .where(eq(schema.playerPrices.playerId, playerId));
  if (!row) throw notFound("That player isn't listed on the market.");
  let inPlay = Boolean(row.liveFixtureId);
  if (!inPlay && row.clubId) {
    const same = sameClubIds(row.clubId);
    const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM fixtures WHERE status = 'live' AND (home_club_id IN ${same} OR away_club_id IN ${same})`);
    inPlay = Number(res.rows[0]?.n ?? 0) > 0;
  }
  let block: BlockReason = null;
  if (row.marketStatus === "maintenance") block = "MARKET_MAINTENANCE";
  else if (row.marketStatus !== "open") block = "MARKET_HALTED";
  else if (cfg.LIVE_TRADING_POLICY === "halt" && inPlay) block = "PLAYER_IN_PLAY";
  let cashCents: number | null = null;
  let heldQuantity = 0;
  if (userId) {
    const [acc] = await db.select({ b: schema.cashAccounts.balanceCents }).from(schema.cashAccounts).where(eq(schema.cashAccounts.userId, userId));
    cashCents = acc?.b ?? null;
    const [pos] = await db
      .select({ q: schema.positions.quantity })
      .from(schema.positions)
      .where(and(eq(schema.positions.userId, userId), eq(schema.positions.playerId, playerId)));
    heldQuantity = pos?.q ?? 0;
  }
  return {
    priceCents: row.priceCents,
    marketVersion: row.marketVersion,
    feeBps: cfg.TRADING_FEE_BPS,
    maxQuantity: cfg.MAX_SHARES_PER_ORDER,
    buyBlocked: block ?? (row.isTradable ? null : ("PLAYER_NOT_TRADABLE" as const)),
    sellBlocked: block,
    blockMessage: block === "PLAYER_IN_PLAY" ? "Locked while their match is live." : block ? (row.marketReason ?? "Trading is paused.") : row.isTradable ? null : "No longer listed — sell only.",
    inPlay,
    cashCents,
    heldQuantity,
  };
}
