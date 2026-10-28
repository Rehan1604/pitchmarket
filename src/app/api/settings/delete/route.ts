import type { NextRequest } from "next/server";
import { z } from "zod";
import { deleteAccount } from "@/server/auth/accounts";
import { clearSessionCookie, requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";

const body = z.object({ password: z.string().min(1).max(128), confirm: z.literal("DELETE", { error: "Type DELETE to confirm." }) });

export const POST = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  await enforceRateLimit("delete:user", user.id, 5, 900);
  const input = await readJson(req, body);
  await deleteAccount(user.id, input.password);
  await clearSessionCookie();
  return json({ ok: true });
});
