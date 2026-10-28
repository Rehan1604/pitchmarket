/**
 * Long-running scheduler for self-hosting (Docker, a VM, Railway, Fly.io…) or
 * local development. It simply calls the same idempotent scheduler tick the
 * cron endpoint uses, every TICK_SECONDS (default 30s). Postgres job locks make
 * it safe to run alongside Vercel Cron / GitHub Actions or multiple workers.
 *
 *   npm run worker
 */
import "dotenv/config";
import { closeDb } from "@/db";
import { runSchedulerTick } from "@/server/ingestion/scheduler";

const TICK_MS = Math.max(10, Number(process.env.TICK_SECONDS ?? 30)) * 1000;
let stopping = false;

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), msg, ...extra }));
}

async function loop() {
  log("worker started", { tickSeconds: TICK_MS / 1000 });
  while (!stopping) {
    const started = Date.now();
    try {
      const res = await runSchedulerTick("worker");
      if (Object.keys(res.jobs).length) log("tick", { ...res, ms: Date.now() - started });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "tick failed", error: e instanceof Error ? e.message : String(e) }));
    }
    const wait = Math.max(1000, TICK_MS - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
  await closeDb();
  log("worker stopped");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`received ${sig}, finishing current tick`);
    stopping = true;
  });
}

void loop();
