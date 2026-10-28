/**
 * One scheduler tick from the command line.
 *   npm run ingest            # run whatever is due
 *   npm run ingest -- --force # ignore minimum intervals (backfills, debugging)
 */
import "dotenv/config";
import { closeDb } from "@/db";
import { runSchedulerTick } from "@/server/ingestion/scheduler";

async function main() {
  const force = process.argv.includes("--force");
  const result = await runSchedulerTick("cli", { force });
  console.log(JSON.stringify({ level: "info", msg: "tick complete", ...result }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
