import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { getPortfolio } from "@/server/portfolio/valuation";

export const GET = route(async () => {
  const user = await requireApiUser();
  return json(await getPortfolio(user.id));
});
