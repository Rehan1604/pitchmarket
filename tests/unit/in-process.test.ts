import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CycleResult, TickPlan } from "@/server/ingestion/scheduler";

const plans: TickPlan[] = [];
vi.mock("@/server/ingestion/scheduler", () => ({
  runSchedulerTick: vi.fn(async (): Promise<CycleResult> => ({ provider: "fpl", mode: "live", jobs: {}, next: plans.shift() ?? { delaySec: 3600, keepAwake: false, reason: "idle" } })),
}));

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

describe("in-process scheduler", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    process.env.DATABASE_URL ??= "postgres://unused";
    process.env.KEEPALIVE_URL = "https://pitchmarket.example.com";
    (await import("@/server/env")).resetEnvCache();
  });
  afterEach(async () => {
    (await import("@/server/ingestion/in-process")).stopInProcessScheduler();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.KEEPALIVE_URL;
  });

  it("follows the planned delays and pings /api/health only while a match needs it", async () => {
    const { runSchedulerTick } = await import("@/server/ingestion/scheduler");
    const { startInProcessScheduler } = await import("@/server/ingestion/in-process");
    plans.push(
      { delaySec: 3600, keepAwake: false, reason: "upcoming" },
      { delaySec: 60, keepAwake: true, reason: "live" },
      { delaySec: 60, keepAwake: true, reason: "live" },
    );
    startInProcessScheduler({ initialDelayMs: 1000 });
    startInProcessScheduler(); // idempotent per process

    await vi.advanceTimersByTimeAsync(1000);
    expect(runSchedulerTick).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled(); // idle: let the host sleep

    await vi.advanceTimersByTimeAsync(3600_000);
    expect(runSchedulerTick).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // live: keep awake
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://pitchmarket.example.com/api/health");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSchedulerTick).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(1); // throttled to one ping per 10 minutes
  });
});
