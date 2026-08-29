import assert from "node:assert/strict";
import { expect, test, type Page } from "@playwright/test";

/**
 * Key end-to-end flows for the three validation apps plus the disable/enable
 * lifecycle, driven through the real shell. The stack (backend + vite) is
 * managed by playwright webServer config against the E2E database.
 */

const CORE = "http://127.0.0.1:8902";

async function setAppEnabled(id: string, enabled: boolean): Promise<void> {
  const response = await fetch(`${CORE}/api/core/apps/${id}/enabled`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error(`toggle ${id} failed: HTTP ${response.status}`);
}

test.beforeAll(async () => {
  // Deterministic start: all three apps enabled.
  await setAppEnabled("assets", true);
  await setAppEnabled("tasks", true);
  await setAppEnabled("mini_game", true);
});

test("shell loads with navigation and all three apps enabled", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "App Center" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Assets" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("link", { name: /2048/ })).toBeVisible();
});

test("dashboard renders one widget per validation app", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Asset Summary")).toBeVisible();
  await expect(page.getByText("Tasks Today")).toBeVisible();
  await expect(page.getByText("2048 High Score")).toBeVisible();
});

async function createItemViaDialog(page: Page, name: string) {
  await page.getByRole("button", { name: /new item/i }).click();
  await page.getByLabel("Item name").fill(name);
  await page.getByRole("button", { name: /create item/i }).click();
  await expect(page.getByTestId("item-editor")).toHaveCount(0);
}

test("assets: create, search and see the item", async ({ page }) => {
  await page.goto("/assets");
  const name = `e2e-item-${Date.now()}`;
  await createItemViaDialog(page, name);
  await expect(page.getByRole("link", { name })).toBeVisible();

  await page.getByPlaceholder("Search items…").fill(name);
  await expect(page.getByRole("link", { name })).toBeVisible();
  await page.getByPlaceholder("Search items…").fill("definitely-no-such-item-xyz");
  await expect(page.getByRole("link", { name })).toHaveCount(0);
});

test("tasks: create a task and complete it", async ({ page }) => {
  await page.goto("/tasks");
  const title = `e2e-task-${Date.now()}`;
  await page.getByRole("button", { name: /new task/i }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByTestId("task-editor").getByLabel("Priority").selectOption("3");
  await page.getByRole("button", { name: /create task/i }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByText("Urgent")).toBeVisible();

  // Click (not check): completion re-fetches the list, replacing the row node.
  await row.getByRole("checkbox").click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveClass(/task--done/);

  // Filter keeps it under "Done".
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();

  // Deleting asks for confirmation first.
  const doomed = page.getByRole("listitem").filter({ hasText: title });
  await doomed.getByRole("button", { name: new RegExp(`delete task "${title}"`, "i") }).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
});

test("mini game: board renders, tiles move and the game saves", async ({ page }) => {
  await page.goto("/mini_game");
  const cells = page.locator(".game__cell, .game-cell");
  await expect(cells).toHaveCount(16);

  const nonEmptyBefore = await page.locator(".game__cell:not(:empty), .game-cell:not(:empty)").count();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => page.locator(".game__cell:not(:empty), .game-cell:not(:empty)").count())
    .toBeGreaterThanOrEqual(nonEmptyBefore);

  // Save indicator flips to Saved after a move (debounced/immediate PUT).
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "New Game" }).click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });
});

test("disabling an app removes its nav, page and widget; data survives", async ({ page }) => {
  const marker = `keep-me-${Date.now()}`;
  await page.goto("/assets");
  await createItemViaDialog(page, marker);
  await expect(page.getByRole("link", { name: marker })).toBeVisible();

  await setAppEnabled("assets", false);

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Assets" })).toHaveCount(0);
  await expect(page.getByText("Asset Summary")).toHaveCount(0);
  await page.goto("/assets");
  await expect(page.getByRole("heading", { name: "Not Found" })).toBeVisible();

  // Backend keeps the data while disabled (404 on the API, rows intact).
  const apiDisabled = await page.request.get(`${CORE}/api/apps/assets/items`);
  expect(apiDisabled.status()).toBe(404);

  await setAppEnabled("assets", true);
  await page.goto("/assets");
  await expect(page.getByRole("link", { name: marker })).toBeVisible();
  await expect(page.getByRole("link", { name: "Assets" })).toBeVisible();
});

test("app center lists all apps with status and toggles", async ({ page }) => {
  await page.goto("/apps");
  const list = page.locator(".app-grid");
  await expect(list.getByText("Assets")).toBeVisible();
  await expect(list.getByText("Tasks")).toBeVisible();
  await expect(list.getByText("Mini Game (2048)")).toBeVisible();

  const assetsCard = page.locator(".app-card").filter({ hasText: "Assets" });
  await assetsCard.getByRole("button", { name: "Disable" }).click();
  await expect(assetsCard.getByText("disabled")).toBeVisible();
  await assetsCard.getByRole("button", { name: "Enable" }).click();
  await expect(assetsCard.getByText("enabled")).toBeVisible();
});

test("dashboard: clicking a widget card navigates to its app", async ({ page }) => {
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today"] },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /open 2048 high score/i }).click();
  await expect(page).toHaveURL(/\/mini_game$/);
});

test("dashboard: drag reorder persists after reload", async ({ page }) => {
  // Deterministic baseline: reset the persisted layout via the settings API.
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today"] },
  });
  await page.goto("/");
  await expect(page.locator(".dashboard-card [data-widget-key]")).toHaveCount(3);
  const orderBefore = await page
    .locator(".dashboard-card [data-widget-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-key")));

  await page.getByRole("button", { name: /edit layout/i }).click();
  // Drag the first card's handle below the last card via pointer events.
  const handles = page.locator(".drag-handle");
  const sourceBox = await handles.first().boundingBox();
  const targetBox = await handles.last().boundingBox();
  assert(sourceBox && targetBox, "drag handle boxes resolved");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2 + 40, {
    steps: 15,
  });
  await page.mouse.up();

  // Let the dnd-kit drop animation settle, then read the new order.
  await page.waitForTimeout(600);
  const orderAfterDrag = (await page
    .locator(".dashboard-card [data-widget-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-key")))) as string[];
  assert.notDeepEqual(orderAfterDrag, orderBefore, "drag actually reordered the widgets");
  assert.equal(orderAfterDrag.length, 3);

  await page.getByRole("button", { name: "Done", exact: true }).click();
  // Done persists asynchronously; wait until the shell returns to normal mode
  // so the reload cannot cancel the PUT mid-flight.
  await expect(page.getByRole("button", { name: /edit layout/i })).toBeVisible();
  await page.reload();
  await expect(page.locator(".dashboard-card [data-widget-key]")).toHaveCount(3);
  const orderAfterReload = await page
    .locator(".dashboard-card [data-widget-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-key")));
  expect(orderAfterReload).toEqual(orderAfterDrag);

  // Reset the persisted layout for the following tests (no hidden widgets ->
  // no in-page restore button, so reset through the settings API).
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today"] },
  });
});

test("dashboard: hide and show widgets persist after reload", async ({ page }) => {
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today"] },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /edit layout/i }).click();
  await page.getByRole("button", { name: /hide asset summary/i }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: /edit layout/i })).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-widget-key="assets:summary"]')).toHaveCount(0);
  await expect(page.getByText(/1 widget\(s\) hidden/)).toBeVisible();

  // Show it again through edit mode.
  await page.getByRole("button", { name: /edit layout/i }).click();
  await page.getByRole("button", { name: /asset summary/i }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: /edit layout/i })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-widget-key="assets:summary"]')).toHaveCount(1);
});
