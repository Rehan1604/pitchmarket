import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { requireApiAdmin } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { resetProviderChoice } from "@/server/ingestion/registry";
import { runSchedulerTick } from "@/server/ingestion/scheduler";
import { enforceRateLimit } from "@/server/ratelimit";

export const maxDuration = 60;
const body = z.object({ force: z.boolean().default(false), reprobe: z.boolean().default(false) });

export const POST = route(async (req: NextRequest) => {
  const admin = await requireApiAdmin();
  await enforceRateLimit("admin-ingest", admin.id, 6, 300, "Manual refreshes are limited to 6 per 5 minutes to respect provider rate limits.");
  const { force, reprobe } = await readJson(req, body);
  if (reprobe) resetProviderChoice();
  await audit({ userId: admin.id, actor: "admin", action: "ingestion.manual_run", metadata: { force, reprobe } });
  return json(await runSchedulerTick("admin", { force }));
});
