import { expect, test, type Page } from "@playwright/test";

/**
 * Pixel shell responsive/visual smoke tests (guide §53):
 * mobile bottom navigation, tablet icon dock, and no global horizontal
 * overflow down to 320px.
 */

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("pixel shell — mobile", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
  });

  test("uses bottom navigation instead of the side dock", async ({ page }) => {
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.locator(".dock")).toBeHidden();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("more launcher lists enabled apps and navigates", async ({ page }) => {
    await page.getByRole("button", { name: "More" }).click();
    const menu = page.getByRole("dialog", { name: "More apps" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: "Tasks" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Settings" })).toBeVisible();

    await menu.getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    // The launcher closes after navigation.
    await expect(page.getByRole("dialog", { name: "More apps" })).toHaveCount(0);
    // Header button: the empty-task list renders a second "New Task" CTA.
    await expect(
      page.locator(".page-header__actions").getByRole("button", { name: /new task/i }),
    ).toBeVisible();
  });

  test("app center stays usable and overflow-free on mobile", async ({ page }) => {
    await page.goto("/apps");
    await expect(page.locator(".app-card").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("pixel shell — breakpoints", () => {
  test("320px viewport has no global horizontal overflow on key pages", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of ["/", "/apps", "/tasks", "/assets", "/settings", "/mini_game"]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test("tablet collapses the dock to icon mode while keeping link names", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto("/");
    const dock = page.locator(".dock");
    await expect(dock).toBeVisible();
    const width = await dock.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(72);
    // aria-label keeps the accessible name in icon-only mode.
    await expect(page.getByRole("link", { name: "App Center" })).toBeVisible();
    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(/\/tasks$/);
  });

  test("desktop keeps the expanded dock and widget windows", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.locator(".dock")).toBeVisible();
    await expect(page.locator(".px-window").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
