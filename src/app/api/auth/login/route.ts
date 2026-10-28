import type { NextRequest } from "next/server";
import { login, loginSchema } from "@/server/auth/accounts";
import { setSessionCookie } from "@/server/auth/current-user";
import { clientIp, json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";

export const POST = route(async (req: NextRequest) => {
  const input = await readJson(req, loginSchema);
  await enforceRateLimit("login:ip", clientIp(req), 20, 600);
  await enforceRateLimit("login:id", input.identifier.toLowerCase(), 8, 900, "Too many sign-in attempts for this account. Wait 15 minutes or reset your password.");
  const { session } = await login(input, { userAgent: req.headers.get("user-agent") });
  await setSessionCookie(session.token, session.expiresAt);
  return json({ ok: true });
});
