import assert from "node:assert/strict";
import { expect, test, type Page } from "@playwright/test";

/**
 * Key end-to-end flows for the four validation apps plus the disable/enable
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
  // Deterministic start: all four apps enabled.
  await setAppEnabled("assets", true);
  await setAppEnabled("tasks", true);
  await setAppEnabled("mini_game", true);
  await setAppEnabled("focus", true);
});

test("shell loads with navigation and all four apps enabled", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "App Center" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Assets" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("link", { name: /2048/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Focus", exact: true })).toBeVisible();
});

test("dashboard renders one widget per validation app", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Asset Summary")).toBeVisible();
  await expect(page.getByText("Tasks Today")).toBeVisible();
  await expect(page.getByText("2048 High Score")).toBeVisible();
  await expect(page.getByText("Focus Timer")).toBeVisible();
});

async function createItemViaDialog(page: Page, name: string) {
  // Scoped to the header: the empty-inventory state renders a second
  // "New Item" CTA, which would trip strict mode on a fresh database.
  await page.locator(".page-header__actions").getByRole("button", { name: /new item/i }).click();
  await page.getByLabel("Item name").fill(name);
  await page.getByRole("button", { name: /create item/i }).click();
  await expect(page.getByTestId("item-editor")).toHaveCount(0);
}

test("assets: create, search and see the item", async ({ page }) => {
  await page.goto("/assets");
  const name = `e2e-item-${Date.now()}`;
  await createItemViaDialog(page, name);
  await expect(page.getByRole("link", { name })).toBeVisible();

  // The search box lives in the collapsed filters panel; expand it first.
  await page.getByRole("button", { name: /filters/i }).click();
  await page.getByPlaceholder("Search name or category…").fill(name);
  await expect(page.getByRole("link", { name })).toBeVisible();
  await page.getByPlaceholder("Search name or category…").fill("definitely-no-such-item-xyz");
  await expect(page.getByRole("link", { name })).toHaveCount(0);
});

test("tasks: create a task and complete it", async ({ page }) => {
  await page.goto("/tasks");
  const title = `e2e-task-${Date.now()}`;
  // Header button, not the empty-state CTA with the same name (fresh DB).
  await page.locator(".page-header__actions").getByRole("button", { name: /new task/i }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByTestId("task-editor").getByLabel("Priority").selectOption("3");
  await page.getByRole("button", { name: /create task/i }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByText("Urgent")).toBeVisible();

  // Click (not check): completion re-fetches the list, replacing the row node.
  await row.getByRole("checkbox").click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveClass(/task--done/);

  // Filters live behind the collapsed header button; open, then filter Done.
  await page.getByRole("button", { name: /filters/i }).click();
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
  // exact: the Focus description ("...focus history...") also contains the
  // word case-insensitively, so match the full name cell only.
  await expect(list.getByText("Focus", { exact: true })).toBeVisible();

  const assetsCard = page.locator(".app-card").filter({ hasText: "Assets" });
  await assetsCard.getByRole("button", { name: "Disable" }).click();
  await expect(assetsCard.getByText("disabled")).toBeVisible();
  await assetsCard.getByRole("button", { name: "Enable" }).click();
  await expect(assetsCard.getByText("enabled")).toBeVisible();
});

test("dashboard: clicking a widget card navigates to its app", async ({ page }) => {
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"] },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /open 2048 high score/i }).click();
  await expect(page).toHaveURL(/\/mini_game$/);
});

test("dashboard: free-layout drag persists after reload (V1 -> V2)", async ({ page }) => {
  // Deterministic baseline: a legacy V1 order also exercises the read-side
  // migration in a real browser.
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"] },
  });
  await page.goto("/");
  await expect(page.locator(".dashboard-canvas[data-desktop='true']")).toBeVisible();
  await expect(page.locator(".dashboard-card [data-widget-key]")).toHaveCount(4);

  const cardBox = (key: string) =>
    page.locator(`.dashboard-card[data-widget="${key}"]`).boundingBox() as Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  // Grid placements are the source of truth; bounding boxes are also compared
  // loosely (async widget content changes heights at runtime).
  const placement = (key: string) =>
    page
      .locator(`.dashboard-card[data-widget="${key}"]`)
      .evaluate((node) => ({ left: node.style.left, top: node.style.top }));
  const round = (box: { x: number; y: number; width: number; height: number }) => ({
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  });
  const keys = ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"];
  const beforePlacement: Awaited<ReturnType<typeof placement>>[] = [];
  for (const key of keys) beforePlacement.push(await placement(key));
  const canvasBefore = await page.locator(".dashboard-canvas").boundingBox();
  const tasksBoxBefore = round(await cardBox("tasks:today"));

  await page.getByRole("button", { name: /edit layout/i }).click();
  // Drag the tasks card's handle down-left into empty space (2 units left,
  // 25 units down): well clear of the second row and of the right edge, so
  // the drop lands on the exact snapped grid slot.
  const handle = page.locator('.dashboard-card[data-widget="tasks:today"] .drag-handle');
  const source = await handle.boundingBox();
  assert(source, "drag handle box resolved");
  const startX = source.x + source.width / 2;
  const startY = source.y + source.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 32, startY + 400, { steps: 20 });
  await page.mouse.up();

  // Only the dragged card moved, onto its snapped slot; the other cards keep
  // their placements and the old slot stays empty (no re-flow). The vertical
  // target is 25 units; dnd-kit's auto-scroll may add a unit of page scroll
  // to the drop delta, so accept the 25-27 unit band.
  const tasksPlacementAfter = await placement("tasks:today");
  assert.equal(tasksPlacementAfter.left, "640px", "tasks moved 2 grid units left");
  const topUnits = Number.parseInt(tasksPlacementAfter.top, 10) / 16;
  assert.ok(
    topUnits >= 25 && topUnits <= 27,
    `tasks moved ~25 grid units down (got ${tasksPlacementAfter.top})`,
  );
  for (const [index, key] of keys.entries()) {
    if (key === "tasks:today") continue;
    expect(await placement(key)).toEqual(beforePlacement[index]);
  }
  const tasksBoxAfter = round(await cardBox("tasks:today"));
  assert.ok(tasksBoxAfter.y > tasksBoxBefore.y + 350, "tasks card visually moved far down");

  // The canvas grew downward to make room for the lower card.
  const canvasAfter = await page.locator(".dashboard-canvas").boundingBox();
  assert.ok(canvasAfter && canvasBefore, "canvas boxes resolved");
  assert.ok(canvasAfter.height > canvasBefore.height, "canvas grew after the drop");

  await page.getByRole("button", { name: "Done", exact: true }).click();
  // Done persists asynchronously; wait until the shell returns to normal mode
  // so the reload cannot cancel the PUT mid-flight.
  await expect(page.getByRole("button", { name: /edit layout/i })).toBeVisible();
  await page.reload();
  await expect(page.locator(".dashboard-card [data-widget-key]")).toHaveCount(4);
  expect(await placement("tasks:today")).toEqual(tasksPlacementAfter);
  for (const [index, key] of keys.entries()) {
    if (key === "tasks:today") continue;
    expect(await placement(key)).toEqual(beforePlacement[index]);
  }

  // Reset the persisted layout for the following tests.
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"] },
  });
});

test("dashboard: narrow viewport keeps widgets in flow without overflow", async ({ page }) => {
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"] },
  });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await expect(page.locator(".dashboard-card [data-widget-key]")).toHaveCount(4);

  // Narrow mode must not use the desktop absolute layout: cards are in the
  // normal flow (no inline grid offsets, no absolute positioning).
  await expect(page.locator(".dashboard-canvas[data-desktop='true']")).toHaveCount(0);
  const cardStyles = await page.locator(".dashboard-card").first().evaluate((node) => ({
    position: getComputedStyle(node).position,
    left: node.style.left,
    top: node.style.top,
  }));
  expect(cardStyles.position).not.toBe("absolute");
  expect(cardStyles.left).toBe("");
  expect(cardStyles.top).toBe("");

  // No horizontal overflow from desktop placements.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("dashboard: hide and show widgets persist after reload", async ({ page }) => {
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"] },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /edit layout/i }).click();
  await page.getByRole("button", { name: /hide asset summary/i }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: /edit layout/i })).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-widget-key="assets:summary"]')).toHaveCount(0);
  // Count-agnostic: apps outside the persisted 4-key layout also count as
  // hidden, so the number grows with the shipped app set.
  await expect(page.getByText(/\d+ widget\(s\) hidden/)).toBeVisible();

  // Show it again through edit mode.
  await page.getByRole("button", { name: /edit layout/i }).click();
  await page.getByRole("button", { name: /asset summary/i }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: /edit layout/i })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-widget-key="assets:summary"]')).toHaveCount(1);
});

// ---------- Dashboard free resize (Phase 10) ----------

/** Deterministic six-widget V2 layout: clock (0,0) has room to grow right/down. */
const RESIZE_LAYOUT = {
  version: 2,
  items: {
    "clock:clock": { x: 0, y: 0, w: 20, h: 16 },
    "tasks:today": { x: 0, y: 26, w: 20, h: 16 },
    "assets:summary": { x: 42, y: 0, w: 20, h: 16 },
    "mini_game:highscore": { x: 42, y: 26, w: 20, h: 16 },
    "focus:timer": { x: 0, y: 48, w: 20, h: 16 },
    "notes:quick_note": { x: 42, y: 48, w: 20, h: 16 },
  },
  hidden: [],
};

