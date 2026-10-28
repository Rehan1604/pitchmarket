import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiAdmin } from "@/server/auth/current-user";
import { json, notFound, route } from "@/server/http";
import { resetPortfolio } from "@/server/portfolio/reset";

export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireApiAdmin();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) throw notFound("User not found.");
  return json(await resetPortfolio(id, { kind: "admin", adminId: admin.id }));
});
