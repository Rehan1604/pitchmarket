import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { friendsFeed } from "@/server/social/profiles";

export const GET = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  const q = z.object({ before: z.coerce.date().optional() }).parse(Object.fromEntries(req.nextUrl.searchParams));
  return json({ events: await friendsFeed(user.id, 40, q.before) });
});
