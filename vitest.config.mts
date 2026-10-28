import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      // `server-only` throws outside React Server Components; tests run server code directly.
      "server-only": path.resolve(root, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
          env: {
            NODE_ENV: "test",
            DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://pitchmarket:pitchmarket@localhost:5432/pitchmarket_test",
            DATA_PROVIDER: "fpl-archive",
            FPL_ARCHIVE_LOCAL_DIR: path.resolve(root, "tests/fixtures/fpl-archive"),
            APP_MODE: "demo",
            APP_URL: "http://localhost:3000",
            CRON_SECRET: "test-cron-secret-123456",
            STARTING_BALANCE_CREDITS: "100000",
            TRADING_FEE_BPS: "0",
            LOG_LEVEL: "error",
          },
        },
      },
    ],
  },
});
