import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";

const vis = z.enum(["public", "friends", "private"]);
const body = z.object({ portfolioVisibility: vis.optional(), activityVisibility: vis.optional(), showOnGlobalLeaderboard: z.boolean().optional() });

export const PATCH = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  const input = await readJson(req, body);
  await db.update(schema.users).set(input).where(eq(schema.users.id, user.id));
  await audit({ userId: user.id, actor: "user", action: "privacy.updated", metadata: input });
  return json({ ok: true });
});
