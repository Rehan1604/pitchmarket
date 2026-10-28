import type { NextRequest } from "next/server";
import { z } from "zod";
import { resetPassword } from "@/server/auth/accounts";
import { setSessionCookie } from "@/server/auth/current-user";
import { clientIp, json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";

const schema = z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(128) });

export const POST = route(async (req: NextRequest) => {
  await enforceRateLimit("reset:ip", clientIp(req), 10, 3600);
  const { token, password } = await readJson(req, schema);
  const { session } = await resetPassword(token, password, { userAgent: req.headers.get("user-agent") });
  await setSessionCookie(session.token, session.expiresAt);
  return json({ ok: true });
});
