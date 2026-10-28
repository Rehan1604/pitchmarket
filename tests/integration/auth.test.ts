import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@/db";
import { deleteAccount, login, requestPasswordReset, resetPassword, signup } from "@/server/auth/accounts";
import { createSession, invalidateSession, validateSessionToken } from "@/server/auth/session";
import { makeUser } from "./helpers";

afterAll(() => closeDb());

describe("registration", () => {
  it("creates the user with the starting virtual balance recorded in the cash ledger", async () => {
    const u = await makeUser("reg");
    const [acc] = await db.select().from(schema.cashAccounts).where(eq(schema.cashAccounts.userId, u.id));
    expect(acc.balanceCents).toBe(10_000_000);
    expect(acc.startingCents).toBe(10_000_000);
    const entries = await db.select().from(schema.cashEntries).where(eq(schema.cashEntries.userId, u.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "grant", amountCents: 10_000_000, balanceAfterCents: 10_000_000 });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.role).toBe("user");
  });

  it("rejects duplicate usernames (case-insensitive) and emails", async () => {
    const u = await makeUser("dup");
    await expect(signup({ email: `other-${u.email}`, username: u.username.toUpperCase(), password: "correct-horse-battery", acceptTerms: true })).rejects.toMatchObject({ code: "USERNAME_TAKEN" });
    await expect(signup({ email: u.email.toUpperCase(), username: `${u.username.slice(0, 15)}x9`, password: "correct-horse-battery", acceptTerms: true })).rejects.toMatchObject({ code: "EMAIL_UNAVAILABLE" });
  });

  it("rejects weak passwords", async () => {
    await expect(signup({ email: "weak@example.test", username: "weakling1", password: "short", acceptTerms: true })).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    await expect(signup({ email: "weak2@example.test", username: "weakling2", password: "weakling2-is-me", acceptTerms: true })).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
  });

  it("cannot be repeated to farm free credits: one account, one grant", async () => {
    const u = await makeUser("farm");
    await expect(signup({ email: u.email, username: u.username, password: "correct-horse-battery", acceptTerms: true })).rejects.toBeTruthy();
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.cashEntries).where(eq(schema.cashEntries.userId, u.id));
    expect(n).toBe(1);
  });
});

describe("authentication", () => {
  it("signs in with email or username and returns the same generic error for any failure", async () => {
    const u = await makeUser("login");
    expect((await login({ identifier: u.email, password: "correct-horse-battery" })).userId).toBe(u.id);
    expect((await login({ identifier: u.username.toUpperCase(), password: "correct-horse-battery" })).userId).toBe(u.id);
    const wrongPw = await login({ identifier: u.email, password: "nope-nope-nope" }).catch((e) => e);
    const unknown = await login({ identifier: "nobody@example.test", password: "nope-nope-nope" }).catch((e) => e);
    expect(wrongPw.code).toBe("INVALID_CREDENTIALS");
    expect(unknown.code).toBe("INVALID_CREDENTIALS");
    expect(wrongPw.message).toBe(unknown.message);
  });

  it("stores only a hash of the session token and validates/invalidates sessions", async () => {
    const u = await makeUser("sess");
    const { token } = await createSession(u.id, "vitest");
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, u.id));
    expect(row.id).not.toBe(token);
    const v = await validateSessionToken(token);
    expect(v?.user.id).toBe(u.id);
    expect(v?.user).not.toHaveProperty("passwordHash");
    await invalidateSession(v!.sessionId);
    expect(await validateSessionToken(token)).toBeNull();
    expect(await validateSessionToken("forged-token")).toBeNull();
  });

  it("rejects expired sessions", async () => {
    const u = await makeUser("exp");
    const { token } = await createSession(u.id);
    await db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.sessions.userId, u.id));
    expect(await validateSessionToken(token)).toBeNull();
  });

  it("resets a password with a single-use token and revokes existing sessions", async () => {
    const u = await makeUser("reset");
    const { token: oldSession } = await createSession(u.id);
    const { token } = await requestPasswordReset(u.email);
    expect(token).toBeTruthy();
    await resetPassword(token!, "a-brand-new-passphrase");
    expect(await validateSessionToken(oldSession)).toBeNull();
    await expect(login({ identifier: u.email, password: "correct-horse-battery" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect((await login({ identifier: u.email, password: "a-brand-new-passphrase" })).userId).toBe(u.id);
    await expect(resetPassword(token!, "another-new-passphrase")).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
    // Unknown emails behave identically from the caller's point of view.
    expect(await requestPasswordReset("ghost@example.test")).toMatchObject({ sent: false });
  });

  it("deletes accounts by anonymising them and blocking sign-in", async () => {
    const u = await makeUser("del");
    await deleteAccount(u.id, "correct-horse-battery");
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).not.toContain(u.email);
    await expect(login({ identifier: u.email, password: "correct-horse-battery" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
});