const CANONICAL_LAYOUT = ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"];

async function putResizeLayout(page: Page) {
  // clock/notes are default-enabled; make it explicit for determinism.
  await setAppEnabled("clock", true);
  await setAppEnabled("notes", true);
  const response = await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: RESIZE_LAYOUT },
  });
  expect(response.status(), "PUT resize layout").toBe(200);
}

/** Inline style geometry of a dashboard card (the placement source of truth). */
async function cardGeometry(page: Page, key: string) {
  return page.locator(`.dashboard-card[data-widget="${key}"]`).evaluate((node) => ({
    left: node.style.left,
    top: node.style.top,
    width: node.style.width,
    height: node.style.height,
    density: node.getAttribute("data-density"),
  }));
}

test("dashboard: resize persists after reload and switches density by threshold", async ({ page }) => {
  await putResizeLayout(page);
  await page.goto("/");
  await expect(page.locator(".dashboard-canvas[data-desktop='true']")).toBeVisible();
  await expect(page.locator('[data-widget-key="clock:clock"]')).toBeVisible();

  const keys = Object.keys(RESIZE_LAYOUT.items);
  const before: Record<string, unknown>[] = [];
  for (const key of keys) before.push(await cardGeometry(page, key));
  // 20x16 satisfies the clock's normal threshold, not expanded.
  expect(before[0]).toMatchObject({ width: "320px", height: "256px", density: "normal" });

  await page.getByRole("button", { name: /edit layout/i }).click();
  // Bottom-right grip: drag +6 units right (+96px) and +4 down (+64px).
  const handle = page.locator('.dashboard-card[data-widget="clock:clock"] .resize-handle');
  const box = await handle.boundingBox();
  assert(box, "resize handle box resolved");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2 + 64, { steps: 10 });
  await page.mouse.up();

  // Only the resized card changed: w/h grew, x/y anchored, others untouched.
  const clockAfter = await cardGeometry(page, "clock:clock");
  assert.equal(clockAfter.left, "0px", "clock x anchored");
  assert.equal(clockAfter.top, "0px", "clock y anchored");
  assert.equal(clockAfter.width, "416px", "clock grew to 26 units");
  assert.equal(clockAfter.height, "320px", "clock grew to 20 units");
  // 26x20 crosses the clock's expanded threshold: attribute + content switch.
  expect(clockAfter.density).toBe("expanded");
  await expect(page.locator('[data-widget-key="clock:clock"]')).toContainText("MORE TASKS TODAY");
  for (const [index, key] of keys.entries()) {
    if (key === "clock:clock") continue;
    expect(await cardGeometry(page, key)).toEqual(before[index]);
  }

  // Done persists; a reload restores the exact size and density.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: /edit layout/i })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-widget-key="clock:clock"]')).toBeVisible();
  expect(await cardGeometry(page, "clock:clock")).toMatchObject({
    left: "0px",
    top: "0px",
    width: "416px",
    height: "320px",
    density: "expanded",
  });
  await expect(page.locator('[data-widget-key="clock:clock"]')).toContainText("MORE TASKS TODAY");

  // Reset for the following tests (canonical legacy array: clock/notes hidden).
  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: CANONICAL_LAYOUT },
  });
});

