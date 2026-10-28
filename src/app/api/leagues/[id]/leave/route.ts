import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { leaveLeague } from "@/server/social/leagues";

export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser();
  await leaveLeague(user.id, (await ctx.params).id);
  return json({ ok: true });
});
