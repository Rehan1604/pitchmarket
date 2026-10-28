import type { NextRequest } from "next/server";
import { signup, signupSchema } from "@/server/auth/accounts";
import { setSessionCookie } from "@/server/auth/current-user";
import { clientIp, json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";

export const POST = route(async (req: NextRequest) => {
  await enforceRateLimit("signup:ip", clientIp(req), 5, 3600, "Too many sign-ups from this network. Try again later.");
  const input = await readJson(req, signupSchema);
  const { userId, session } = await signup(input, { userAgent: req.headers.get("user-agent") });
  await setSessionCookie(session.token, session.expiresAt);
  return json({ ok: true, userId }, { status: 201 });
});
