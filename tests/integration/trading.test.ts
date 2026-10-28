import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@/db";
import { invariantReport } from "@/server/admin/service";
import { getPortfolio } from "@/server/portfolio/valuation";
import { resetPortfolio } from "@/server/portfolio/reset";
import { executeTrade, quote } from "@/server/trading/service";
import { anyPlayer, cash, key, makeUser, position, setMarket } from "./helpers";

afterEach(() => setMarket("open"));
afterAll(() => closeDb());

describe("executing trades", () => {
  it("buys at the server price and updates cash, position and both ledgers atomically", async () => {
    const u = await makeUser("buy");
    const p = await anyPlayer();
    const r = await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 10, idempotencyKey: key() });
    expect(r).toMatchObject({ side: "buy", quantity: 10, priceCents: p.price, grossCents: p.price * 10, feeCents: 0, cashDeltaCents: -p.price * 10, replayed: false });
    expect(await cash(u.id)).toBe(10_000_000 - p.price * 10);
    expect(await position(u.id, p.id)).toMatchObject({ quantity: 10, costBasisCents: p.price * 10 });
    const entries = await db.select().from(schema.cashEntries).where(eq(schema.cashEntries.tradeId, r.id));
    expect(entries[0]).toMatchObject({ kind: "trade", amountCents: -p.price * 10, balanceAfterCents: r.cashAfterCents });
    const market = await db.select().from(schema.marketState);
    expect(r.marketVersion).toBe(market[0].version);
  });

  it("ignores any client-side price — the order executes at the locked server price", async () => {
    const u = await makeUser("price");
    const p = await anyPlayer();
    // Wrong expected price → rejected with the real price, nothing executed.
    const err = await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 1, idempotencyKey: key(), expectedPriceCents: 1 }).catch((e) => e);
    expect(err).toMatchObject({ code: "PRICE_CHANGED", details: { currentPriceCents: p.price } });
    expect(await cash(u.id)).toBe(10_000_000);
  });

  it("rejects buys the user cannot afford", async () => {
    const u = await makeUser("broke");
    const p = await anyPlayer();
    const qty = Math.floor(10_000_000 / p.price) + 1;
    const err = await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: Math.min(qty, 5000), idempotencyKey: key() }).catch((e) => e);
    if (qty <= 5000) expect(err).toMatchObject({ code: "INSUFFICIENT_CASH", status: 422 });
    else expect(err).toMatchObject({ code: "QUANTITY_TOO_LARGE" });
    expect(await cash(u.id)).toBe(10_000_000);
  });

  it("rejects selling more than held and selling unheld players", async () => {
    const u = await makeUser("short");
    const p = await anyPlayer();
    await expect(executeTrade({ userId: u.id, playerId: p.id, side: "sell", quantity: 1, idempotencyKey: key() })).rejects.toMatchObject({ code: "INSUFFICIENT_SHARES" });
    await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 2, idempotencyKey: key() });
    await expect(executeTrade({ userId: u.id, playerId: p.id, side: "sell", quantity: 3, idempotencyKey: key() })).rejects.toMatchObject({ code: "INSUFFICIENT_SHARES" });
    expect((await position(u.id, p.id))!.quantity).toBe(2);
  });

  it("realises profit and loss on sales using proportional cost basis", async () => {
    const u = await makeUser("pnl");
    const p = await anyPlayer({ offset: 3 });
    await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 3, idempotencyKey: key() });
    // Move the price up 10% (as a settlement would) to realise a gain.
    const newPrice = Math.round(p.price * 1.1);
    await db.update(schema.playerPrices).set({ priceCents: newPrice }).where(eq(schema.playerPrices.playerId, p.id));
    const sell = await executeTrade({ userId: u.id, playerId: p.id, side: "sell", quantity: 2, idempotencyKey: key() });
    const basisReleased = Math.round((p.price * 3 * 2) / 3);
    expect(sell.realizedPnlCents).toBe(newPrice * 2 - basisReleased);
    expect(await position(u.id, p.id)).toMatchObject({ quantity: 1, costBasisCents: p.price * 3 - basisReleased, realizedPnlCents: sell.realizedPnlCents });
    const pf = (await getPortfolio(u.id))!;
    expect(pf.totalReturnCents).toBe(pf.realizedCents + pf.unrealizedCents);
    await db.update(schema.playerPrices).set({ priceCents: p.price }).where(eq(schema.playerPrices.playerId, p.id));
  });

  it("is idempotent: a retried order returns the original receipt and trades once", async () => {
    const u = await makeUser("idem");
    const p = await anyPlayer();
    const k = key();
    const a = await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 4, idempotencyKey: k });
    const b = await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 4, idempotencyKey: k });
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
    expect((await position(u.id, p.id))!.quantity).toBe(4);
    await expect(executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 5, idempotencyKey: k })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("handles a double-submitted order racing itself exactly once", async () => {
    const u = await makeUser("race");
    const p = await anyPlayer();
    const k = key();
    const results = await Promise.all(Array.from({ length: 8 }, () => executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 1, idempotencyKey: k })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await position(u.id, p.id))!.quantity).toBe(1);
    expect(await cash(u.id)).toBe(10_000_000 - p.price);
  });

  it("never double-spends under concurrent orders", async () => {
    const u = await makeUser("conc");
    const p = await anyPlayer();
    const affordable = Math.floor(10_000_000 / p.price);
    const per = Math.max(1, Math.ceil(affordable / 5));
    // 12 concurrent orders that together cost far more than the balance.
    const settled = await Promise.allSettled(Array.from({ length: 12 }, () => executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: per, idempotencyKey: key() })));
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    const rejected = settled.filter((s) => s.status === "rejected").map((s) => (s as PromiseRejectedResult).reason.code);
    expect(ok).toBe(Math.floor(affordable / per));
    expect(rejected.every((c) => c === "INSUFFICIENT_CASH")).toBe(true);
    const balance = await cash(u.id);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(10_000_000 - ok * per * p.price);
    expect((await position(u.id, p.id))!.quantity).toBe(ok * per);
  });

  it("concurrent sells cannot sell the same shares twice", async () => {
    const u = await makeUser("csell");
    const p = await anyPlayer();
    await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 5, idempotencyKey: key() });
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => executeTrade({ userId: u.id, playerId: p.id, side: "sell", quantity: 2, idempotencyKey: key() })));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    expect((await position(u.id, p.id))!.quantity).toBe(1);
  });

  it("blocks trading while the market is halted and reports why", async () => {
    const u = await makeUser("halt");
    const p = await anyPlayer();
    await setMarket("halted", "Data outage");
    await expect(executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 1, idempotencyKey: key() })).rejects.toMatchObject({ code: "MARKET_HALTED", status: 423, message: "Data outage" });
    const q = await quote(u.id, p.id);
    expect(q.buyBlocked).toBe("MARKET_HALTED");
  });

  it("locks trading in a player while their match is live", async () => {
    const u = await makeUser("live");
    const p = await anyPlayer();
    const [fx] = await db.select().from(schema.fixtures).where(sql`${schema.fixtures.homeClubId} = ${p.clubId} OR ${schema.fixtures.awayClubId} = ${p.clubId}`).limit(1);
    const prev = fx.status;
    await db.update(schema.fixtures).set({ status: "live" }).where(eq(schema.fixtures.id, fx.id));
    try {
      await expect(executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 1, idempotencyKey: key() })).rejects.toMatchObject({ code: "PLAYER_IN_PLAY" });
    } finally {
      await db.update(schema.fixtures).set({ status: prev }).where(eq(schema.fixtures.id, fx.id));
    }
  });

  it("allows selling but not buying players who are no longer listed", async () => {
    const u = await makeUser("delist");
    const p = await anyPlayer({ offset: 5 });
    await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 2, idempotencyKey: key() });
    await db.update(schema.players).set({ isTradable: false }).where(eq(schema.players.id, p.id));
    try {
      await expect(executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 1, idempotencyKey: key() })).rejects.toMatchObject({ code: "PLAYER_NOT_TRADABLE" });
      await expect(executeTrade({ userId: u.id, playerId: p.id, side: "sell", quantity: 2, idempotencyKey: key() })).resolves.toMatchObject({ positionAfterQty: 0 });
    } finally {
      await db.update(schema.players).set({ isTradable: true }).where(eq(schema.players.id, p.id));
    }
  });
});

