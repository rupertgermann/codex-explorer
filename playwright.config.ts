import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3317",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tests/e2e/seed-memory.mjs && npm run start -- --hostname 127.0.0.1 --port 3317",
    env: {
      CODEX_HOME: "/tmp/codex-explorer-e2e-home",
      CODEX_MEMORY_DIRECTORY: "/tmp/codex-explorer-e2e-memory",
      CODEX_SESSIONS_DIRECTORY: "/tmp/codex-explorer-e2e-sessions",
      CODEX_DB_DIRECTORY: "/tmp/codex-explorer-e2e-databases",
    },
    url: "http://127.0.0.1:3317",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
