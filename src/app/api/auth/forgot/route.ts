import type { NextRequest } from "next/server";
import { z } from "zod";
import { requestPasswordReset } from "@/server/auth/accounts";
import { clientIp, json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";

const schema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) });

export const POST = route(async (req: NextRequest) => {
  const { email } = await readJson(req, schema);
  await enforceRateLimit("forgot:ip", clientIp(req), 10, 3600);
  await enforceRateLimit("forgot:email", email, 3, 3600);
  await requestPasswordReset(email);
  // Same response whether or not the account exists.
  return json({ ok: true, message: "If an account uses that email, a reset link is on its way." });
});
