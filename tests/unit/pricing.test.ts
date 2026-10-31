import { describe, expect, it } from "vitest";
import { applyMatch, clampPrice, fundamentalCents, ipoState, livePrice, minutesWeight, PRICING, qualityIndex, replay, roleShare, softStep } from "@/server/market/pricing";
import { scoreMatch } from "@/server/market/scoring";

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

  it("soft-caps moves: ordinary matches unchanged, a bigger haul always moves more", () => {
    const espn = { minutes: 90, saves: 0, goalsConceded: 1, cleanSheet: false, ownGoals: 0, yellowCards: 0, redCards: 0 };
    let fair = { ...ipoState("FWD", null), qualitySum: 3, qualityWeight: 10, formIndex: 0.3, roleSum: 9, roleMatches: 10, matchesPriced: 10 };
    fair = { ...fair, priceCents: fundamentalCents(fair) };
    const move = (goals: number, assists: number, shots: number, sot: number) =>
      applyMatch(fair, scoreMatch({ ...espn, goals, assists, shots, shotsOnTarget: sot }, "FWD").z, 90);
    // Below the knee nothing changes: one goal ≈ +4.5%, as before.
    expect(move(1, 0, 4, 2).ret).toBeCloseTo(move(1, 0, 4, 2).uncappedRet, 12);
    // Every extra goal involvement adds to the move (2→5 G/A used to all be +8%).
    const ladder = [move(1, 1, 4, 2), move(2, 1, 5, 3), move(2, 2, 5, 3), move(3, 2, 6, 4), move(3, 3, 6, 4), move(4, 3, 7, 5)].map((r) => r.ret);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeGreaterThan(ladder[i - 1] + 0.002);
    expect(ladder[2]).toBeGreaterThan(0.1); // 2G 2A clears 10%
    expect(ladder[ladder.length - 1]).toBeLessThan(PRICING.maxStep);
    // Fair value uses the clamped rating, so a freak haul can't run away with it.
    expect(move(3, 2, 6, 4).fundamentalCents).toBe(move(2, 2, 5, 3).fundamentalCents);
  });

  it("rates the same goal involvements higher for defenders, and docks them for conceding", () => {
    const at = (pos: "GK" | "DEF" | "MID" | "FWD") => {
      const s = { ...ipoState(pos, null), qualitySum: 3, qualityWeight: 10, formIndex: 0.3, roleSum: 9, roleMatches: 10, matchesPriced: 10 };
      return { ...s, priceCents: fundamentalCents(s) };
    };
    const ret = (pos: "GK" | "DEF" | "MID" | "FWD", goals: number, assists: number, conceded: number) =>
      applyMatch(at(pos), scoreMatch({ minutes: 90, goals, assists, shots: 1 + goals * 2, shotsOnTarget: goals + 1, saves: 0, goalsConceded: conceded, cleanSheet: conceded === 0, ownGoals: 0, yellowCards: 0, redCards: 0 }, pos).z, 90).ret;
    // 2 goals: defender with a clean sheet > defender who conceded twice > forward.
    expect(ret("DEF", 2, 0, 0)).toBeGreaterThan(ret("DEF", 2, 0, 2) + 0.002);
    expect(ret("DEF", 2, 0, 2)).toBeGreaterThan(ret("FWD", 2, 0, 2) + 0.005);
    expect(ret("MID", 2, 0, 0)).toBeGreaterThan(ret("FWD", 2, 0, 0));
    // Forwards aren't docked for the defence conceding.
    expect(ret("FWD", 2, 0, 4)).toBe(ret("FWD", 2, 0, 0));
    // All of these used to be a flat +8%.
    for (const pos of ["GK", "DEF", "MID", "FWD"] as const) expect(ret(pos, 2, 2, 0)).toBeGreaterThan(0.1);
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

  it("mean-reverts toward fundamental value in the direction of the match", () => {
    const overpriced = { ...base, priceCents: base.priceCents * 2 };
    const r = applyMatch(overpriced, -1, 90);
    expect(r.ret).toBeLessThan(PRICING.beta * -1);
    expect(r.fundamentalCents).toBe(fundamentalCents(r.state));
    // An exactly average match leaves the price where it is.
    expect(applyMatch(overpriced, 0, 90).state.priceCents).toBe(overpriced.priceCents);
  });

  it("scales the catch-up with how far past par the match was (no cliff at par)", () => {
    const lagging = { ...base, priceCents: Math.round(base.priceCents / 2) };
    const justBelow = applyMatch(lagging, -0.05, 90).ret;
    const justAbove = applyMatch(lagging, 0.05, 90).ret;
    expect(justBelow).toBeLessThanOrEqual(0);
    expect(justAbove).toBeGreaterThanOrEqual(0);
    expect(justAbove - justBelow).toBeLessThan(0.01);
    // Full catch-up for a clearly good match.
    const full = applyMatch(lagging, PRICING.reversionFullZ, 90);
    expect(full.ret).toBe(softStep(full.uncappedRet));
    expect(full.uncappedRet).toBeCloseTo(PRICING.beta + PRICING.gamma * Math.log(full.fundamentalCents / lagging.priceCents), 9);
  });

  it("gives a goalless game with many shots on target only a small move (Yamal v Alavés case)", () => {
    // Yamal's stored state on 29 Oct: 2,331.47, fair value ~4,030.
    const yamal = {
      ...ipoState("FWD", null),
      priceCents: 233_147,
      qualitySum: 15.754070110569225,
      qualityWeight: 11.58810252786467,
      formIndex: 0.9632820021567514,
      roleSum: 11.58810252786467,
      roleMatches: 12,
      matchesPriced: 12,
    };
    const espn = { minutes: 90, goals: 0, assists: 0, saves: 0, goalsConceded: 1, cleanSheet: false, ownGoals: 0, yellowCards: 0, redCards: 0 };
    const unlucky = scoreMatch({ ...espn, shots: 8, shotsOnTarget: 6 }, "FWD"); // 4.6 vs 4.4
    const r = applyMatch(yamal, unlucky.z, 90);
    expect(unlucky.z).toBeGreaterThan(0);
    expect(r.ret).toBeGreaterThan(0);
    expect(r.ret).toBeLessThan(0.015); // was +5.95% before the catch-up was scaled
    const goal = applyMatch(yamal, scoreMatch({ ...espn, goals: 1, shots: 4, shotsOnTarget: 2 }, "FWD").z, 90);
    expect(goal.ret).toBeGreaterThan(3 * r.ret);
  });

  it("never moves less after a better match", () => {
    for (const mult of [0.4, 1, 2.5]) {
      const s = { ...base, priceCents: Math.round(base.priceCents * mult) };
      let prev = -Infinity;
      for (let z = -6; z <= 12.0001; z += 0.05) {
        const ret = applyMatch(s, z, 90).ret;
        expect(ret).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = ret;
      }
    }
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
