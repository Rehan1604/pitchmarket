import { describe, expect, it } from "vitest";
import { decideNextTick, KEEP_AWAKE_LEAD_MINUTES, type FixtureWindow } from "@/server/ingestion/scheduler";

const o = { idleSec: 3600, liveSec: 60 };
const now = Date.parse("2026-11-07T12:00:00Z");
const quiet: FixtureWindow = { live: 0, kickoff: 0, settling: 0, nextKickoff: null };
const inMin = (m: number) => new Date(now + m * 60_000).toISOString();

describe("scheduler timing policy", () => {
  it("polls at the live cadence and keeps the host awake while a match is live", () => {
    expect(decideNextTick({ ...quiet, live: 2 }, "live", now, o)).toEqual({ delaySec: 60, keepAwake: true, reason: "live" });
  });

  it("treats a kickoff within 20 minutes (or overdue) like a live match", () => {
    expect(decideNextTick({ ...quiet, kickoff: 1 }, "live", now, o)).toMatchObject({ delaySec: 60, keepAwake: true, reason: "kickoff" });
  });

  it("checks every five minutes while a finished match awaits settlement", () => {
    expect(decideNextTick({ ...quiet, settling: 1 }, "live", now, o)).toEqual({ delaySec: 300, keepAwake: true, reason: "settling" });
  });

  it("sleeps until 15 minutes before the next kickoff, capped at the idle interval", () => {
    expect(decideNextTick({ ...quiet, nextKickoff: inMin(45) }, "live", now, o)).toEqual({ delaySec: 30 * 60, keepAwake: true, reason: "upcoming" });
    expect(decideNextTick({ ...quiet, nextKickoff: inMin(16) }, "live", now, o).delaySec).toBe(60);
    const far = decideNextTick({ ...quiet, nextKickoff: inMin(6 * 60) }, "live", now, o);
    expect(far).toEqual({ delaySec: 3600, keepAwake: false, reason: "upcoming" });
  });

  it("only keeps the host awake inside the pre-kickoff lead window", () => {
    expect(decideNextTick({ ...quiet, nextKickoff: inMin(KEEP_AWAKE_LEAD_MINUTES) }, "live", now, o).keepAwake).toBe(true);
    expect(decideNextTick({ ...quiet, nextKickoff: inMin(KEEP_AWAKE_LEAD_MINUTES + 1) }, "live", now, o).keepAwake).toBe(false);
  });

  it("never keeps the host awake on the snapshot feed or with nothing scheduled", () => {
    expect(decideNextTick({ ...quiet, live: 3 }, "snapshot", now, o)).toEqual({ delaySec: 3600, keepAwake: false, reason: "snapshot" });
    expect(decideNextTick(quiet, "live", now, o)).toEqual({ delaySec: 3600, keepAwake: false, reason: "idle" });
    expect(decideNextTick(null, "live", now, o).reason).toBe("idle");
  });
});
