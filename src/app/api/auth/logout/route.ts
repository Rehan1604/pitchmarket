import { clearSessionCookie, getAuth } from "@/server/auth/current-user";
import { invalidateSession } from "@/server/auth/session";
import { json, route } from "@/server/http";

export const POST = route(async () => {
  const auth = await getAuth();
  if (auth) await invalidateSession(auth.sessionId);
  await clearSessionCookie();
  return json({ ok: true });
});
