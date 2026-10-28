import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { forbidden, unauthorized } from "@/server/http";
import { SESSION_COOKIE, sessionCookieOptions, validateSessionToken, type SessionUser } from "./session";

/** Session + user for this request (validated once per render via React cache). */
export const getAuth = cache(async (): Promise<{ user: SessionUser; sessionId: string } | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const result = await validateSessionToken(token);
  if (!result) return null;
  if (result.renewed) {
    try {
      jar.set(SESSION_COOKIE, token, sessionCookieOptions(result.expiresAt));
    } catch {
      // Server Components cannot set cookies; the next route-handler call renews it.
    }
  }
  return { user: result.user, sessionId: result.sessionId };
});

export async function getCurrentUser(): Promise<SessionUser | null> {
  return (await getAuth())?.user ?? null;
}

/** Pages: redirect to sign-in when signed out; to onboarding until it is complete. */
export async function requirePageUser(opts: { allowUnonboarded?: boolean } = {}): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!opts.allowUnonboarded && !user.onboardedAt) redirect("/onboarding");
  return user;
}

export async function requirePageAdmin(): Promise<SessionUser> {
  const user = await requirePageUser();
  if (user.role !== "admin") redirect("/dashboard");
  return user;
}

/** API routes: throw 401/403 JSON errors. */
export async function requireApiUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  return user;
}

export async function requireApiAdmin(): Promise<SessionUser> {
  const user = await requireApiUser();
  if (user.role !== "admin") throw forbidden();
  return user;
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
}
