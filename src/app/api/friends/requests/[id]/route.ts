import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, notFound, readJson, route } from "@/server/http";
import { cancelFriendRequest, respondToFriendRequest } from "@/server/social/friends";

const body = z.object({ action: z.enum(["accept", "decline", "cancel"]) });

export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) throw notFound("That friend request no longer exists.");
  const { action } = await readJson(req, body);
  if (action === "cancel") {
    await cancelFriendRequest(user.id, id);
    return json({ status: "cancelled" });
  }
  return json(await respondToFriendRequest(user.id, id, action === "accept"));
});
