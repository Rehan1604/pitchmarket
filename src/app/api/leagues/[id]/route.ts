import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { archiveLeague, getLeagueForViewer, leagueSettingsSchema, listMembers, updateLeague } from "@/server/social/leagues";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireApiUser();
  const { id } = await ctx.params;
  const view = await getLeagueForViewer(id, user.id);
  return json({ ...view, membersList: await listMembers(user.id, id) });
});

export const PATCH = route(async (req: NextRequest, ctx: Ctx) => {
  const user = await requireApiUser();
  const { id } = await ctx.params;
  return json({ league: await updateLeague(user.id, id, await readJson(req, leagueSettingsSchema.partial())) });
});

export const DELETE = route(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireApiUser();
  await archiveLeague(user.id, (await ctx.params).id);
  return json({ ok: true });
});
