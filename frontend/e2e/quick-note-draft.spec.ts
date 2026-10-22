import { expect, test, type Route } from "@playwright/test";
import { adminFetch } from "./helpers";

test("quick note preserves a newer draft while its submitted snapshot is saved", async ({ page }) => {
  const enabled = await adminFetch("PUT", "/api/core/apps/notes/enabled", { enabled: true });
  expect(enabled.status).toBe(200);
  // A previous platform spec can leave the widget hidden. Start from the
  // default composition rather than depending on persisted dashboard state.
  const layout = await adminFetch("PUT", "/api/core/settings/dashboard.widgets", { value: null });
  expect(layout.status).toBe(200);

  const submitted = `e2e submitted quick note ${Date.now()}`;
  const draft = `${submitted} - newer unsaved draft`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pendingRoute: Promise<void> | undefined;
  let savedId: string | undefined;
  const pattern = "**/api/apps/notes/notes";
  const handler = (route: Route): Promise<void> => {
    if (route.request().method() !== "POST") return route.continue();
    pendingRoute = (async () => {
      await gate;
      // Release the real request to the real backend, never fulfill a mock
      // response: the API assertion below checks actual persistence.
      await route.continue();
    })();
    return pendingRoute;
  };
  await page.route(pattern, handler);
  try {
    await page.goto("/");
    const card = page.locator('[data-widget-key="notes:quick_note"]');
    await expect(card).toBeVisible();
    const input = card.getByLabel("Quick note content");
    await input.fill(submitted);
    const intercepted = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/api/apps/notes/notes" && request.method() === "POST",
    { timeout: 10_000 });
    await card.getByRole("button", { name: "Save", exact: true }).click();
    expect((await intercepted).postDataJSON().content).toBe(submitted);
    await expect(input).toBeEditable();
    await input.fill(draft);
    await expect(card.getByRole("button", { name: "Saving…" })).toBeDisabled();

    const savedResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/apps/notes/notes" && response.request().method() === "POST",
    );
    release();
    const response = await savedResponse;
    expect(response.status()).toBe(201);
    savedId = (await response.json()).id as string;
    await expect(card.getByText("Saved", { exact: true })).toBeVisible();
    await expect(input).toHaveValue(draft);
    await expect(card.getByRole("link", { name: "Open" })).toHaveAttribute("href", `/notes/${savedId}`);

    const persisted = await adminFetch("GET", `/api/apps/notes/notes/${savedId}`);
    expect(persisted.status).toBe(200);
    expect((await persisted.json()).content).toBe(submitted);
  } finally {
    release();
    await pendingRoute;
    await page.unroute(pattern, handler);
    if (savedId) await adminFetch("DELETE", `/api/apps/notes/notes/${savedId}`);
  }
});
