/**
 * Integration tests run against a real, isolated Postgres database
 * (TEST_DATABASE_URL, default pitchmarket_test). The schema is rebuilt from the
 * migrations and the market is seeded from a trimmed slice of real 2026-27
 * Premier League data in tests/fixtures/fpl-archive.
 */
import path from "node:path";
import { Client } from "pg";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://pitchmarket:pitchmarket@localhost:5432/pitchmarket_test";
  if (!/test/.test(url)) throw new Error(`Refusing to reset a database whose URL does not contain "test": ${url}`);
  process.env.DATABASE_URL = url;
  (process.env as Record<string, string>).NODE_ENV = "test";
  process.env.DATA_PROVIDER = "fpl-archive";
  process.env.FPL_ARCHIVE_LOCAL_DIR = path.resolve(__dirname, "../fixtures/fpl-archive");
  process.env.LOG_LEVEL = "error";

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await client.end();

  const { runMigrations } = await import("@/db/migrate");
  const { syncFixtures, syncReference, syncStats } = await import("@/server/ingestion/pipeline");
  const { fplArchiveProvider } = await import("@/server/ingestion/registry");
  const { closeDb } = await import("@/db");
  await runMigrations();
  const provider = fplArchiveProvider();
  await syncFixtures(provider);
  await syncReference(provider);
  await syncStats(provider);
  await closeDb();
}
