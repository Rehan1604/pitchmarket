/**
 * Daily start-of-day portfolio snapshots (UTC). They power day/week leaderboard
 * views, rank movement and the portfolio value chart. One row per user per day;
 * re-running the job on the same day never overwrites an existing snapshot.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { isoDay, portfolioValuesQuery } from "./valuation";

export async function takeDailySnapshots(now = new Date()) {
  const day = isoDay(now);
  const values = await db.execute<{ user_id: string; cash_cents: string; starting_cents: string; holdings_cents: string }>(portfolioValuesQuery());
  if (values.rows.length === 0) return { items: 0, status: "skipped" as const, details: { day } };

  const existing = await db.select({ userId: schema.portfolioSnapshots.userId }).from(schema.portfolioSnapshots).where(eq(schema.portfolioSnapshots.day, day));
  const done = new Set(existing.map((e) => e.userId));
  const pending = values.rows.filter((r) => !done.has(r.user_id));
  if (pending.length === 0) return { items: 0, status: "skipped" as const, details: { day, reason: "already taken" } };

  // Global rank among users who appear on the global leaderboard.
  const visible = await db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users)
    .where(and(eq(schema.users.showOnGlobalLeaderboard, true), sql`${schema.users.deletedAt} IS NULL`));
  const visibleSet = new Map(visible.map((v) => [v.id, v.username.toLowerCase()]));
  const ranked = values.rows
    .filter((r) => visibleSet.has(r.user_id))
    .map((r) => ({ id: r.user_id, value: Number(r.cash_cents) + Number(r.holdings_cents) }))
    .sort((a, b) => b.value - a.value || visibleSet.get(a.id)!.localeCompare(visibleSet.get(b.id)!));
  const rankOf = new Map<string, number>();
  let rank = 0;
  let prevValue: number | null = null;
  ranked.forEach((r, i) => {
    if (r.value !== prevValue) rank = i + 1;
    prevValue = r.value;
    rankOf.set(r.id, rank);
  });

  await db
    .insert(schema.portfolioSnapshots)
    .values(
      pending.map((r) => ({
        userId: r.user_id,
        day,
        cashCents: Number(r.cash_cents),
        holdingsCents: Number(r.holdings_cents),
        valueCents: Number(r.cash_cents) + Number(r.holdings_cents),
        globalRank: rankOf.get(r.user_id) ?? null,
        takenAt: now,
      })),
    )
    .onConflictDoNothing();

  await notifyRankMoves(day, pending.map((p) => p.user_id), rankOf);
  return { items: pending.length, details: { day } };
}

/** Notify users whose global rank moved ≥ 5 places or who entered the top 10 since the previous snapshot. */
async function notifyRankMoves(day: string, userIds: string[], rankOf: Map<string, number>) {
  if (userIds.length === 0) return;
  const prev = await db.execute<{ user_id: string; global_rank: number | null }>(sql`
    SELECT DISTINCT ON (user_id) user_id, global_rank
    FROM portfolio_snapshots
    WHERE day < ${day} AND user_id IN (${sql.join(userIds.map((u) => sql`${u}::uuid`), sql`, `)})
    ORDER BY user_id, day DESC`);
  const prevRank = new Map(prev.rows.map((r) => [r.user_id, r.global_rank]));
  const optedIn = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(inArray(schema.users.id, userIds), eq(schema.users.notifyRank, true)));
  const notes: (typeof schema.notifications.$inferInsert)[] = [];
  for (const { id } of optedIn) {
    const before = prevRank.get(id);
    const now = rankOf.get(id);
    if (!before || !now || before === now) continue;
    const moved = before - now;
    if (Math.abs(moved) >= 5 || (now <= 10 && before > 10)) {
      notes.push({
        userId: id,
        kind: "rank_change",
        title: moved > 0 ? `You climbed to #${now} globally` : `You slipped to #${now} globally`,
        body: `${Math.abs(moved)} place${Math.abs(moved) === 1 ? "" : "s"} ${moved > 0 ? "up" : "down"} since the last daily snapshot.`,
        link: "/leaderboard",
      });
      await db.insert(schema.activityEvents).values({ userId: id, kind: "rank_change", payload: { from: before, to: now } });
    }
  }
  if (notes.length) await db.insert(schema.notifications).values(notes);
}
