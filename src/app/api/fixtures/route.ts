import type { NextRequest } from "next/server";
import { z } from "zod";
import { json, route } from "@/server/http";
import { listFixtures } from "@/server/market/queries";

export const GET = route(async (req: NextRequest) => {
  const q = z
    .object({ competition: z.string().max(10).optional(), status: z.enum(["upcoming", "live", "results"]).optional(), limit: z.coerce.number().int().min(1).max(200).optional() })
    .parse(Object.fromEntries(req.nextUrl.searchParams));
  return json({ fixtures: await listFixtures(q) });
});
