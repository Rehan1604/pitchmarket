/**
 * Public profiles, activity feed and notifications — all filtered by the owner's
 * privacy settings on the server. Emails are never returned; cash balances and
 * holdings only when portfolio visibility allows the viewer.
 */
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { notFound } from "@/server/http";
import { getPortfolio } from "@/server/portfolio/valuation";
import { rankOf } from "@/server/leaderboard/service";
import { friendIds, relationship } from "./friends";

type Visibility = "public" | "friends" | "private";

export function canSee(visibility: Visibility, rel: "self" | "friend" | string): boolean {
  if (rel === "self") return true;
  if (visibility === "public") return true;
  if (visibility === "friends") return rel === "friend";
  return false;
}

export async function getProfile(viewerId: string, username: string) {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(sql`lower(${schema.users.username}) = ${username.toLowerCase()}`, isNull(schema.users.deletedAt)));
  if (!user) throw notFound("No manager with that username.");
  const rel = await relationship(viewerId, user.id);
  const portfolio = await getPortfolio(user.id);
  const showPortfolio = canSee(user.portfolioVisibility, rel.kind);
  const showActivity = canSee(user.activityVisibility, rel.kind);
  const global = user.showOnGlobalLeaderboard ? await rankOf({ kind: "global" }, user.id) : null;
  const commonLeagues = await db.execute<{ id: string; name: string }>(sql`
    SELECT l.id, l.name FROM leagues l
    JOIN league_members a ON a.league_id = l.id AND a.user_id = ${viewerId}::uuid
    JOIN league_members b ON b.league_id = l.id AND b.user_id = ${user.id}::uuid
    WHERE l.archived_at IS NULL ORDER BY l.name`);
  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
      bio: user.bio,
      isDemo: user.isDemo,
      joinedAt: user.createdAt,
      lastActiveAt: rel.kind === "friend" || rel.kind === "self" ? user.lastActiveAt : null,
    },
    relationship: rel,
    globalRank: global,
    // Value/return are leaderboard data: shown if the user is on the global board, or the viewer is a friend / league-mate.
    performance:
      portfolio && (user.showOnGlobalLeaderboard || rel.kind === "friend" || rel.kind === "self" || commonLeagues.rows.length > 0)
        ? { valueCents: portfolio.totalValueCents, returnBps: portfolio.returnBps }
        : null,
    portfolio: showPortfolio && portfolio ? { cashCents: portfolio.cashCents, holdings: portfolio.holdings.map((h) => ({ slug: h.slug, name: h.name, position: h.position, club: h.club, quantity: h.quantity, valueCents: h.valueCents, allocationBps: h.allocationBps, unrealizedBps: h.unrealizedBps })) } : null,
    portfolioHidden: !showPortfolio,
    activity: showActivity ? await activityFor([user.id], 15) : [],
    activityHidden: !showActivity,
    commonLeagues: commonLeagues.rows,
  };
}

export async function activityFor(userIds: string[], limit = 30, before?: Date) {
  if (userIds.length === 0) return [];
  const conds = [inArray(schema.activityEvents.userId, userIds)];
  if (before) conds.push(lt(schema.activityEvents.createdAt, before));
  return db
    .select({
      id: schema.activityEvents.id,
      kind: schema.activityEvents.kind,
      payload: schema.activityEvents.payload,
      createdAt: schema.activityEvents.createdAt,
      username: schema.users.username,
      displayName: schema.users.displayName,
      avatarColor: schema.users.avatarColor,
    })
    .from(schema.activityEvents)
    .innerJoin(schema.users, eq(schema.users.id, schema.activityEvents.userId))
    .where(and(...conds))
    .orderBy(desc(schema.activityEvents.createdAt))
    .limit(Math.min(100, limit));
}

/** The viewer's feed: their own events plus friends whose activity is visible to friends. */
export async function friendsFeed(viewerId: string, limit = 40, before?: Date) {
  const ids = await friendIds(viewerId);
  const visible = ids.length
    ? (
        await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(inArray(schema.users.id, ids), sql`${schema.users.activityVisibility} IN ('public', 'friends')`, isNull(schema.users.deletedAt)))
      ).map((r) => r.id)
    : [];
  return activityFor([viewerId, ...visible], limit, before);
}

export async function listNotifications(userId: string, limit = 40) {
  return db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(Math.min(100, limit));
}

export async function unreadCount(userId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  return r?.n ?? 0;
}

export async function markNotificationsRead(userId: string, ids?: string[]) {
  const conds = [eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)];
  if (ids && ids.length) conds.push(inArray(schema.notifications.id, ids));
  await db.update(schema.notifications).set({ readAt: new Date() }).where(and(...conds));
}
