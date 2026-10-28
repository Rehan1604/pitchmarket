import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";
import { joinByCode } from "@/server/social/leagues";

export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ code: string }> }) => {
  const user = await requireApiUser();
  await enforceRateLimit("invite-join:user", user.id, 10, 600, "Too many join attempts. Wait a few minutes.");
  return json(await joinByCode(user.id, (await ctx.params).code));
});
