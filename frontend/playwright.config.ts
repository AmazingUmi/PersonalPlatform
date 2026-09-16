import { defineConfig } from "@playwright/test";

/**
 * E2E runs the real stack: backend (tsx) against the E2E database plus the
 * Vite dev server proxying /api. Uses the locally installed Google Chrome
 * (channel: "chrome") so no browser download is required.
 *
 * AUTH-5: the shell is unreachable without a session. The `setup` project
 * (e2e/auth.setup.ts) logs in as the backend's bootstrap admin and saves the
 * pp_session cookie to playwright/.auth/user.json; every `e2e` project test
 * starts from that storage state. The backend env below bootstraps the admin
 * account with fixed credentials — bootstrap is idempotent and NEVER resets
 * an already-activated password, so the e2e database must be fresh or already
 * bootstrapped with these exact credentials (CI recreates it each run).
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
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: "e2e",
      testIgnore: /.*\.setup\.ts/,
      dependencies: ["setup"],
      use: {
        storageState: "playwright/.auth/user.json",
      },
    },
  ],
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
        BOOTSTRAP_ADMIN_USERNAME: "e2e-admin",
        BOOTSTRAP_ADMIN_PASSWORD: "e2e-admin-password-1",
      },
    },
    {
      // Bind IPv4 explicitly: the health poll and baseURL use 127.0.0.1, and
      // on hosts where `localhost` resolves to ::1 vite would otherwise never
      // answer on the polled address.
      command: "npx vite --port 5199 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5199",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        VITE_API_PROXY_TARGET: "http://127.0.0.1:8902",
      },
    },
  ],
});
