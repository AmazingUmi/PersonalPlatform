import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test as base, type Locator, type Page } from "@playwright/test";

const test = base.extend<{ ownPage: Page }>({
  ownPage: async ({ browser, page, baseURL }, use) => {
    const username = `trash-user-${randomUUID().slice(0, 8)}`;
    const password = "trash-e2e-password-1";
    const created = await page.request.post("/api/core/auth/users", { data: { username, password } });
    expect(created.status()).toBe(201);

    const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      const login = await context.request.post("/api/core/auth/login", { data: { username, password } });
      expect(login.status()).toBe(200);
      await use(await context.newPage());
    } finally {
      await context.close();
    }
  },
});

async function seed(page: Page, path: string, data: Record<string, unknown>): Promise<string> {
  const response = await page.request.post(path, { data });
  expect(response.status(), `${path}: ${await response.text()}`).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function moveToTrash(page: Page, button: Locator): Promise<void> {
  const dialog = page.getByTestId("confirm-dialog");
  await button.click();
  await expect(dialog.getByText(/Move .* to Trash/)).toBeVisible();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function restoreFromTrash(page: Page, name: string, pathPrefix: string, originalId: string): Promise<string> {
  await page.goto("/settings?section=trash");
  await page.getByRole("button", { name: `Restore ${name}`, exact: true }).click();
  await expect(page.getByText("Item restored.")).toBeVisible();
  const open = page.getByRole("link", { name: "Open restored item" });
  const path = await open.getAttribute("href");
  expect(path?.startsWith(pathPrefix)).toBe(true);
  const restoredId = path!.slice(pathPrefix.length);
  expect(restoredId).toMatch(/^[0-9a-f-]{36}$/);
  expect(restoredId).not.toBe(originalId);
  await open.click();
  await expect(page).toHaveURL(url => url.pathname === path);
  return restoredId;
}

async function purgeFromTrash(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: `Permanently delete ${name}`, exact: true }).click();
  await page.getByTestId("confirm-dialog").getByRole("button", { name: "Permanent Delete" }).click();
  await expect(page.getByText("Item permanently deleted.")).toBeVisible();
  await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
}

test("an ordinary user can restore a deleted alarm and manage Trash in Settings", async ({ ownPage }) => {
  const alarmLabel = "Archive alarm";
  const taskTitle = "Archive task";
  const originalAlarmId = await seed(ownPage, "/api/apps/clock/alarms", { time: "06:50", label: alarmLabel, enabled: false, repeatDays: [] });
  const taskId = await seed(ownPage, "/api/apps/tasks/tasks", { title: taskTitle });

  await ownPage.goto("/clock");
  const alarm = ownPage.locator(".clock-alarm").filter({ hasText: alarmLabel });
  const deleteAlarm = alarm.getByRole("button", { name: "Delete alarm 06:50" });
  await moveToTrash(ownPage, deleteAlarm);
  await expect(alarm).toHaveCount(0);
  expect((await ownPage.request.delete(`/api/apps/tasks/tasks/${taskId}`)).status()).toBe(204);

  await ownPage.goto("/settings?keep=example");
  await ownPage.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Trash" }).click();
  expect(new URL(ownPage.url()).searchParams.get("section")).toBe("trash");
  expect(new URL(ownPage.url()).searchParams.get("keep")).toBe("example");
  await expect(ownPage.getByRole("heading", { name: taskTitle })).toBeVisible();
  await ownPage.getByRole("combobox", { name: "App", exact: true }).selectOption("clock");
  await expect(ownPage.getByRole("heading", { name: taskTitle })).toHaveCount(0);
  await ownPage.getByRole("button", { name: `Restore ${alarmLabel}` }).click();
  await expect(ownPage.getByText("Item restored.")).toBeVisible();
  const open = ownPage.getByRole("link", { name: "Open restored item" });
  const restoredAlarmId = new URL((await open.getAttribute("href"))!, ownPage.url()).searchParams.get("alarm");
  expect(restoredAlarmId).toMatch(/^[0-9a-f-]{36}$/);
  expect(restoredAlarmId).not.toBe(originalAlarmId);
  await open.click();
  await expect(alarm).toHaveAttribute("aria-current", "true");
  await ownPage.reload();
  await expect(alarm).toHaveAttribute("aria-current", "true");
  await moveToTrash(ownPage, deleteAlarm);
  await expect(alarm).toHaveCount(0);

  await ownPage.goto("/settings?section=trash");
  await purgeFromTrash(ownPage, taskTitle);
  await expect(ownPage.getByRole("heading", { name: alarmLabel })).toBeVisible();
  await ownPage.getByRole("button", { name: "Empty Trash" }).click();
  await ownPage.getByTestId("confirm-dialog").getByRole("button", { name: "Empty Trash" }).click();
  await expect(ownPage.getByText("Trash emptied.")).toBeVisible();
  await expect(ownPage.getByText("No items in Trash")).toBeVisible();
});

