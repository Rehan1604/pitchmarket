import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/current-user";
import { json, readJson, route } from "@/server/http";
import { getTrades } from "@/server/portfolio/valuation";
import { enforceRateLimit } from "@/server/ratelimit";
import { executeTrade, tradeInputSchema } from "@/server/trading/service";

export const POST = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  await enforceRateLimit("trade:user", user.id, 30, 60, "You're trading very fast. Wait a few seconds and try again.");
  const input = await readJson(req, tradeInputSchema);
  const receipt = await executeTrade({ ...input, userId: user.id });
  return json({ receipt }, { status: receipt.replayed ? 200 : 201 });
});

export const GET = route(async (req: NextRequest) => {
  const user = await requireApiUser();
  const q = z
    .object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.coerce.date().optional(), playerId: z.coerce.number().int().positive().optional() })
    .parse(Object.fromEntries(req.nextUrl.searchParams));
  return json({ trades: await getTrades(user.id, q) });
});
