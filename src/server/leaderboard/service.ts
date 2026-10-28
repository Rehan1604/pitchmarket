/**
 * Leaderboards — computed on read from persisted portfolios and server prices.
 *
 * Ranking formula: total portfolio value = cash + Σ shares × current price.
 * Everyone starts with the same balance and there are no deposits, so ranking
 * by value is identical to ranking by return on starting capital.
 *  - season: return vs starting balance
 *  - week / day: change vs the user's start-of-day snapshot 7 / 1 day(s) ago
 *    (falls back to starting balance for users who joined after that snapshot)
 * Ties share a rank (1, 2, 2, 4) and are listed by username (deterministic).
 * Movement compares current rank with the rank implied by today's start-of-day
 * snapshots within the same group.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { isoDay, portfolioValuesQuery } from "@/server/portfolio/valuation";

export type Period = "season" | "week" | "day";
export type Scope = { kind: "global" } | { kind: "friends"; userId: string } | { kind: "league"; leagueId: string };

export interface LeaderboardRow {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  isDemo: boolean;
  valueCents: number;
  baselineCents: number;
  changeCents: number;
  changeBps: number;
  totalReturnCents: number;
  totalReturnBps: number;
  movement: number | null;
}

function membershipFilter(scope: Scope): SQL {
  switch (scope.kind) {
    case "global":
      return sql`u.show_on_global_leaderboard = true`;
    case "friends":
      return sql`(u.id = ${scope.userId}::uuid OR u.id IN (
        SELECT user_b_id FROM friendships WHERE user_a_id = ${scope.userId}::uuid
        UNION SELECT user_a_id FROM friendships WHERE user_b_id = ${scope.userId}::uuid))`;
    case "league":
      return sql`u.id IN (SELECT user_id FROM league_members WHERE league_id = ${scope.leagueId}::uuid)`;
  }
}

export async function getLeaderboard(scope: Scope, opts: { period?: Period; limit?: number; offset?: number; now?: Date } = {}) {
  const period = opts.period ?? "season";
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const now = opts.now ?? new Date();
  const today = isoDay(now);
  const baseDay = period === "week" ? isoDay(new Date(now.getTime() - 7 * 86400_000)) : today;

  const res = await db.execute<{
    rank: number;
    total: number;
    user_id: string;
    username: string;
    display_name: string;
    avatar_color: string;
    is_demo: boolean;
    value_cents: string;
    starting_cents: string;
    baseline_cents: string;
    prev_rank: number | null;
  }>(sql`
    WITH vals AS (${portfolioValuesQuery()}),
    members AS (
      SELECT u.id, u.username, u.display_name, u.avatar_color, u.is_demo,
             v.cash_cents + v.holdings_cents AS value_cents, v.starting_cents
      FROM users u JOIN vals v ON v.user_id = u.id
      WHERE u.deleted_at IS NULL AND ${membershipFilter(scope)}
    ),
    base AS (
      SELECT DISTINCT ON (s.user_id) s.user_id, s.value_cents
      FROM portfolio_snapshots s JOIN members m ON m.id = s.user_id
      WHERE s.day <= ${baseDay}
      ORDER BY s.user_id, s.day DESC
    ),
    sod AS (
      SELECT s.user_id, s.value_cents FROM portfolio_snapshots s JOIN members m ON m.id = s.user_id WHERE s.day = ${today}
    ),
    scored AS (
      SELECT m.*,
        CASE WHEN ${period} = 'season' THEN m.starting_cents ELSE COALESCE(b.value_cents, m.starting_cents) END AS baseline_cents,
        COALESCE(sod.value_cents, m.starting_cents) AS sod_value
      FROM members m LEFT JOIN base b ON b.user_id = m.id LEFT JOIN sod ON sod.user_id = m.id
    ),
    ranked AS (
      SELECT scored.*,
        CASE WHEN ${period} = 'season'
          THEN RANK() OVER (ORDER BY value_cents DESC)
          ELSE RANK() OVER (ORDER BY (value_cents - baseline_cents)::numeric / NULLIF(baseline_cents, 0) DESC)
        END AS rank,
        RANK() OVER (ORDER BY sod_value DESC) AS prev_rank,
        COUNT(*) OVER () AS total
      FROM scored
    )
    SELECT rank::int, total::int, id AS user_id, username, display_name, avatar_color, is_demo,
           value_cents, starting_cents, baseline_cents, prev_rank::int
    FROM ranked
    ORDER BY rank ASC, lower(username) ASC
    LIMIT ${limit} OFFSET ${offset}`);

  const hasSnapshots = await snapshotsExist(today);
  const rows: LeaderboardRow[] = res.rows.map((r) => {
    const value = Number(r.value_cents);
    const baseline = Number(r.baseline_cents);
    const starting = Number(r.starting_cents);
    return {
      rank: r.rank,
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      avatarColor: r.avatar_color,
      isDemo: r.is_demo,
      valueCents: value,
      baselineCents: baseline,
      changeCents: value - baseline,
      changeBps: baseline > 0 ? Math.round(((value - baseline) / baseline) * 10_000) : 0,
      totalReturnCents: value - starting,
      totalReturnBps: starting > 0 ? Math.round(((value - starting) / starting) * 10_000) : 0,
      movement: period === "season" && hasSnapshots && r.prev_rank !== null ? r.prev_rank - r.rank : null,
    };
  });
  return { rows, total: res.rows[0]?.total ?? 0, period, limit, offset, computedAt: now.toISOString() };
}

async function snapshotsExist(day: string) {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM portfolio_snapshots WHERE day = ${day}`);
  return Number(res.rows[0]?.n ?? 0) > 0;
}

/** A user's rank within a scope (for dashboard / league cards). */
export async function rankOf(scope: Scope, userId: string) {
  const res = await db.execute<{ rank: number; total: number }>(sql`
    WITH vals AS (${portfolioValuesQuery()}),
    members AS (
      SELECT u.id, v.cash_cents + v.holdings_cents AS value_cents
      FROM users u JOIN vals v ON v.user_id = u.id
      WHERE u.deleted_at IS NULL AND ${membershipFilter(scope)}
    ),
    ranked AS (SELECT id, RANK() OVER (ORDER BY value_cents DESC) AS rank, COUNT(*) OVER () AS total FROM members)
    SELECT rank::int, total::int FROM ranked WHERE id = ${userId}::uuid`);
  const r = res.rows[0];
  return r ? { rank: r.rank, total: r.total } : null;
}
