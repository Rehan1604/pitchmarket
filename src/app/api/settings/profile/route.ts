import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AVATAR_COLORS } from "@/server/auth/accounts";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";

const body = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  bio: z.string().trim().max(160).nullable().optional(),
  avatarColor: z.enum(AVATAR_COLORS as [string, ...string[]]).optional(),
});

export const PATCH = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  const input = await readJson(req, body);
  await db.update(schema.users).set({ ...input, bio: input.bio === "" ? null : input.bio }).where(eq(schema.users.id, user.id));
  return json({ ok: true });
});
