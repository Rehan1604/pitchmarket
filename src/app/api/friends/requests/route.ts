import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { enforceRateLimit } from "@/server/ratelimit";
import { sendFriendRequest } from "@/server/social/friends";

const body = z.object({ username: z.string().trim().min(1).max(40) });

export const POST = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  await enforceRateLimit("friend-request:user", user.id, 30, 3600, "You've sent a lot of friend requests. Try again later.");
  const { username } = await readJson(req, body);
  return json(await sendFriendRequest(user.id, username), { status: 201 });
});
