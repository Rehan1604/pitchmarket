import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { listMarket, marketFilterSchema } from "@/server/market/queries";

export const GET = route(async (req: NextRequest) => {
  const user = await getCurrentUser();
  const filter = marketFilterSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return json(await listMarket(filter, user?.id));
});
