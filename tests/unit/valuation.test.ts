import { describe, expect, it } from "vitest";
import { summarise } from "@/server/portfolio/valuation";

const row = (over: Partial<Parameters<typeof summarise>[2][number]>) => ({
  playerId: 1,
  slug: "a",
  name: "A",
  firstName: "A",
  lastName: "A",
  position: "FWD",
  club: "ARS",
  quantity: 10,
  costBasisCents: 100_000,
  priceCents: 12_000,
  previousPriceCents: 11_000,
  realizedCents: 0,
  isTradable: true,
  liveFixtureId: null,
  ...over,
});

describe("portfolio valuation", () => {
  it("computes value, unrealized P/L, allocation and average entry", () => {
    const s = summarise(500_000, 10_000_000, [row({}), row({ playerId: 2, slug: "b", name: "B", quantity: 3, costBasisCents: 30_001, priceCents: 9_000 })], 0);
    expect(s.holdingsValueCents).toBe(120_000 + 27_000);
    expect(s.totalValueCents).toBe(500_000 + 147_000);
    expect(s.unrealizedCents).toBe(147_000 - 130_001);
    const b = s.holdings.find((h) => h.slug === "b")!;
    expect(b.avgCostCents).toBe(10_000); // 30,001 / 3 rounded half up
    expect(b.unrealizedCents).toBe(-3_001);
    const alloc = s.holdings.reduce((a, h) => a + h.allocationBps, 0);
    expect(alloc).toBeLessThanOrEqual(10_000);
    expect(s.holdings[0].slug).toBe("a"); // sorted by value
  });

  it("satisfies total return = realized + unrealized when no deposits exist", () => {
    // Start 1,000.00; bought 10 @ 10.00 (basis 100.00); sold 5 @ 14.00 → realized +20.00; price now 12.00.
    const starting = 100_000;
    const cash = starting - 10_000 + 7_000;
    const s = summarise(cash, starting, [row({ quantity: 5, costBasisCents: 5_000, priceCents: 1_200 })], 2_000);
    expect(s.totalReturnCents).toBe(s.realizedCents + s.unrealizedCents);
    expect(s.returnBps).toBe(Math.round(((s.totalValueCents - starting) / starting) * 10_000));
  });
});
