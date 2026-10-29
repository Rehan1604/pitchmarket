import { describe, expect, it } from "vitest";
import { applyMatch, clampPrice, fundamentalCents, ipoState, livePrice, minutesWeight, PRICING, qualityIndex, replay, roleShare } from "@/server/market/pricing";

const star = { quality: 0.8, weight: 34, role: 0.9, roleMatches: 38 };
const squad = { quality: -0.2, weight: 6, role: 0.2, roleMatches: 30 };

describe("IPO pricing", () => {
  it("is deterministic and within readable bounds", () => {
    const a = ipoState("FWD", star);
    const b = ipoState("FWD", star);
    expect(a).toEqual(b);
    expect(a.priceCents).toBeGreaterThanOrEqual(PRICING.minPriceCents);
    expect(a.priceCents).toBeLessThanOrEqual(PRICING.maxPriceCents);
  });

  it("prices proven regular starters above fringe players", () => {
    expect(ipoState("FWD", star).priceCents).toBeGreaterThan(ipoState("FWD", squad).priceCents);
    expect(ipoState("MID", star).priceCents).toBeGreaterThan(2 * ipoState("MID", squad).priceCents);
  });

  it("gives players without history the positional base price", () => {
    expect(ipoState("MID", null).priceCents).toBe(PRICING.baseCredits.MID * 100);
  });

  it("shrinks small samples toward average quality", () => {
    const tiny = ipoState("DEF", { quality: 1.5, weight: 1, role: 1, roleMatches: 1 });
    const proven = ipoState("DEF", { quality: 1.5, weight: 30, role: 1, roleMatches: 38 });
    expect(qualityIndex(tiny)).toBeLessThan(qualityIndex(proven));
  });
});

