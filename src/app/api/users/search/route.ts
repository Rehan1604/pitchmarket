import type { NextRequest } from "next/server";
import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";
import { searchUsers } from "@/server/social/friends";

export const GET = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  await enforceRateLimit("search:user", user.id, 60, 60);
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 30);
  return json({ users: await searchUsers(user.id, q) });
});
