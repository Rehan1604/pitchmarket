/**
 * In-process scheduler for single-instance hosts (Render, a VM, Docker). It
 * runs the same idempotent tick as /api/cron/tick and `npm run worker`, so it
 * is safe to combine with either — Postgres job locks prevent double work.
 *
 * Timing adapts to the fixture list (see planNextTick): every LIVE_POLL_SECONDS
 * around matches, otherwise it waits until shortly before the next kickoff.
 * While a match is live, imminent or settling it pings the public /api/health
 * URL (no database) so sleep-on-idle hosts stay awake for live pricing; the
 * rest of the week the host and the database are free to sleep.
 */
import { env } from "@/server/env";
import { log } from "@/server/log";
import { runSchedulerTick } from "./scheduler";

const KEEPALIVE_EVERY_MS = 10 * 60_000; // Render free sleeps after 15 idle minutes
const RETRY_AFTER_ERROR_SEC = 120;

type State = { timer?: ReturnType<typeof setTimeout>; lastPing: number; stopped: boolean };
const g = globalThis as typeof globalThis & { __pitchmarketScheduler?: State };

async function ping(url: string) {
  try {
    const res = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    log.debug("keep-alive ping", { status: res.status });
  } catch (e) {
    log.warn("keep-alive ping failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

export function startInProcessScheduler(opts: { initialDelayMs?: number } = {}) {
  if (g.__pitchmarketScheduler) return; // once per process (also survives dev hot reloads)
  const e = env();
  const keepAliveUrl = e.KEEP_AWAKE_DURING_MATCHES ? (e.KEEPALIVE_URL ?? e.RENDER_EXTERNAL_URL) : undefined;
  const state: State = { lastPing: 0, stopped: false };
  g.__pitchmarketScheduler = state;

  const schedule = (sec: number) => {
    if (state.stopped) return;
    state.timer = setTimeout(tick, sec * 1000);
    state.timer.unref?.();
  };

  const tick = async () => {
    const started = Date.now();
    let delaySec = RETRY_AFTER_ERROR_SEC;
    let keepAwake = false;
    try {
      const res = await runSchedulerTick("in-process");
      delaySec = res.next.delaySec;
      keepAwake = res.next.keepAwake;
      if (Object.keys(res.jobs).length) log.info("scheduler tick", { ...res, ms: Date.now() - started });
    } catch (err) {
      log.error("scheduler tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
    if (keepAwake && keepAliveUrl && Date.now() - state.lastPing >= KEEPALIVE_EVERY_MS) {
      state.lastPing = Date.now();
      void ping(keepAliveUrl);
    }
    schedule(delaySec);
  };

  log.info("in-process scheduler started", { keepAlive: Boolean(keepAliveUrl) });
  state.timer = setTimeout(tick, opts.initialDelayMs ?? 5_000);
  state.timer.unref?.();
}

export function stopInProcessScheduler() {
  const state = g.__pitchmarketScheduler;
  if (!state) return;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  delete g.__pitchmarketScheduler;
}
