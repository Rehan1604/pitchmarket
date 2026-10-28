import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://pitchmarket:pitchmarket@localhost:5432/pitchmarket_e2e";

/**
 * End-to-end tests run a production build against an isolated database that is
 * reset and seeded (from the real-data fixture slice) by global-setup.ts.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: process.env.E2E_SKIP_BUILD ? `npx next start -p ${PORT}` : `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      DATABASE_URL,
      APP_URL: `http://localhost:${PORT}`,
      APP_MODE: "demo",
      DATA_PROVIDER: "fpl-archive",
      FPL_ARCHIVE_LOCAL_DIR: path.resolve(__dirname, "tests/fixtures/fpl-archive"),
      CRON_SECRET: "e2e-cron-secret-123456",
      SECURE_COOKIES: "false",
      LOG_LEVEL: "warn",
    },
  },
});
