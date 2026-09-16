import { expect, test } from "@playwright/test";

/**
 * Session boundary e2e (AUTH-5): the shell is unreachable without a session,
 * the login form is the only door in, and the topbar logout closes it again.
 *
 * Every test here deliberately runs with an EMPTY storage state instead of
 * the shared setup session: logout deletes its session row server-side, so
 * consuming the setup cookie would starve every later spec of authentication.
 * Login flows mint (and destroy) their own sessions.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("unauthenticated: / lands on the login page and the API answers 401", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "System Login" })).toBeVisible();

  // No cookie in this context: the app API itself rejects the request.
  const me = await page.request.get("/api/core/auth/me");
  expect(me.status()).toBe(401);
});

test("unauthenticated: app routes redirect to /login", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "System Login" })).toBeVisible();
});

test("wrong password shows the access-denied message and keeps the form", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("e2e-admin");
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Log In ▸" }).click();

  await expect(page.getByText(/Access denied — unknown user or wrong password/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  // The form stays usable for a retry.
  await expect(page.getByRole("button", { name: "Log In ▸" })).toBeVisible();
});

test("login via the form reaches the dashboard; logout returns to the login page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("e2e-admin");
  await page.getByLabel("Password").fill("e2e-admin-password-1");
  await page.getByRole("button", { name: "Log In ▸" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 10_000 });
  // The topbar account chip names the signed-in admin session.
  await expect(page.locator(".topbar__user")).toHaveAttribute("title", "Signed in as e2e-admin (admin)");

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "System Login" })).toBeVisible();

  // The logged-out session cookie is dead: app routes redirect to /login again.
  await page.goto("/tasks");
  await expect(page).toHaveURL(/\/login$/);
});
