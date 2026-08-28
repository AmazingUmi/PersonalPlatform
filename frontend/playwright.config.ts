import { defineConfig } from "@playwright/test";

/**
 * E2E runs the real stack: backend (tsx) against the E2E database plus the
 * Vite dev server proxying /api. Uses the locally installed Google Chrome
 * (channel: "chrome") so no browser download is required.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5199",
    channel: "chrome",
    headless: true,
  },
  webServer: [
    {
      command: "npx tsx backend/src/main.ts",
      cwd: "..",
      url: "http://127.0.0.1:8902/api/core/health/live",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        DATABASE_URL:
          process.env.E2E_DATABASE_URL ??
          "postgresql://personal_platform:change-me-for-local-development@127.0.0.1:5439/personal_platform_e2e",
        PORT: "8902",
        HOST: "127.0.0.1",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: "npx vite --port 5199 --strictPort",
      url: "http://127.0.0.1:5199",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        VITE_API_PROXY_TARGET: "http://127.0.0.1:8902",
      },
    },
  ],
});
