import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AVATAR_COLORS } from "@/server/auth/accounts";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";

const body = z.object({
  displayName: z.string().trim().min(1).max(40),
  avatarColor: z.enum(AVATAR_COLORS as [string, ...string[]]),
  acknowledgeVirtual: z.literal(true, { error: "Confirm you understand credits are virtual." }),
});

export const POST = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  const input = await readJson(req, body);
  await db.update(schema.users).set({ displayName: input.displayName, avatarColor: input.avatarColor, onboardedAt: user.onboardedAt ?? new Date() }).where(eq(schema.users.id, user.id));
  return json({ ok: true });
});
