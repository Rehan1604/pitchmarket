/**
 * Account lifecycle: sign-up (with the starting virtual balance), sign-in,
 * password reset and privacy-preserving deletion. Framework-independent so it
 * can be integration-tested directly against Postgres.
 */
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { env } from "@/server/env";
import { conflict, HttpError } from "@/server/http";
import { log } from "@/server/log";
import { creditsToCents } from "@/lib/money";
import { burnVerifyTime, hashPassword, passwordProblems, verifyPassword } from "./password";
import { createSession, invalidateUserSessions, newToken, sha256 } from "./session";
import { sendEmail } from "@/server/email";

const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "help", "pitchmarket", "api", "null", "undefined",
  "moderator", "staff", "official", "security", "billing", "settings", "login", "signup", "me",
]);

export const AVATAR_COLORS = ["#3DDC97", "#D4F55C", "#7CC6FE", "#F2B544", "#FF8A7A", "#C79BFF", "#5EEAD4", "#F0A6CA"];

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,20}$/, "Use 3–20 letters, numbers or underscores.")
  .refine((u) => !RESERVED.has(u.toLowerCase()), "That username is reserved.");

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(254)),
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(40).optional(),
  password: z.string().min(1).max(128),
  acceptTerms: z.literal(true, { error: "Confirm you understand PITCHMARKET uses virtual credits only." }),
});

export type SignupInput = z.infer<typeof signupSchema>;

export async function signup(input: SignupInput, meta: { userAgent?: string | null } = {}) {
  const problem = passwordProblems(input.password, { email: input.email, username: input.username });
  if (problem) throw new HttpError(400, "WEAK_PASSWORD", problem);

  const [taken] = await db
    .select({ email: schema.users.email, username: schema.users.username })
    .from(schema.users)
    .where(or(sql`lower(${schema.users.email}) = ${input.email.toLowerCase()}`, sql`lower(${schema.users.username}) = ${input.username.toLowerCase()}`))
    .limit(1);
  if (taken) {
    if (taken.username.toLowerCase() === input.username.toLowerCase()) throw conflict("USERNAME_TAKEN", "That username is taken. Try another.");
    throw conflict("EMAIL_UNAVAILABLE", "That email can't be used. If it's yours, sign in or reset your password.");
  }

  const passwordHash = await hashPassword(input.password);
  const startingCents = creditsToCents(env().STARTING_BALANCE_CREDITS);
  // Accounts are never auto-promoted (email ownership isn't verified); admins are granted via `npm run admin:grant`.
  const role = "user" as const;
  const color = AVATAR_COLORS[Math.abs(hashCode(input.username)) % AVATAR_COLORS.length];

  let userId: string;
  try {
    userId = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(schema.users)
        .values({
          email: input.email,
          username: input.username,
          displayName: input.displayName || input.username,
          passwordHash,
          role,
          avatarColor: color,
          isDemo: false,
        })
        .returning({ id: schema.users.id });
      await tx.insert(schema.cashAccounts).values({ userId: user.id, balanceCents: startingCents, startingCents });
      await tx.insert(schema.cashEntries).values({ userId: user.id, kind: "grant", amountCents: startingCents, balanceAfterCents: startingCents, note: "Starting virtual balance" });
      await audit({ userId: user.id, actor: "user", action: "user.signup", metadata: { role } }, tx);
      return user.id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("USERNAME_TAKEN", "That username or email is already registered.");
    throw e;
  }
  const session = await createSession(userId, meta.userAgent);
  return { userId, session };
}

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

const GENERIC_LOGIN_ERROR = "That email/username and password don't match.";

export async function login(input: z.infer<typeof loginSchema>, meta: { userAgent?: string | null } = {}) {
  const ident = input.identifier.toLowerCase();
  const [user] = await db
    .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(and(isNull(schema.users.deletedAt), or(sql`lower(${schema.users.email}) = ${ident}`, sql`lower(${schema.users.username}) = ${ident}`)))
    .limit(1);
  if (!user) {
    await burnVerifyTime(input.password);
    await audit({ actor: "user", action: "auth.login_failed", metadata: { reason: "unknown_identifier" } });
    throw new HttpError(401, "INVALID_CREDENTIALS", GENERIC_LOGIN_ERROR);
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    await audit({ userId: user.id, actor: "user", action: "auth.login_failed", metadata: { reason: "bad_password" } });
    throw new HttpError(401, "INVALID_CREDENTIALS", GENERIC_LOGIN_ERROR);
  }
  await db.update(schema.users).set({ lastActiveAt: new Date() }).where(eq(schema.users.id, user.id));
  await audit({ userId: user.id, actor: "user", action: "auth.login" });
  const session = await createSession(user.id, meta.userAgent);
  return { userId: user.id, session };
}

const RESET_TTL_MS = 60 * 60_000;

