import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { removeFriend } from "@/server/social/friends";

export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ username: string }> }) => {
  const user = await requireApiUser();
  await removeFriend(user.id, (await ctx.params).username);
  return json({ ok: true });
});
