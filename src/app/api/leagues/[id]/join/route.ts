import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";
import { joinPublicLeague } from "@/server/social/leagues";

export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser();
  await enforceRateLimit("league-join:user", user.id, 20, 600);
  return json(await joinPublicLeague(user.id, (await ctx.params).id));
});
