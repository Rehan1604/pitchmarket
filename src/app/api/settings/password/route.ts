import type { NextRequest } from "next/server";
import { z } from "zod";
import { changePassword } from "@/server/auth/accounts";
import { requireApiUser, setSessionCookie } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";

const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) });

export const POST = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  await enforceRateLimit("password:user", user.id, 5, 900);
  const input = await readJson(req, body);
  const session = await changePassword(user.id, input.currentPassword, input.newPassword);
  await setSessionCookie(session.token, session.expiresAt);
  return json({ ok: true });
});
