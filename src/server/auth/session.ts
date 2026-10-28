/**
 * Database-backed sessions. The browser holds a random 256-bit token in an
 * httpOnly, SameSite=Lax cookie; the database stores only its SHA-256, so a
 * leaked sessions table cannot be replayed. Sessions slide forward when used.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/server/env";

export const SESSION_COOKIE = "pm_session";

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createSession(userId: string, userAgent?: string | null) {
  const token = newToken();
  const ttlMs = env().SESSION_TTL_DAYS * 86400_000;
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt, userAgent: userAgent?.slice(0, 200) ?? null });
  return { token, expiresAt };
}

export type SessionUser = Pick<
  typeof schema.users.$inferSelect,
  | "id"
  | "email"
  | "username"
  | "displayName"
  | "role"
  | "isDemo"
  | "avatarColor"
  | "onboardedAt"
  | "portfolioVisibility"
  | "activityVisibility"
  | "showOnGlobalLeaderboard"
  | "notifyTrades"
  | "notifySocial"
  | "notifyRank"
  | "bio"
  | "createdAt"
>;

export async function validateSessionToken(token: string): Promise<{ user: SessionUser; sessionId: string; expiresAt: Date; renewed: boolean } | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: schema.sessions.id,
      expiresAt: schema.sessions.expiresAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      user: {
        id: schema.users.id,
        email: schema.users.email,
        username: schema.users.username,
        displayName: schema.users.displayName,
        role: schema.users.role,
        isDemo: schema.users.isDemo,
        avatarColor: schema.users.avatarColor,
        onboardedAt: schema.users.onboardedAt,
        portfolioVisibility: schema.users.portfolioVisibility,
        activityVisibility: schema.users.activityVisibility,
        showOnGlobalLeaderboard: schema.users.showOnGlobalLeaderboard,
        notifyTrades: schema.users.notifyTrades,
        notifySocial: schema.users.notifySocial,
        notifyRank: schema.users.notifyRank,
        bio: schema.users.bio,
        createdAt: schema.users.createdAt,
        lastActiveAt: schema.users.lastActiveAt,
      },
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now), isNull(schema.users.deletedAt)));
  if (!row) return null;

  const ttlMs = env().SESSION_TTL_DAYS * 86400_000;
  let expiresAt = row.expiresAt;
  let renewed = false;
  if (row.expiresAt.getTime() - now.getTime() < ttlMs / 2) {
    expiresAt = new Date(now.getTime() + ttlMs);
    renewed = true;
    await db.update(schema.sessions).set({ expiresAt, lastSeenAt: now }).where(eq(schema.sessions.id, id));
  } else if (now.getTime() - row.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, id));
  }
  // "Last active" for friends, written at most every 5 minutes.
  if (!row.user.lastActiveAt || now.getTime() - row.user.lastActiveAt.getTime() > 5 * 60_000) {
    await db.update(schema.users).set({ lastActiveAt: now }).where(eq(schema.users.id, row.user.id));
  }
  const { lastActiveAt: _ignored, ...user } = row.user;
  void _ignored;
  return { user, sessionId: id, expiresAt, renewed };
}

export async function invalidateSession(sessionId: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

export async function invalidateUserSessions(userId: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: env().SECURE_COOKIES,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}
