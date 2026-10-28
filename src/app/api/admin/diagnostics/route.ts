import { diagnostics } from "@/server/admin/service";
import { requireApiAdmin } from "@/server/auth/current-user";
import { json, route } from "@/server/http";

export const GET = route(async () => {
  await requireApiAdmin();
  return json(await diagnostics());
});
