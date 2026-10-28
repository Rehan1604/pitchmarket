import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { conflict, HttpError, notFound } from "@/server/http";

export type Relationship = "self" | "friend" | "pending_out" | "pending_in" | "none";

const ordered = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];

export async function areFriends(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const [x, y] = ordered(a, b);
  const [row] = await db
    .select({ a: schema.friendships.userAId })
    .from(schema.friendships)
    .where(and(eq(schema.friendships.userAId, x), eq(schema.friendships.userBId, y)));
  return Boolean(row);
}

export async function relationship(viewerId: string, otherId: string): Promise<{ kind: Relationship; requestId?: string }> {
  if (viewerId === otherId) return { kind: "self" };
  if (await areFriends(viewerId, otherId)) return { kind: "friend" };
  const [req] = await db
    .select({ id: schema.friendRequests.id, from: schema.friendRequests.fromUserId })
    .from(schema.friendRequests)
    .where(
      and(
        eq(schema.friendRequests.status, "pending"),
        or(
          and(eq(schema.friendRequests.fromUserId, viewerId), eq(schema.friendRequests.toUserId, otherId)),
          and(eq(schema.friendRequests.fromUserId, otherId), eq(schema.friendRequests.toUserId, viewerId)),
        ),
      ),
    );
  if (!req) return { kind: "none" };
  return { kind: req.from === viewerId ? "pending_out" : "pending_in", requestId: req.id };
}

export async function friendIds(userId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT user_b_id AS id FROM friendships WHERE user_a_id = ${userId}::uuid
    UNION SELECT user_a_id AS id FROM friendships WHERE user_b_id = ${userId}::uuid`);
  return rows.rows.map((r) => r.id);
}

export async function searchUsers(viewerId: string, query: string) {
  const q = query.trim().replace(/[%_\\]/g, "");
  if (q.length < 2) return [];
  const rows = await db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName, avatarColor: schema.users.avatarColor, isDemo: schema.users.isDemo })
    .from(schema.users)
    .where(and(isNull(schema.users.deletedAt), or(ilike(schema.users.username, `${q}%`), ilike(schema.users.displayName, `${q}%`))))
    .orderBy(sql`length(${schema.users.username})`, schema.users.username)
    .limit(10);
  return Promise.all(rows.map(async (r) => ({ ...r, relationship: (await relationship(viewerId, r.id)).kind })));
}

async function userByUsername(username: string) {
  const [u] = await db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName, notifySocial: schema.users.notifySocial })
    .from(schema.users)
    .where(and(sql`lower(${schema.users.username}) = ${username.toLowerCase()}`, isNull(schema.users.deletedAt)));
  return u ?? null;
}

export async function sendFriendRequest(fromUserId: string, toUsername: string) {
  const target = await userByUsername(toUsername);
  if (!target) throw notFound("No manager with that username.");
  if (target.id === fromUserId) throw new HttpError(400, "SELF_FRIEND", "You can't add yourself.");
  const rel = await relationship(fromUserId, target.id);
  if (rel.kind === "friend") throw conflict("ALREADY_FRIENDS", `You're already friends with ${target.displayName}.`);
  if (rel.kind === "pending_out") throw conflict("REQUEST_PENDING", "Your request is already waiting for a reply.");
  if (rel.kind === "pending_in" && rel.requestId) {
    // They already asked you — accept instead of creating a mirror request.
    await respondToFriendRequest(fromUserId, rel.requestId, true);
    return { status: "accepted" as const };
  }
  const [from] = await db.select({ displayName: schema.users.displayName, username: schema.users.username }).from(schema.users).where(eq(schema.users.id, fromUserId));
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.friendRequests).values({ fromUserId, toUserId: target.id });
      if (target.notifySocial) {
        await tx.insert(schema.notifications).values({
          userId: target.id,
          kind: "friend_request",
          title: `${from.displayName} sent you a friend request`,
          body: `@${from.username} wants to compare portfolios.`,
          link: "/social",
        });
      }
    });
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if (err.code === "23505" || err.cause?.code === "23505") throw conflict("REQUEST_PENDING", "A request between you two is already pending.");
    throw e;
  }
  return { status: "sent" as const };
}

