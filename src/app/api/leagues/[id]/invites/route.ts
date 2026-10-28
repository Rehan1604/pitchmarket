import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";
import { createInvite, listInvites } from "@/server/social/leagues";

type Ctx = { params: Promise<{ id: string }> };
const body = z.object({
  maxUses: z.number().int().min(1).max(500).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(90).nullable().optional(),
  invitedUsername: z.string().trim().min(1).max(40).nullable().optional(),
});

export const GET = route(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireApiUser();
  return json({ invites: await listInvites(user.id, (await ctx.params).id) });
});

export const POST = route(async (req: NextRequest, ctx: Ctx) => {
  const user = await requireApiUser();
  await enforceRateLimit("invite-create:user", user.id, 30, 3600);
  const invite = await createInvite(user.id, (await ctx.params).id, await readJson(req, body));
  return json({ invite }, { status: 201 });
});
