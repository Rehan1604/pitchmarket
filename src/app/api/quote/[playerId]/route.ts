import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { quote } from "@/server/trading/service";

export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ playerId: string }> }) => {
  const user = await requireApiUser();
  const playerId = z.coerce.number().int().positive().parse((await ctx.params).playerId);
  return json(await quote(user.id, playerId));
});
