/**
 * Runs once when a Next.js server instance starts. Used only to start the
 * optional in-process market scheduler (ENABLE_INPROCESS_SCHEDULER=true).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (!["1", "true", "yes", "on"].includes((process.env.ENABLE_INPROCESS_SCHEDULER ?? "").toLowerCase())) return;
  const { startInProcessScheduler } = await import("@/server/ingestion/in-process");
  startInProcessScheduler();
}
