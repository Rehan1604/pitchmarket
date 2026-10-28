import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { listNotifications, unreadCount } from "@/server/social/profiles";

export const GET = route(async () => {
  const user = await requireApiUser();
  const [items, unread] = await Promise.all([listNotifications(user.id), unreadCount(user.id)]);
  return json({ items, unread });
});
