import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";
import { createLeague, inviteUrl, leagueSettingsSchema, listMyLeagues, listPublicLeagues } from "@/server/social/leagues";

export const GET = route(async () => {
  const user = await requireApiUser();
  const [mine, publicLeagues] = await Promise.all([listMyLeagues(user.id), listPublicLeagues()]);
  return json({ mine, public: publicLeagues });
});

export const POST = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  await enforceRateLimit("league-create:user", user.id, 10, 3600, "You've created several leagues recently. Try again later.");
  const input = await readJson(req, leagueSettingsSchema);
  const { league, invite } = await createLeague(user.id, input);
  return json({ league, invite: { ...invite, url: inviteUrl(invite.code) } }, { status: 201 });
});