describe("match price steps", () => {
  const base = ipoState("FWD", star);

  it("rises after a strong performance and falls after a poor one", () => {
    expect(applyMatch(base, 2.5, 90).state.priceCents).toBeGreaterThan(base.priceCents);
    expect(applyMatch(base, -2, 90).state.priceCents).toBeLessThan(base.priceCents);
  });

  it("caps any single move at ±maxStep", () => {
    const up = applyMatch(base, 4, 90);
    const down = applyMatch(base, -3, 90);
    expect(up.ret).toBeLessThanOrEqual(PRICING.maxStep + 1e-12);
    expect(down.ret).toBeGreaterThanOrEqual(-PRICING.maxStep - 1e-12);
    expect(up.state.priceCents).toBeLessThanOrEqual(Math.round(base.priceCents * (1 + PRICING.maxStep)));
  });

  it("does not move the price of a player who did not play", () => {
    const r = applyMatch(base, 0, 0);
    expect(r.state.priceCents).toBe(base.priceCents);
    expect(r.played).toBe(false);
    expect(r.state.roleMatches).toBe(base.roleMatches + 1);
  });

  it("does not crash a price after a long absence", () => {
    let s = base;
    for (let i = 0; i < 15; i++) s = applyMatch(s, 0, 0).state;
    expect(s.priceCents).toBe(base.priceCents);
    // Returning with an average game only drifts gradually toward the lower fundamental.
    const back = applyMatch(s, 0, 90);
    expect(back.state.priceCents).toBeGreaterThan(base.priceCents * (1 - PRICING.maxStep) - 1);
    expect(roleShare(s)).toBeLessThan(roleShare(base));
  });

  it("weights cameo appearances less than full matches", () => {
    expect(minutesWeight(90)).toBe(1);
    expect(minutesWeight(10)).toBeLessThan(0.4);
    const cameo = applyMatch(base, 2, 10).state.priceCents - base.priceCents;
    const full = applyMatch(base, 2, 90).state.priceCents - base.priceCents;
    expect(cameo).toBeLessThan(full);
  });

  it("mean-reverts toward fundamental value", () => {
    const overpriced = { ...base, priceCents: base.priceCents * 2 };
    const r = applyMatch(overpriced, 0, 90);
    expect(r.state.priceCents).toBeLessThan(overpriced.priceCents);
    expect(r.fundamentalCents).toBe(fundamentalCents(r.state));
  });

  it("never raises a price after a below-par match, even far below fair value", () => {
    // Regression: Yamal, Barcelona 1-2 Real Madrid. Price 2,229.95, fair value ~4,030,
    // z = -0.73 over 90'. The catch-up term used to outweigh the match and gave +4.55%.
    const z = -0.7282;
    const lam = 1 - Math.pow(0.5, 1 / PRICING.formHalfLifeMatches);
    const lagging = {
      ...ipoState("FWD", null),
      priceCents: 222_995,
      qualitySum: 15.754070110569225 - z,
      qualityWeight: 10.58810252786467,
      formIndex: (0.9632820021567514 - z * lam) / (1 - lam),
      roleSum: 10.58810252786467,
      roleMatches: 11,
      matchesPriced: 11,
    };
    const bad = applyMatch(lagging, z, 90);
    expect(bad.fundamentalCents).toBe(402_992); // the stored fair value after that match
    // Old rule: 0.035·z + 0.12·ln(F/P) = +4.55% → 2,331.47.
    expect(Math.round(lagging.priceCents * (1 + PRICING.beta * z + PRICING.gamma * Math.log(bad.fundamentalCents / lagging.priceCents)))).toBe(233_147);
    expect(bad.ret).toBeCloseTo(PRICING.beta * z, 6);
    expect(bad.state.priceCents).toBe(217_312);
    // A good match still gets the full catch-up.
    expect(applyMatch(lagging, 0.9, 90).ret).toBeGreaterThan(PRICING.beta * 0.9);
  });

  it("never lowers a price after an above-par match, even far above fair value", () => {
    const overpriced = { ...base, priceCents: base.priceCents * 2 };
    const good = applyMatch(overpriced, 0.6, 90);
    expect(good.ret).toBeGreaterThan(0);
    expect(good.ret).toBeCloseTo(PRICING.beta * 0.6, 6);
    // A poor match there falls by more than the match alone.
    expect(applyMatch(overpriced, -0.6, 90).ret).toBeLessThan(PRICING.beta * -0.6);
  });

  it("always moves in the direction of the match", () => {
    for (const mult of [0.3, 0.7, 1, 1.6, 3]) {
      const s = { ...base, priceCents: Math.round(base.priceCents * mult) };
      for (const z of [-3, -1, -0.2, -0.01, 0.01, 0.2, 1, 4]) {
        for (const minutes of [5, 45, 90]) {
          const r = applyMatch(s, z, minutes);
          if (z > 0) expect(r.state.priceCents).toBeGreaterThanOrEqual(s.priceCents);
          else expect(r.state.priceCents).toBeLessThanOrEqual(s.priceCents);
        }
      }
    }
  });

  it("clamps prices to configured bounds", () => {
    expect(clampPrice(1)).toBe(PRICING.minPriceCents);
    expect(clampPrice(10 ** 12)).toBe(PRICING.maxPriceCents);
  });
});

describe("live provisional pricing", () => {
  const settled = ipoState("MID", star);

  it("never compounds across repeated polls of the same live stats", () => {
    const first = livePrice(settled, 1.5, 55);
    const again = livePrice(settled, 1.5, 55);
    expect(again).toBe(first);
  });

  it("converges to the settlement price for the same final stats", () => {
    expect(livePrice(settled, 1.2, 90)).toBe(applyMatch(settled, 1.2, 90).state.priceCents);
    expect(livePrice(settled, 1.2, 0)).toBe(settled.priceCents);
  });
});

describe("replay", () => {
  it("reproduces the same path from recorded matches", () => {
    const ipo = ipoState("DEF", squad);
    const matches = [
      { z: 0.4, minutes: 90 },
      { z: -1.1, minutes: 90 },
      { z: 0, minutes: 0 },
      { z: 2.2, minutes: 70 },
      { z: 0.1, minutes: 12 },
    ];
    const a = replay(ipo, matches);
    const b = replay(ipo, matches);
    expect(a.path).toEqual(b.path);
    expect(a.path).toHaveLength(matches.length + 1);
    expect(a.path[3]).toBe(a.path[2]); // 0 minutes → unchanged
    expect(a.final.matchesPriced).toBe(4);
  });
});
