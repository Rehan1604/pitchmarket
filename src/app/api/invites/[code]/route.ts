import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";
import { previewInvite } from "@/server/social/leagues";

export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ code: string }> }) => {
  const user = await requireApiUser();
  await enforceRateLimit("invite-lookup:user", user.id, 30, 600, "Too many invite lookups. Wait a few minutes.");
  return json(await previewInvite((await ctx.params).code, user.id));
});
