import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, notFound, readJson, route } from "@/server/http";
import { removeMember, setMemberRole, transferOwnership } from "@/server/social/leagues";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remove") }),
  z.object({ action: z.literal("role"), role: z.enum(["admin", "member"]) }),
  z.object({ action: z.literal("transfer") }),
]);

export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string; userId: string }> }) => {
  const user = await requireApiUser();
  const { id, userId } = await ctx.params;
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(userId).success) throw notFound("Not found.");
  const input = await readJson(req, body);
  if (input.action === "remove") await removeMember(user.id, id, userId);
  else if (input.action === "role") await setMemberRole(user.id, id, userId, input.role);
  else await transferOwnership(user.id, id, userId);
  return json({ ok: true });
});
