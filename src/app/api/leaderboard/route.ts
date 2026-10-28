import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { getLeaderboard, type Scope } from "@/server/leaderboard/service";
import { getLeagueForViewer } from "@/server/social/leagues";

export const GET = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  const q = z
    .object({
      scope: z.enum(["global", "friends", "league"]).default("global"),
      leagueId: z.uuid().optional(),
      period: z.enum(["season", "week", "day"]).default("season"),
      page: z.coerce.number().int().min(1).max(1000).default(1),
    })
    .parse(Object.fromEntries(req.nextUrl.searchParams));
  let scope: Scope = { kind: "global" };
  if (q.scope === "friends") scope = { kind: "friends", userId: user.id };
  if (q.scope === "league") {
    if (!q.leagueId) throw new z.ZodError([{ code: "custom", path: ["leagueId"], message: "leagueId is required", input: undefined }]);
    await getLeagueForViewer(q.leagueId, user.id); // authorisation (404 for private leagues you're not in)
    scope = { kind: "league", leagueId: q.leagueId };
  }
  const pageSize = 50;
  return json(await getLeaderboard(scope, { period: q.period, limit: pageSize, offset: (q.page - 1) * pageSize }));
});
