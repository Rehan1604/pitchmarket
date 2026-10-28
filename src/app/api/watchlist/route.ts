import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { setWatched } from "@/server/portfolio/watchlist";

const body = z.object({ playerId: z.number().int().positive(), watched: z.boolean() });

export const POST = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  const { playerId, watched } = await readJson(req, body);
  return json(await setWatched(user.id, playerId, watched));
});
