/**
 * Portfolio reset — only in APP_MODE=demo (self-service) or by an admin.
 * The ledgers stay append-only: holdings are closed with zero-fee "reset" sell
 * trades at the current price, then a `reset` cash entry restores the starting
 * balance. Fully audited and rate-limited by the caller.
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { releasedBasis } from "@/lib/money";

export async function resetPortfolio(userId: string, actor: { kind: "self" } | { kind: "admin"; adminId: string }) {
  if (actor.kind === "self" && env().APP_MODE !== "demo") {
    throw new HttpError(403, "RESET_DISABLED", "Portfolio resets are only available on demo instances.");
  }
  return db.transaction(async (tx) => {
    const m = await tx.execute<{ version: string }>(sql`SELECT version FROM market_state WHERE id = 1 FOR SHARE`);
    const version = Number(m.rows[0]?.version ?? 0);
    const acc = await tx.execute<{ balance_cents: string; starting_cents: string }>(sql`SELECT balance_cents, starting_cents FROM cash_accounts WHERE user_id = ${userId} FOR UPDATE`);
    if (!acc.rows[0]) throw new HttpError(404, "NOT_FOUND", "No trading account.");
    let cash = Number(acc.rows[0].balance_cents);
    const starting = Number(acc.rows[0].starting_cents);
    const held = await tx.execute<{ player_id: number; quantity: number; cost_basis_cents: string; price_cents: string }>(sql`
      SELECT p.player_id, p.quantity, p.cost_basis_cents, pp.price_cents
      FROM positions p JOIN player_prices pp ON pp.player_id = p.player_id
      WHERE p.user_id = ${userId} AND p.quantity > 0 FOR UPDATE OF p`);
    const stamp = Date.now();
    for (const h of held.rows) {
      const qty = Number(h.quantity);
      const price = Number(h.price_cents);
      const gross = qty * price;
      const basis = releasedBasis(Number(h.cost_basis_cents), qty, qty);
      cash += gross;
      const [trade] = await tx
        .insert(schema.trades)
        .values({
          userId,
          playerId: h.player_id,
          side: "sell",
          quantity: qty,
          priceCents: price,
          grossCents: gross,
          feeCents: 0,
          cashDeltaCents: gross,
          costBasisReleasedCents: basis,
          realizedPnlCents: gross - basis,
          cashAfterCents: cash,
          positionAfterQty: 0,
          marketVersion: version,
          idempotencyKey: `reset:${stamp}:${h.player_id}`,
        })
        .returning({ id: schema.trades.id });
      await tx.insert(schema.cashEntries).values({ userId, kind: "trade", amountCents: gross, balanceAfterCents: cash, tradeId: trade.id, note: "Closed by portfolio reset" });
    }
    await tx.execute(sql`UPDATE positions SET quantity = 0, cost_basis_cents = 0, realized_pnl_cents = 0, updated_at = now() WHERE user_id = ${userId}`);
    const adjust = starting - cash;
    await tx.insert(schema.cashEntries).values({ userId, kind: "reset", amountCents: adjust, balanceAfterCents: starting, note: "Portfolio reset to starting balance" });
    await tx.update(schema.cashAccounts).set({ balanceCents: starting, updatedAt: new Date() }).where(eq(schema.cashAccounts.userId, userId));
    await tx.execute(sql`DELETE FROM portfolio_snapshots WHERE user_id = ${userId}`);
    await audit(
      { userId, actor: actor.kind === "admin" ? "admin" : "user", action: "portfolio.reset", metadata: { closedPositions: held.rows.length, adjustCents: adjust, ...(actor.kind === "admin" ? { adminId: actor.adminId } : {}) } },
      tx,
    );
    return { closedPositions: held.rows.length, balanceCents: starting };
  });
}
