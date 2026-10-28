import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/current-user";
import { json, notFound, route } from "@/server/http";
import { getPlayerDetail } from "@/server/market/queries";

export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw notFound("Player not found.");
  const user = await getCurrentUser();
  return json(await getPlayerDetail(slug, user?.id));
});
