import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, scoreMatch, scoredStats, statsFingerprint, type MatchStats } from "@/server/market/scoring";

const full = (over: Partial<MatchStats> = {}): MatchStats => ({
  minutes: 90,
  goals: 0,
  assists: 0,
  xg: 0.1,
  xa: 0.05,
  tackles: 1,
  cbi: 2,
  recoveries: 4,
  saves: 0,
  cleanSheet: false,
  goalsConceded: 1,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  ...over,
});

describe("match performance scoring", () => {
  it("uses baselines derived from real data", () => {
    expect(DEFAULT_MODEL.sigma.FWD).toBeGreaterThan(1);
    expect(DEFAULT_MODEL.ratesPer90.FWD.goals).toBeGreaterThan(DEFAULT_MODEL.ratesPer90.DEF.goals!);
    expect(DEFAULT_MODEL.ratesPer90.GK.saves).toBeGreaterThan(1);
  });

  it("rewards a striker who scores and assists", () => {
    const quiet = scoreMatch(full(), "FWD");
    const brace = scoreMatch(full({ goals: 2, assists: 1, xg: 1.4, xa: 0.4 }), "FWD");
    expect(brace.z).toBeGreaterThan(1);
    expect(brace.z).toBeGreaterThan(quiet.z);
    expect(brace.breakdown.goals).toBe(8);
  });

  it("rewards a creative midfielder without a goal", () => {
    const s = scoreMatch(full({ assists: 2, xa: 0.9, tackles: 4, recoveries: 9 }), "MID");
    expect(s.breakdown.goals).toBeUndefined();
    expect(s.z).toBeGreaterThan(0.5);
  });

  it("rewards a defender's clean sheet and defensive work", () => {
    const cs = scoreMatch(full({ cleanSheet: true, goalsConceded: 0, tackles: 5, cbi: 9 }), "DEF");
    const leaky = scoreMatch(full({ cleanSheet: false, goalsConceded: 4, tackles: 1, cbi: 2 }), "DEF");
    expect(cs.z).toBeGreaterThan(0.5);
    expect(leaky.z).toBeLessThan(0);
  });

  it("rewards a goalkeeper's saves and clean sheet", () => {
    const busy = scoreMatch(full({ saves: 8, cleanSheet: true, goalsConceded: 0, xg: 0, xa: 0 }), "GK");
    expect(busy.z).toBeGreaterThan(1);
    expect(busy.breakdown.saves).toBe(4);
  });

  it("penalises red cards and own goals", () => {
    const base = scoreMatch(full(), "DEF");
    const bad = scoreMatch(full({ redCards: 1, ownGoals: 1 }), "DEF");
    expect(bad.z).toBeLessThan(base.z);
    expect(bad.breakdown.redCards).toBe(-3);
  });

  it("returns a neutral result for a player who did not play", () => {
    expect(scoreMatch(full({ minutes: 0 }), "FWD")).toMatchObject({ score: 0, expected: 0, z: 0 });
  });

  it("never treats missing statistics as zero", () => {
    // Same match, but the provider does not supply xG, tackles, CBI or recoveries.
    const withAll = full({ goals: 0, xg: 0, xa: 0, tackles: 0, cbi: 0, recoveries: 0 });
    const missing: MatchStats = { ...withAll, xg: null, xa: null, tackles: null, cbi: null, recoveries: null };
    const a = scoreMatch(withAll, "MID");
    const b = scoreMatch(missing, "MID");
    expect(b.excluded).toEqual(expect.arrayContaining(["xg", "xa", "tackles", "recoveries"]));
    // Zero defensive work is below expectation; unknown defensive work is simply not judged.
    expect(b.z).toBeGreaterThan(a.z);
    expect(b.expected).toBeLessThan(a.expected);
  });

  it("does not double count combined CBI when separate stats exist", () => {
    const stats = full({ interceptions: 3, clearances: 5, cbi: 10 });
    expect(scoredStats(stats)).not.toContain("cbi");
    expect(scoredStats(full())).toContain("cbi");
  });

  it("only credits clean sheets after 60 minutes and clamps z", () => {
    const cameo = scoreMatch(full({ minutes: 30, cleanSheet: true, goalsConceded: 0 }), "DEF");
    expect(cameo.breakdown.cleanSheet).toBeUndefined();
    const absurd = scoreMatch(full({ goals: 9, assists: 5, xg: 6 }), "FWD");
    expect(absurd.z).toBe(4);
  });

  it("fingerprints are stable and sensitive to stat changes", () => {
    expect(statsFingerprint(full())).toBe(statsFingerprint(full()));
    expect(statsFingerprint(full({ goals: 1 }))).not.toBe(statsFingerprint(full()));
    expect(statsFingerprint(full({ xg: null }))).not.toBe(statsFingerprint(full({ xg: 0 })));
  });
});