/** Always resolves the same way whether or not the account exists (no enumeration). */
export async function requestPasswordReset(email: string) {
  const [user] = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(and(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`, isNull(schema.users.deletedAt)));
  if (!user) return { sent: false };
  const token = newToken();
  await db.insert(schema.passwordResetTokens).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  const link = `${env().APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const delivered = await sendEmail({
    to: user.email,
    subject: `Reset your ${env().APP_NAME} password`,
    text: `Someone asked to reset the password for your ${env().APP_NAME} account.\n\nReset it here (valid for 1 hour): ${link}\n\nIf this wasn't you, ignore this email — your password stays the same.`,
    devLink: link,
  });
  await audit({ userId: user.id, actor: "user", action: "auth.reset_requested", metadata: { delivered } });
  return { sent: delivered, token: env().NODE_ENV === "test" ? token : undefined };
}

export async function resetPassword(token: string, newPassword: string, meta: { userAgent?: string | null } = {}) {
  const tokenHash = sha256(token);
  const [row] = await db
    .select({ id: schema.passwordResetTokens.id, userId: schema.passwordResetTokens.userId, email: schema.users.email, username: schema.users.username })
    .from(schema.passwordResetTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.passwordResetTokens.userId))
    .where(and(eq(schema.passwordResetTokens.tokenHash, tokenHash), isNull(schema.passwordResetTokens.usedAt), gt(schema.passwordResetTokens.expiresAt, new Date()), isNull(schema.users.deletedAt)));
  if (!row) throw new HttpError(400, "INVALID_RESET_TOKEN", "This reset link is invalid or has expired. Request a new one.");
  const problem = passwordProblems(newPassword, { email: row.email, username: row.username });
  if (problem) throw new HttpError(400, "WEAK_PASSWORD", problem);
  const passwordHash = await hashPassword(newPassword);
  const used = await db.transaction(async (tx) => {
    const marked = await tx
      .update(schema.passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(schema.passwordResetTokens.id, row.id), isNull(schema.passwordResetTokens.usedAt)))
      .returning({ id: schema.passwordResetTokens.id });
    if (marked.length === 0) return false;
    await tx.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, row.userId));
    await audit({ userId: row.userId, actor: "user", action: "auth.password_reset" }, tx);
    return true;
  });
  if (!used) throw new HttpError(400, "INVALID_RESET_TOKEN", "This reset link has already been used.");
  await invalidateUserSessions(row.userId);
  const session = await createSession(row.userId, meta.userAgent);
  return { userId: row.userId, session };
}

export async function changePassword(userId: string, current: string, next: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user || !(await verifyPassword(user.passwordHash, current))) throw new HttpError(400, "INVALID_CREDENTIALS", "Your current password is incorrect.");
  const problem = passwordProblems(next, { email: user.email, username: user.username });
  if (problem) throw new HttpError(400, "WEAK_PASSWORD", problem);
  await db.update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, userId));
  await invalidateUserSessions(userId);
  await audit({ userId, actor: "user", action: "auth.password_changed" });
  return createSession(userId);
}

/**
 * Delete an account. The trade and cash ledgers are immutable, so the user row
 * is anonymised (email, username, name, password) and every social link is
 * removed; leagues they own pass to the longest-standing member or are archived.
 */
export async function deleteAccount(userId: string, password: string) {
  const [user] = await db.select().from(schema.users).where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));
  if (!user || !(await verifyPassword(user.passwordHash, password))) throw new HttpError(400, "INVALID_CREDENTIALS", "Your password is incorrect.");
  const short = userId.replace(/-/g, "").slice(0, 10);
  await db.transaction(async (tx) => {
    const owned = await tx.select({ id: schema.leagues.id }).from(schema.leagues).where(and(eq(schema.leagues.ownerId, userId), isNull(schema.leagues.archivedAt)));
    for (const l of owned) {
      const [heir] = await tx
        .select({ userId: schema.leagueMembers.userId })
        .from(schema.leagueMembers)
        .where(and(eq(schema.leagueMembers.leagueId, l.id), sql`${schema.leagueMembers.userId} <> ${userId}`))
        .orderBy(sql`case ${schema.leagueMembers.role} when 'admin' then 0 else 1 end`, schema.leagueMembers.joinedAt)
        .limit(1);
      if (heir) {
        await tx.update(schema.leagues).set({ ownerId: heir.userId }).where(eq(schema.leagues.id, l.id));
        await tx.update(schema.leagueMembers).set({ role: "owner" }).where(and(eq(schema.leagueMembers.leagueId, l.id), eq(schema.leagueMembers.userId, heir.userId)));
      } else {
        await tx.update(schema.leagues).set({ archivedAt: new Date() }).where(eq(schema.leagues.id, l.id));
      }
    }
    await tx.delete(schema.leagueMembers).where(eq(schema.leagueMembers.userId, userId));
    await tx.delete(schema.friendships).where(or(eq(schema.friendships.userAId, userId), eq(schema.friendships.userBId, userId)));
    await tx.delete(schema.friendRequests).where(or(eq(schema.friendRequests.fromUserId, userId), eq(schema.friendRequests.toUserId, userId)));
    await tx.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    await tx.delete(schema.watchlist).where(eq(schema.watchlist.userId, userId));
    await tx.delete(schema.activityEvents).where(eq(schema.activityEvents.userId, userId));
    await tx
      .update(schema.users)
      .set({
        email: `deleted+${short}@deleted.invalid`,
        username: `deleted_${short}`,
        displayName: "Deleted manager",
        passwordHash: `!deleted:${newToken(16)}`,
        bio: null,
        showOnGlobalLeaderboard: false,
        portfolioVisibility: "private",
        activityVisibility: "private",
        deletedAt: new Date(),
      })
      .where(eq(schema.users.id, userId));
    await audit({ userId, actor: "user", action: "user.deleted" }, tx);
  });
  await invalidateUserSessions(userId);
  log.info("account deleted", { userId });
}

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
}

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
