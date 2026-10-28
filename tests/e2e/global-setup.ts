import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";

/** Reset and seed the isolated E2E database from the real-data fixture slice. */
export default async function globalSetup() {
  const url = process.env.E2E_DATABASE_URL ?? "postgres://pitchmarket:pitchmarket@localhost:5432/pitchmarket_e2e";
  if (!/e2e|test/.test(url)) throw new Error(`Refusing to reset a non-test database: ${url}`);
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await client.end();
  const root = path.resolve(__dirname, "../..");
  execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/seed.ts"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: url,
      DATA_PROVIDER: "fpl-archive",
      FPL_ARCHIVE_LOCAL_DIR: path.resolve(root, "tests/fixtures/fpl-archive"),
      APP_MODE: "demo",
      LOG_LEVEL: "warn",
    },
  });
}
