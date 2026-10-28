/**
 * Bootstraps a working market from real data:
 *   1. applies migrations
 *   2. syncs fixtures, players (IPO) and match stats from the configured provider
 *      (live FPL API, or the public snapshot when unreachable)
 *   3. settles every finished match in kickoff order, producing genuine price history
 *
 *   npm run db:seed
 *   npm run db:seed -- --demo-users   # also create clearly-labelled demo accounts (APP_MODE=demo only)
 */
import "dotenv/config";
import { closeDb } from "@/db";
import { runMigrations } from "@/db/migrate";
import { syncFixtures, syncReference, syncStats, withRun } from "@/server/ingestion/pipeline";
import { resolveMarketProvider } from "@/server/ingestion/registry";
import { takeDailySnapshots } from "@/server/portfolio/snapshots";

async function main() {
  await runMigrations();
  const provider = await resolveMarketProvider({ forceProbe: true });
  console.log(JSON.stringify({ msg: "seeding market", provider: provider.source, mode: provider.mode }));
  const fx = await withRun("fixtures", provider.source, "seed", () => syncFixtures(provider), { gate: false });
  if (fx.status === "failed") throw new Error(`fixtures sync failed: ${"error" in fx ? fx.error : ""}`);
  const ref = await withRun("reference", provider.source, "seed", () => syncReference(provider), { gate: false });
  if (ref.status === "failed") throw new Error(`reference sync failed: ${"error" in ref ? ref.error : ""}`);
  const st = await withRun("stats", provider.source, "seed", () => syncStats(provider), { gate: false });
  console.log(JSON.stringify({ msg: "seed complete", fixtures: fx, reference: ref, stats: st }));

  if (process.argv.includes("--demo-users")) {
    const { createDemoUsers } = await import("./demo-users");
    await createDemoUsers();
  }
  await takeDailySnapshots();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
