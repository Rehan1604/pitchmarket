import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { revokeInvite } from "@/server/social/leagues";

export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser();
  await revokeInvite(user.id, (await ctx.params).id);
  return json({ ok: true });
});
