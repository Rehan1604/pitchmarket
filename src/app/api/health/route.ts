import { json } from "@/server/http";

/** Liveness: the process is up and serving requests. No dependencies checked. */
export function GET() {
  return json({ ok: true, service: "pitchmarket", time: new Date().toISOString() });
}