export async function respondToFriendRequest(userId: string, requestId: string, accept: boolean) {
  return db.transaction(async (tx) => {
    const res = await tx.execute<{ id: string; from_user_id: string; to_user_id: string; status: string }>(
      sql`SELECT id, from_user_id, to_user_id, status FROM friend_requests WHERE id = ${requestId}::uuid FOR UPDATE`,
    );
    const req = res.rows[0];
    // Only the recipient may answer; anything else looks like "not found" (no IDOR leak).
    if (!req || req.to_user_id !== userId || req.status !== "pending") throw notFound("That friend request no longer exists.");
    await tx
      .update(schema.friendRequests)
      .set({ status: accept ? "accepted" : "declined", respondedAt: new Date() })
      .where(eq(schema.friendRequests.id, requestId));
    if (accept) {
      const [a, b] = ordered(req.from_user_id, req.to_user_id);
      await tx.insert(schema.friendships).values({ userAId: a, userBId: b }).onConflictDoNothing();
      const [me] = await tx.select({ displayName: schema.users.displayName, username: schema.users.username }).from(schema.users).where(eq(schema.users.id, userId));
      const [sender] = await tx.select({ notifySocial: schema.users.notifySocial }).from(schema.users).where(eq(schema.users.id, req.from_user_id));
      if (sender?.notifySocial) {
        await tx.insert(schema.notifications).values({
          userId: req.from_user_id,
          kind: "friend_accepted",
          title: `${me.displayName} accepted your friend request`,
          link: `/u/${me.username}`,
        });
      }
      await tx.insert(schema.activityEvents).values([
        { userId, kind: "friend", payload: { withUserId: req.from_user_id } },
        { userId: req.from_user_id, kind: "friend", payload: { withUserId: userId } },
      ]);
    }
    return { status: accept ? ("accepted" as const) : ("declined" as const) };
  });
}

export async function cancelFriendRequest(userId: string, requestId: string) {
  const res = await db
    .update(schema.friendRequests)
    .set({ status: "cancelled", respondedAt: new Date() })
    .where(and(eq(schema.friendRequests.id, requestId), eq(schema.friendRequests.fromUserId, userId), eq(schema.friendRequests.status, "pending")))
    .returning({ id: schema.friendRequests.id });
  if (res.length === 0) throw notFound("That friend request no longer exists.");
}

export async function removeFriend(userId: string, friendUsername: string) {
  const other = await userByUsername(friendUsername);
  if (!other) throw notFound("No manager with that username.");
  const [a, b] = ordered(userId, other.id);
  const res = await db
    .delete(schema.friendships)
    .where(and(eq(schema.friendships.userAId, a), eq(schema.friendships.userBId, b)))
    .returning({ a: schema.friendships.userAId });
  if (res.length === 0) throw notFound("You're not friends with that manager.");
  await audit({ userId, actor: "user", action: "friend.removed", entityType: "user", entityId: other.id });
}

export async function listFriends(userId: string) {
  const ids = await friendIds(userId);
  if (ids.length === 0) return [];
  return db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName, avatarColor: schema.users.avatarColor, lastActiveAt: schema.users.lastActiveAt, isDemo: schema.users.isDemo })
    .from(schema.users)
    .where(and(sql`${schema.users.id} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`, isNull(schema.users.deletedAt)))
    .orderBy(schema.users.username);
}

export async function listFriendRequests(userId: string) {
  const incoming = await db
    .select({ id: schema.friendRequests.id, createdAt: schema.friendRequests.createdAt, username: schema.users.username, displayName: schema.users.displayName, avatarColor: schema.users.avatarColor })
    .from(schema.friendRequests)
    .innerJoin(schema.users, eq(schema.users.id, schema.friendRequests.fromUserId))
    .where(and(eq(schema.friendRequests.toUserId, userId), eq(schema.friendRequests.status, "pending")))
    .orderBy(desc(schema.friendRequests.createdAt));
  const outgoing = await db
    .select({ id: schema.friendRequests.id, createdAt: schema.friendRequests.createdAt, username: schema.users.username, displayName: schema.users.displayName, avatarColor: schema.users.avatarColor })
    .from(schema.friendRequests)
    .innerJoin(schema.users, eq(schema.users.id, schema.friendRequests.toUserId))
    .where(and(eq(schema.friendRequests.fromUserId, userId), eq(schema.friendRequests.status, "pending")))
    .orderBy(desc(schema.friendRequests.createdAt));
  return { incoming, outgoing };
}
