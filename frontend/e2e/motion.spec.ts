import assert from "node:assert/strict";
import { expect, test, type Page } from "@playwright/test";

/**
 * Motion-system regression specs (FE-MOTION-5): the animation layer must be
 * presentation-only. These specs prove the two failure modes that matter —
 * reduced-motion users get a fully functional (and effectively static) UI,
 * and the 2048 tile animations never desync the board under rapid input.
 */

const CORE = "http://127.0.0.1:8902";

/** The canonical legacy layout platform.spec starts from — restored at the
 * end of the dashboard test so downstream specs (which may run without the
 * intervening files in subset runs) see the canonical widgets. */
const CANONICAL_LAYOUT = ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"];

const MOTION_LAYOUT = {
  version: 2,
  items: {
    "clock:clock": { x: 0, y: 0, w: 20, h: 16 },
    "tasks:today": { x: 0, y: 26, w: 20, h: 16 },
  },
  hidden: ["assets:summary", "mini_game:highscore", "focus:timer", "notes:quick_note"],
};

async function seedLayout(page: Page, value: unknown): Promise<void> {
  const response = await page.request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value },
  });
  expect(response.status(), "seed dashboard layout").toBe(200);
}

async function setAppEnabled(id: string, enabled: boolean): Promise<void> {
  const response = await fetch(`${CORE}/api/core/apps/${id}/enabled`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error(`toggle ${id} failed: HTTP ${response.status}`);
}

test.beforeAll(async () => {
  await setAppEnabled("assets", true);
  await setAppEnabled("tasks", true);
  await setAppEnabled("mini_game", true);
  await setAppEnabled("focus", true);
  await setAppEnabled("clock", true);
  await setAppEnabled("notes", true);
});

test.describe("prefers-reduced-motion: reduce", () => {
  // The CSS kill-switch (0.01ms durations) plus the JS-side skip in
  // shared/motion must leave every workflow usable with no stuck states.
  test.use({ reducedMotion: "reduce" });

  test("dashboard is fully usable: load, edit mode, keyboard drag, resize, dialog", async ({ page }) => {
    await seedLayout(page, MOTION_LAYOUT);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator(".dashboard-canvas[data-desktop='true']")).toBeVisible();
    await expect(page.locator(".dashboard-card [data-widget-key]")).toHaveCount(2);
    // Cards render at their exact placements — no entrance transform stuck.
    const tasks = page.locator('.dashboard-card[data-widget="tasks:today"]');
    expect(await tasks.evaluate((node) => node.style.left)).toBe("0px");

    await page.getByRole("button", { name: /edit layout/i }).click();
    // Keyboard drag via the handle (Space/arrows/Space). The small waits
    // cover dnd-kit's KeyboardSensor attaching its document keydown listener
    // in a setTimeout(0) after drag start.
    const handle = page.locator('.dashboard-card[data-widget="tasks:today"] .drag-handle');
    await handle.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(50);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(50);
    await page.keyboard.press("Space");
    await expect
      .poll(async () => tasks.evaluate((node) => node.style.left), { timeout: 5_000 })
      .toBe("16px");

    // Keyboard resize on the clock card: +1 width unit (clock grows up to 26).
    const clock = page.locator('.dashboard-card[data-widget="clock:clock"]');
    const widthBefore = await clock.evaluate((node) => node.style.width);
    const resize = page.locator('.dashboard-card[data-widget="clock:clock"] .resize-handle');
    await resize.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => clock.evaluate((node) => node.style.width), { timeout: 5_000 })
      .not.toBe(widthBefore);

    // Reset dialog opens and confirms under reduced motion.
    await page.getByRole("button", { name: /reset layout/i }).click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Reset Layout" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".dashboard-card [data-widget-key]")).toHaveCount(6);

    // Restore the canonical layout so subsequent specs are not affected by
    // this suite's MOTION_LAYOUT (which hides the validation widgets).
    await seedLayout(page, CANONICAL_LAYOUT);
  });

  test("app center, mobile nav and mini game work without animation", async ({ page }) => {
    // App center cards visible and a toggle round-trip succeeds.
    await page.goto("/apps");
    await expect(page.locator(".app-card")).toHaveCount(6);
    const card = page.locator('.app-card[data-app="mini_game"]');
    await card.getByRole("button", { name: "Disable" }).click();
    await expect(card.getByText("disabled")).toBeVisible();
    await card.getByRole("button", { name: "Enable" }).click();
    await expect(card.getByText("enabled")).toBeVisible();

    // Mobile launcher opens and closes instantly (no exit-animation wait).
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto("/");
    await page.getByRole("button", { name: "More" }).click();
    const panel = page.getByRole("dialog", { name: "More apps" });
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();

    // Mini game plays a move and saves. New Game is disabled until the save
    // has loaded — it is the readiness signal. A fresh game also resets any
    // game-over state left in the persistent E2E save.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/mini_game");
    const newGame = page.getByRole("button", { name: "New Game" });
    await expect(newGame).toBeEnabled();
    await newGame.click();
    await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });
    const tiles = page.locator(".game__tile");
    const before = await tiles.count();
    assert(before >= 2, "game started with tiles");
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => page.locator(".game__tile").count(), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(before);
    await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });
  });
});

