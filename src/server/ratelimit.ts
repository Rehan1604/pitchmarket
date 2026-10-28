/**
 * Postgres-backed fixed-window rate limiting. Works on serverless without Redis:
 * one atomic upsert per check. Keys are hashed so raw IPs/emails are not stored.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { HttpError } from "./http";

export function hashKey(parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
}

export async function rateLimit(bucket: string, identity: string, limit: number, windowSec: number) {
  const key = `${bucket}:${hashKey([bucket, identity])}`;
  const res = await db.execute<{ count: number; window_start: Date }>(sql`
    INSERT INTO rate_limits (key, window_start, count) VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSec}) THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSec}) THEN now() ELSE rate_limits.window_start END
    RETURNING count, window_start`);
  const row = res.rows[0];
  const count = Number(row.count);
  const resetAt = new Date(new Date(row.window_start).getTime() + windowSec * 1000);
  return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfterSec: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)) };
}

export async function enforceRateLimit(bucket: string, identity: string, limit: number, windowSec: number, message = "Too many attempts. Wait a moment and try again.") {
  const r = await rateLimit(bucket, identity, limit, windowSec);
  if (!r.ok) throw new HttpError(429, "RATE_LIMITED", message, { retryAfterSec: r.retryAfterSec });
}
