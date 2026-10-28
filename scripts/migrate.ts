import "dotenv/config";
import { closeDb } from "@/db";
import { runMigrations } from "@/db/migrate";

async function main() {
  const started = Date.now();
  await runMigrations();
  console.log(JSON.stringify({ level: "info", msg: "migrations applied", ms: Date.now() - started }));
}

main()
  .catch((err) => {
    console.error(JSON.stringify({ level: "error", msg: "migration failed", error: String(err?.message ?? err) }));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