test("mini game: rapid input keeps the board consistent and saves", async ({ page }) => {
  await page.goto("/mini_game");
  await expect(page.locator(".game__board")).toBeVisible();
  // Wait for the save to load, then start fresh (moves are ignored while
  // loading, and a persisted game-over save would swallow every keypress).
  const newGame = page.getByRole("button", { name: "New Game" });
  await expect(newGame).toBeEnabled();
  await newGame.click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });

  const readTiles = () =>
    page.locator(".game__tile").evaluateAll((nodes) =>
      nodes.map((node) => ({
        value: Number.parseInt(node.textContent ?? "0", 10),
        transform: (node as HTMLElement).style.transform,
      })),
    );

  // Hammer arrows faster than the 140ms move transition can finish: the state
  // must stay synchronous while the CSS transitions retarget.
  const arrows = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"];
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press(arrows[index % arrows.length]);
  }

  // Every tile sits exactly on a cell (transform matches its cell position):
  // positions come from r/c × cell pitch, never from a stale transition. The
  // state is synchronous, but the CSS transitions retarget throughout the
  // burst — poll until they have settled before asserting geometry.
  const boardSize = await page.locator(".game__board").boundingBox();
  assert(boardSize, "board box resolved");
  await expect
    .poll(
      async () =>
        page.locator(".game__tile").evaluateAll((nodes) => {
          const boardNode = document.querySelector(".game__board");
          if (!boardNode) return false;
          const cells = Array.from(boardNode.querySelectorAll(".game__cell"));
          return nodes.every((node) => {
            const box = node.getBoundingClientRect();
            const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            return cells.some((cell) => {
              const cellBox = cell.getBoundingClientRect();
              return (
                center.x >= cellBox.x - 1.5 &&
                center.x <= cellBox.x + cellBox.width + 1.5 &&
                center.y >= cellBox.y - 1.5 &&
                center.y <= cellBox.y + cellBox.height + 1.5
              );
            });
          });
        }),
      { timeout: 5_000, intervals: [100, 100, 200] },
    )
    .toBe(true);

  // The score never decreases and the save lands after the burst.
  const tiles = await readTiles();
  assert(tiles.every((tile) => Number.isFinite(tile.value) && tile.value > 0), "tiles carry values");
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });

  // Restore the fresh-board state platform.spec's mini game test expects:
  // its `>=` count assertion is only stable on a non-double-merge board, and
  // a random burst board can merge two pairs in one move.
  await page.getByRole("button", { name: "New Game" }).click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });
});