test("a task restores to a fresh deep link and can be deleted again", async ({ ownPage }) => {
  const title = "Task to restore";
  const description = "Task detail retained across the Trash cycle.";
  const originalId = await seed(ownPage, "/api/apps/tasks/tasks", { title, description });
  await ownPage.goto("/tasks");
  const deleteTask = ownPage.getByRole("button", { name: `Delete task "${title}"` });
  await moveToTrash(ownPage, deleteTask);
  await expect(deleteTask).toHaveCount(0);

  await restoreFromTrash(ownPage, title, "/tasks/", originalId);
  await expect(ownPage.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await ownPage.reload();
  await expect(ownPage.getByText(description, { exact: true })).toBeVisible();
  await ownPage.locator(".page-header__actions").getByRole("link", { name: "Tasks", exact: true }).click();
  await moveToTrash(ownPage, deleteTask);
  await expect(deleteTask).toHaveCount(0);
  await ownPage.goto("/settings?section=trash");
  await purgeFromTrash(ownPage, title);
  await expect(ownPage.getByText("No items in Trash")).toBeVisible();
});

test("a note restores its content and tag through a fresh editor link", async ({ ownPage }) => {
  const title = "Note to restore";
  const content = "The entire note body survives the Trash cycle.";
  const tagName = "Archived research";
  const tagId = await seed(ownPage, "/api/apps/notes/tags", { name: tagName });
  const originalId = await seed(ownPage, "/api/apps/notes/notes", { title, content, tagIds: [tagId] });
  await ownPage.goto(`/notes/${originalId}`);
  const deleteNote = ownPage.getByRole("button", { name: "Delete", exact: true });
  await moveToTrash(ownPage, deleteNote);
  await expect(ownPage).toHaveURL(/\/notes$/);

  await restoreFromTrash(ownPage, title, "/notes/", originalId);
  await ownPage.reload();
  await expect(ownPage.getByLabel("Note title")).toHaveValue(title);
  await expect(ownPage.getByLabel("Note content")).toHaveValue(content);
  await expect(ownPage.getByRole("button", { name: `Toggle tag ${tagName}` })).toHaveAttribute("aria-pressed", "true");
  await moveToTrash(ownPage, deleteNote);
  await expect(ownPage).toHaveURL(/\/notes$/);
  await ownPage.goto("/settings?section=trash");
  await purgeFromTrash(ownPage, title);
  await expect(ownPage.getByText("No items in Trash")).toBeVisible();
});

test("an asset restores to a fresh detail link with a readable attachment", async ({ ownPage }) => {
  const title = "Asset to restore";
  const categoryName = "Archived equipment";
  const categoryId = await seed(ownPage, "/api/apps/assets/categories", { name: categoryName, color: "violet" });
  const originalId = await seed(ownPage, "/api/apps/assets/items", { name: title, categoryIds: [categoryId] });
  const filename = "archive-payload.bin";
  const bytes = Buffer.from([0, 201, 17, 255, 10]);
  const uploaded = await ownPage.request.post(`/api/apps/assets/items/${originalId}/attachments`, {
    multipart: { file: { name: filename, mimeType: "application/octet-stream", buffer: bytes } },
  });
  expect(uploaded.status()).toBe(201);
  const originalAttachmentId = (await uploaded.json() as { id: string }).id;

  await ownPage.goto(`/assets/items/${originalId}`);
  const deleteAsset = ownPage.getByRole("button", { name: "Delete", exact: true });
  await moveToTrash(ownPage, deleteAsset);
  await expect(ownPage).toHaveURL(/\/assets$/);

  const restoredId = await restoreFromTrash(ownPage, title, "/assets/items/", originalId);
  await ownPage.reload();
  await expect(ownPage.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(ownPage.getByText(categoryName, { exact: true })).toBeVisible();
  const attachment = ownPage.getByRole("link", { name: filename, exact: true });
  const restoredAttachmentPath = await attachment.getAttribute("href");
  expect(restoredAttachmentPath).toContain(`/api/apps/assets/items/${restoredId}/attachments/`);
  expect(restoredAttachmentPath?.split("/").pop()).not.toBe(originalAttachmentId);
  const downloading = ownPage.waitForEvent("download");
  await attachment.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await readFile((await download.path())!)).toEqual(bytes);

  await moveToTrash(ownPage, deleteAsset);
  await expect(ownPage).toHaveURL(/\/assets$/);
  await ownPage.goto("/settings?section=trash");
  await purgeFromTrash(ownPage, title);
  await expect(ownPage.getByText("No items in Trash")).toBeVisible();
});
