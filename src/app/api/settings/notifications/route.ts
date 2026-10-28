import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";

const body = z.object({ notifyTrades: z.boolean().optional(), notifySocial: z.boolean().optional(), notifyRank: z.boolean().optional() });

export const PATCH = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  await db.update(schema.users).set(await readJson(req, body)).where(eq(schema.users.id, user.id));
  return json({ ok: true });
});
