import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as setup } from "@playwright/test";

/**
 * Session setup for the e2e project (AUTH-5): log in once as the backend's
 * bootstrap admin and persist the HttpOnly session cookie as storage state.
 *
 * The backend is bootstrapped by playwright.config.ts with these exact
 * credentials. Bootstrap is idempotent but NEVER resets an already-activated
 * password — when a reused server / persistent e2e database carries an admin
 * with a different password this login fails, and the error below says so
 * instead of leaving every test to 401 mysteriously.
 */

/** frontend/playwright/.auth/user.json — matches the e2e project's storageState. */
const STATE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "playwright",
  ".auth",
  "user.json",
);

setup("authenticate as the bootstrap admin", async ({ request }) => {
  const response = await request.post("http://127.0.0.1:8902/api/core/auth/login", {
    data: { username: "e2e-admin", password: "e2e-admin-password-1" },
  });
  if (!response.ok()) {
    throw new Error(
      `e2e admin login failed: HTTP ${response.status()} ${await response.text()} — ` +
        "the e2e database must be fresh or already bootstrapped with the credentials in " +
        "playwright.config.ts (BOOTSTRAP_ADMIN_USERNAME/PASSWORD). A reused local backend " +
        "bootstrapped with a different admin password cannot be reset from here; point " +
        "E2E_DATABASE_URL at a fresh database or re-run bootstrap:admin.",
    );
  }
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  await request.storageState({ path: STATE_FILE });
});
