import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { listFriendRequests, listFriends } from "@/server/social/friends";

export const GET = route(async () => {
  const user = await requireApiUser();
  const [friends, requests] = await Promise.all([listFriends(user.id), listFriendRequests(user.id)]);
  return json({ friends, requests });
});
