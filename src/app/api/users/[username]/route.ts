import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, notFound, route } from "@/server/http";
import { getProfile } from "@/server/social/profiles";

export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ username: string }> }) => {
  const user = await requireApiUser();
  const { username } = await ctx.params;
  if (!/^[A-Za-z0-9_]{1,40}$/.test(username)) throw notFound("No manager with that username.");
  return json(await getProfile(user.id, username));
});
