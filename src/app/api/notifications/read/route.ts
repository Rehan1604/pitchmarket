import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { markNotificationsRead } from "@/server/social/profiles";

const body = z.object({ ids: z.array(z.uuid()).max(100).optional() });

export const POST = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  const { ids } = await readJson(req, body);
  await markNotificationsRead(user.id, ids);
  return json({ ok: true });
});