test("dashboard: resize toward an occupied widget is rejected and retains the size", async ({ page }) => {
  await putResizeLayout(page);
  await page.goto("/");
  await expect(page.locator('[data-widget-key="clock:clock"]')).toBeVisible();
  await page.getByRole("button", { name: /edit layout/i }).click();

  const handle = page.locator('.dashboard-card[data-widget="clock:clock"] .resize-handle');
  const box = await handle.boundingBox();
  assert(box, "resize handle box resolved");
  // Drag far downwards: the candidate collides with tasks:today (y=26).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 500, { steps: 10 });
  await expect(page.locator('.dashboard-card[data-widget="clock:clock"]')).toHaveClass(
    /dashboard-card--resize-invalid/,
  );
  await page.mouse.up();

  // Released invalid: original size retained, tasks untouched.
  expect(await cardGeometry(page, "clock:clock")).toMatchObject({
    width: "320px",
    height: "256px",
    density: "normal",
  });
  expect(await cardGeometry(page, "tasks:today")).toMatchObject({ top: "416px", height: "256px" });

  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: CANONICAL_LAYOUT },
  });
});

test("dashboard: narrow viewport ignores saved desktop sizes without overflow", async ({ page }) => {
  await putResizeLayout(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await expect(page.locator(".dashboard-card [data-widget-key]").first()).toBeVisible();

  // Narrow mode must not apply desktop geometry: flow layout, no inline size.
  await expect(page.locator(".dashboard-canvas[data-desktop='true']")).toHaveCount(0);
  const cardStyles = await page.locator(".dashboard-card").first().evaluate((node) => ({
    position: getComputedStyle(node).position,
    left: node.style.left,
    top: node.style.top,
    width: node.style.width,
    height: node.style.height,
    density: node.getAttribute("data-density"),
  }));
  expect(cardStyles.position).not.toBe("absolute");
  expect(cardStyles.left).toBe("");
  expect(cardStyles.top).toBe("");
  expect(cardStyles.width).toBe("");
  expect(cardStyles.height).toBe("");
  // Density falls back to normal even for the saved 26x20 clock.
  expect(cardStyles.density).toBe("normal");

  // No horizontal overflow from desktop placements.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: CANONICAL_LAYOUT },
  });
});

