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
    await page.goto("/settings?section=data");
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

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose file", exact: true }).click();
    await (await chooserPromise).setFiles({ name: "saved-backup.json", mimeType: "application/json", buffer });
    await page.getByRole("button", { name: "Preview merge", exact: true }).click();
    await expect(page.getByTestId("merge-preview")).toBeVisible();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: /^General/ }).click();
    await expect(page.getByTestId("merge-preview")).toBeHidden();
    await page.goBack();
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
    await ownPage.goto("http://127.0.0.1:5199/settings?section=users");
    await expect(ownPage.getByRole("heading", { name: "System", exact: true })).toBeVisible();
    await expect(ownPage.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: /^Users/ })).toHaveCount(0);
    await ownPage.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: /^Data/ }).click();
    await expect(ownPage.getByLabel("Data scope").getByRole("option")).toHaveCount(1);
    await ownPage.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: /^WebDAV/ }).click();
    await expect(ownPage.getByLabel("Backup scope").getByRole("option")).toHaveCount(1);
    const denied = await context.request.get("http://127.0.0.1:5199/api/core/data/export?scope=all");
    expect(denied.status()).toBe(403);
  } finally {
    await context.close();
  }
});

/** Browser interaction contract; DAV transport/storage are covered by backend integration tests. */
test("WebDAV defaults to incremental, explains unchanged data and offers manual full backup", async ({ page }) => {
  const requestedModes: string[] = [];
  await page.route("**/api/core/data/webdav", route => route.fulfill({ json: {
    configured: true, endpoint: "https://drive.example.com/backups/", username: "backup-user", hasPassword: true,
    scope: "own", intervalHours: 24, nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null,
  } }));
  await page.route("**/api/core/data/webdav/history", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/core/data/webdav/backup", route => {
    const mode = route.request().postDataJSON().mode as string;
    requestedModes.push(mode);
    if (requestedModes.length === 2) return route.fulfill({ json: { status: "unchanged", backup: null, uploadedBytes: 0, uploadedObjects: 0 } });
    return route.fulfill({ json: {
      status: "created", uploadedBytes: 1024, uploadedObjects: 1,
      backup: { id: `backup-${requestedModes.length}`, filename: `${mode}.json`, kind: mode, scope: "own", createdAt: "2026-11-01T12:00:00Z", size: 4096, available: true, uploadedBytes: 1024, uploadedObjects: 1 },
    } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings?section=webdav&view=backup");
  await expect(page.getByLabel("Manual backup mode")).toHaveValue("incremental");
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(page.getByText(/Backup saved: incremental.json/)).toBeVisible();
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(page.getByText("Data is unchanged. Nothing was uploaded and no new backup was created.")).toBeVisible();
  await page.getByLabel("Manual backup mode").selectOption("full");
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(page.getByText(/Backup saved: full.json/)).toBeVisible();
  expect(requestedModes).toEqual(["incremental", "incremental", "full"]);
  await page.getByRole("link", { name: "Connection", exact: true }).click();
  await expect(page.getByLabel("Automatic backup")).toHaveValue("24");
  await page.goBack();
  const bounds = await page.getByLabel("Manual backup mode").boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
});

test("Settings navigation and controls remain usable on desktop and mobile", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings");
  for (const viewport of [{ width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    for (const section of ["General", "Data", "WebDAV", "Users"]) {
      await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: new RegExp(`^${section}`) }).click();
      if (section === "WebDAV") await expect(page.getByLabel("WebDAV folder URL")).toBeVisible();
      if (section === "Data") {
        const chooser = page.getByRole("button", { name: "Choose file", exact: true });
        await expect(chooser).toHaveClass(/px-button--md/);
        await expect(page.getByLabel("Backup file")).toBeHidden();
      }
      const panels = page.locator(".px-window:visible");
      expect(await panels.count()).toBeGreaterThan(0);
      for (const panel of await panels.all()) {
        const bounds = await panel.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({ path: testInfo.outputPath(`settings-${section.toLowerCase()}-${viewport.width}.png`), animations: "disabled" });
      if (section === "Data" && viewport.width === 390) {
        await page.getByRole("button", { name: "Choose file", exact: true }).evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
        await expect.poll(async () => (await page.getByRole("button", { name: "Choose file", exact: true }).boundingBox())!.y).toBeLessThan(650);
        await page.screenshot({ path: testInfo.outputPath("settings-file-picker-mobile.png"), animations: "disabled" });
      }
    }
  }
});

test("Settings history paginates and reviews into Data without losing a draft on failure", async ({ page }, testInfo) => {
  const filenames = Array.from({ length: 11 }, (_, index) => `personal-platform-incremental-${index}-${"a".repeat(64)}.json`);
  let historySize = 11;
  await page.route("**/api/core/data/webdav", route => route.fulfill({ json: {
    configured: true, endpoint: "https://drive.example.com/backups/", username: "backup-user", hasPassword: true,
    scope: "own", intervalHours: 24, nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null,
  } }));
  await page.route("**/api/core/data/webdav/history", route => route.fulfill({ json: { items: filenames.slice(0, historySize).map((filename, index) => ({
    id: `backup-${index}`, filename, kind: "incremental", scope: "own", createdAt: "2026-11-01T12:00:00Z",
    size: 4096, available: true, uploadedBytes: 1024, uploadedObjects: 1,
  })) } }));
  let failDownload = true;
  await page.route("**/api/core/data/webdav/files/*", route => failDownload
    ? route.fulfill({ status: 502, json: { error: { message: "Remote file is unavailable." } } })
    : route.fulfill({ contentType: "application/json", headers: { "content-disposition": 'attachment; filename="remote.json"' }, body: '{"scope":"own"}' }));
  await page.route("**/api/core/data/preview", route => route.fulfill({ json: {
    scope: "own", createdAt: "2026-11-01T12:00:00Z", files: 0, inserted: 1, skipped: 0,
    tables: [{ table: "tasks.tasks", inserted: 1, skipped: 0, conflicts: 0 }],
  } }));
  await page.goto("/settings?section=data&keep=example");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file", exact: true }).focus();
  await page.keyboard.press("Enter");
  await (await chooserPromise).setFiles({ name: "local-draft.json", mimeType: "application/json", buffer: Buffer.from('{"scope":"own"}') });
  await expect(page.getByText("Selected: local-draft.json")).toBeVisible();
  await page.getByRole("link", { name: /^WebDAV/ }).click();
  await page.getByLabel("WebDAV folder URL").fill("https://unsaved.example.com/backups/");
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.getByRole("link", { name: "Connection", exact: true }).click();
  await expect(page.getByLabel("WebDAV folder URL")).toHaveValue("https://unsaved.example.com/backups/");
  await page.getByLabel("WebDAV folder URL").fill("https://drive.example.com/backups/");
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(10);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page).toHaveURL(/keep=example/);
  await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: testInfo.outputPath("settings-history-mobile.png"), animations: "disabled", fullPage: true });
  await page.getByRole("button", { name: `Review ${filenames[10]} for import`, exact: true }).click();
  await expect(page).toHaveURL(/section=data/);
  await expect(page.getByText("Remote file is unavailable.")).toBeVisible();
  await expect(page.getByText("Selected: local-draft.json")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Data management", exact: true })).toBeFocused();
  await page.goBack();
  failDownload = false;
  await page.getByRole("button", { name: `Review ${filenames[10]} for import`, exact: true }).click();
  await expect(page.getByTestId("merge-preview")).toBeVisible();
  await expect(page.getByText(`Selected: ${filenames[10]}`)).toBeVisible();
  await page.goBack();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(1);
  historySize = 1;
  await page.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(page.getByRole("button", { name: `Download ${filenames[0]}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
});
