import { json, route } from "@/server/http";
import { dataStatus } from "@/server/market/queries";

/** Lightweight endpoint the UI polls to know when prices changed (market version) and how fresh data is. */
export const GET = route(async () => json(await dataStatus()));