test("app center: nickname and accent persist and reach the dock", async ({ page }) => {
  // Clean slate for the presentation setting.
  await page.request.put(`${CORE}/api/core/settings/apps.presentation`, { data: { value: {} } });

  await page.goto("/apps");
  const card = page.locator('.app-card[data-app="assets"]');
  await card.getByRole("button", { name: /customize assets/i }).click();

  const editor = page.getByTestId("presentation-editor");
  await expect(editor).toBeVisible();
  await editor.getByLabel("App nickname").fill("My Inventory");
  await editor.getByLabel("Accent color").selectOption("mint");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  // Card reflects the nickname; the dock label follows the same override.
  await expect(card.getByText("My Inventory")).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("link", { name: "My Inventory", exact: true })).toBeVisible();

  // Survives a reload.
  await page.reload();
  await expect(page.getByRole("link", { name: "My Inventory", exact: true })).toBeVisible();

  // Reset to default restores the manifest name everywhere.
  await page.goto("/apps");
  await page.locator('.app-card[data-app="assets"]').getByRole("button", { name: /customize my inventory/i }).click();
  const resetEditor = page.getByTestId("presentation-editor");
  await resetEditor.getByRole("button", { name: /reset to default/i }).click();
  await expect(resetEditor).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Assets", exact: true })).toBeVisible();
});
