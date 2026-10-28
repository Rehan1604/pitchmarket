import type { NextRequest } from "next/server";
import { z } from "zod";
import { setMarketStatus } from "@/server/admin/service";
import { requireApiAdmin } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";

const body = z.object({ status: z.enum(["open", "halted", "maintenance"]), reason: z.string().trim().max(200).nullable().optional() });

export const POST = route(async (req: NextRequest) => {
  const admin = await requireApiAdmin();
  const { status, reason } = await readJson(req, body);
  await setMarketStatus(admin.id, status, reason ?? null);
  return json({ ok: true });
});
