import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

/** Data travels through a real browser download/upload, then a transactional API merge. */
test("Settings exports, previews and merges a backup without duplicating existing data", async ({ page }) => {
  const title = `backup-roundtrip-${randomUUID()}`;
  const created = await page.request.post("/api/apps/tasks/tasks", { data: { title, priority: 2 } });
  expect(created.status()).toBe(201);
  const task = await created.json() as { id: string };
  try {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Data management", exact: true })).toBeVisible();
    await expect(page.getByLabel("Data scope")).toHaveValue("own");
    await expect(page.getByLabel("Data scope").getByRole("option", { name: "All users (administrator)" })).toHaveCount(1);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export backup", exact: true }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).toBeTruthy();
    const buffer = await readFile(path!);
    expect((await page.request.delete(`/api/apps/tasks/tasks/${task.id}`)).status()).toBe(204);

    await page.getByLabel("Backup file").setInputFiles({ name: "saved-backup.json", mimeType: "application/json", buffer });
    await page.getByRole("button", { name: "Preview merge", exact: true }).click();
    await expect(page.getByTestId("merge-preview")).toBeVisible();
    // Preview never mutates the target database.
    expect((await page.request.get(`/api/apps/tasks/tasks/${task.id}`)).status()).toBe(404);
    await page.getByRole("button", { name: "Merge missing data", exact: true }).click();
    await expect(page.getByText(/Merge complete:/)).toBeVisible();
    const restored = await page.request.get(`/api/apps/tasks/tasks/${task.id}`);
    expect(restored.status()).toBe(200);
    expect((await restored.json()).title).toBe(title);

    // Re-importing the same historical backup must preserve existing records.
    await page.getByLabel("Backup file").setInputFiles({ name: "saved-backup.json", mimeType: "application/json", buffer });
    await page.getByRole("button", { name: "Preview merge", exact: true }).click();
    await expect(page.getByTestId("merge-preview")).toBeVisible();
    await page.getByRole("button", { name: "Merge missing data", exact: true }).click();
    await expect(page.getByText(/Merge complete: 0 added/)).toBeVisible();
    await page.reload();
    expect((await page.request.get(`/api/apps/tasks/tasks/${task.id}`)).status()).toBe(200);
  } finally {
    await page.request.delete(`/api/apps/tasks/tasks/${task.id}`);
  }
});

test("ordinary users only see their own backup scope and cannot export the site", async ({ browser, page }) => {
  const username = `backup-user-${randomUUID().slice(0, 8)}`;
  const password = "backup-e2e-password-1";
  const created = await page.request.post("/api/core/auth/users", { data: { username, password } });
  expect(created.status()).toBe(201);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const ownPage = await context.newPage();
    const login = await context.request.post("http://127.0.0.1:5199/api/core/auth/login", { data: { username, password } });
    expect(login.status()).toBe(200);
    await ownPage.goto("http://127.0.0.1:5199/settings");
    await expect(ownPage.getByLabel("Data scope").getByRole("option")).toHaveCount(1);
    await expect(ownPage.getByLabel("Backup scope").getByRole("option")).toHaveCount(1);
    const denied = await context.request.get("http://127.0.0.1:5199/api/core/data/export?scope=all");
    expect(denied.status()).toBe(403);
  } finally {
    await context.close();
  }
});

test("Settings data panels remain usable on desktop and mobile", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings");
  await expect(page.getByLabel("WebDAV folder URL")).toBeVisible();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const panels = page.locator(".data-management");
    await expect(panels).toHaveCount(2);
    for (const panel of await panels.all()) {
      const bounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: testInfo.outputPath(`settings-${viewport.width}.png`), animations: "disabled" });
    await page.getByRole("heading", { name: "WebDAV backup", exact: true }).evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
    await expect.poll(async () => (await page.getByLabel("WebDAV folder URL").boundingBox())!.y).toBeLessThan(300);
    await page.screenshot({ path: testInfo.outputPath(`settings-webdav-${viewport.width}.png`), animations: "disabled" });
  }
});
