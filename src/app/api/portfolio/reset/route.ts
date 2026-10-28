import { requireApiUser } from "@/server/auth/current-user";
import { json, route } from "@/server/http";
import { resetPortfolio } from "@/server/portfolio/reset";
import { enforceRateLimit } from "@/server/ratelimit";

export const POST = route(async () => {
  const user = await requireApiUser();
  await enforceRateLimit("reset-portfolio:user", user.id, 1, 600, "You can reset your demo portfolio once every 10 minutes.");
  return json(await resetPortfolio(user.id, { kind: "self" }));
});
