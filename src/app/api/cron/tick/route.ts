import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "@/server/env";
import { json } from "@/server/http";
import { log } from "@/server/log";
import { runSchedulerTick } from "@/server/ingestion/scheduler";

export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Scheduler entry point for Vercel Cron, GitHub Actions or any external cron.
 * Requires `Authorization: Bearer $CRON_SECRET`. Idempotent and lock-protected.
 */
async function handler(req: NextRequest) {
  if (!env().CRON_SECRET) return json({ error: { code: "CRON_NOT_CONFIGURED", message: "Set CRON_SECRET to enable scheduled ingestion." } }, { status: 503 });
  if (!authorised(req)) return json({ error: { code: "UNAUTHENTICATED", message: "Invalid cron credentials." } }, { status: 401 });
  try {
    return json(await runSchedulerTick(req.headers.get("user-agent")?.includes("vercel-cron") ? "vercel-cron" : "cron"));
  } catch (e) {
    log.error("cron tick failed", { error: e instanceof Error ? e.message : String(e) });
    return json({ error: { code: "TICK_FAILED", message: "Scheduler tick failed; see server logs." } }, { status: 500 });
  }
}

export const GET = handler;
export const POST = handler;
