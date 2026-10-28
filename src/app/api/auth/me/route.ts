import { getCurrentUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { unreadCount } from "@/server/social/profiles";

export const GET = route(async () => {
  const user = await getCurrentUser();
  if (!user) return json({ user: null });
  return json({
    user: { id: user.id, username: user.username, displayName: user.displayName, avatarColor: user.avatarColor, role: user.role, isDemo: user.isDemo, onboarded: Boolean(user.onboardedAt) },
    unreadNotifications: await unreadCount(user.id),
  });
});