describe("ledger integrity", () => {
  it("makes trades and cash entries immutable at the database level", async () => {
    const u = await makeUser("immut");
    const p = await anyPlayer();
    const r = await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 1, idempotencyKey: key() });
    await expect(db.update(schema.trades).set({ priceCents: 1 }).where(eq(schema.trades.id, r.id))).rejects.toThrow();
    await expect(db.delete(schema.trades).where(eq(schema.trades.id, r.id))).rejects.toThrow();
    await expect(db.update(schema.cashEntries).set({ amountCents: 1 }).where(eq(schema.cashEntries.tradeId, r.id))).rejects.toThrow();
    const [t] = await db.select().from(schema.trades).where(eq(schema.trades.id, r.id));
    expect(t.priceCents).toBe(p.price);
  });

  it("keeps every cash balance equal to its ledger and every position equal to its trades", async () => {
    const report = await invariantReport();
    expect(report).toMatchObject({ cashMismatches: 0, positionMismatches: 0, tradesWithoutCashEntry: 0, healthy: true });
  });

  it("resets a demo portfolio through the ledgers, keeping invariants", async () => {
    const u = await makeUser("rst");
    const p = await anyPlayer();
    await executeTrade({ userId: u.id, playerId: p.id, side: "buy", quantity: 7, idempotencyKey: key() });
    await db.update(schema.playerPrices).set({ priceCents: p.price + 100 }).where(eq(schema.playerPrices.playerId, p.id));
    const res = await resetPortfolio(u.id, { kind: "self" });
    await db.update(schema.playerPrices).set({ priceCents: p.price }).where(eq(schema.playerPrices.playerId, p.id));
    expect(res).toMatchObject({ closedPositions: 1, balanceCents: 10_000_000 });
    expect(await cash(u.id)).toBe(10_000_000);
    expect((await position(u.id, p.id))!.quantity).toBe(0);
    expect((await invariantReport()).healthy).toBe(true);
  });
});
