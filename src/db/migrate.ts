import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "./index";

/** Applies all pending SQL migrations in ./drizzle. Safe to run repeatedly. */
export async function runMigrations() {
  await migrate(getDb(), { migrationsFolder: path.join(process.cwd(), "drizzle") });
}
