import { expect, test, type Page } from "@playwright/test";

/**
 * Assets Category V2 e2e (Phase 7A-2 T08, worklist §6.4): the three mandated
 * flows — ① create a three-category item and see the colored badges plus the
 * segmented stripe, ② chip filters that AND together and persist in the URL,
 * ③ edit a category color through Manage → Rename and see it reach the card.
 * Driven through the real shell; the stack is managed by the playwright
 * webServer config against the E2E database, which persists across runs —
 * every user-visible string is timestamp-unique so residual data from earlier
 * runs can never satisfy an assertion (notes.spec discipline). Test-created
 * categories use English + timestamp names: the seed migration already owns
 * six Chinese names and categories.name is UNIQUE.
 *
 * API assists (CORE fetch, notes.spec/platform.spec precedent): categories and
 * flow-② setup items are created through the API for stable ids and colors —
 * the flows under test keep their UI reality where it matters (item creation
 * and the category multi-select in ①, Manage/Rename/color edit in ③).
 *
 * Category cleanup is deliberate (the one departure from the usual
 * "residual data is inert" discipline): the New Item dialog renders one chip
 * per category and the dialog is a fixed centered overlay without its own
 * scroll — once ~20 categories accumulate, the Create button falls outside
 * the viewport and becomes unclickable. That residue is shared geometry, not
 * private data: it broke platform.spec's asset flows too. So this spec purges
 * stale `e2e-cat-` categories from earlier runs in beforeAll and its own in
 * afterAll (deleting a category only unlinks items — they survive as
 * timestamp-unique residue like every other run's items).
 */

const CORE = "http://127.0.0.1:8902";

interface CategoryInfo {
  id: string;
  name: string;
  color: string | null;
}

async function putCore(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${CORE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`PUT ${path} failed: HTTP ${response.status}`);
}

/** Every category this spec names starts with this prefix (purge key). */
const CATEGORY_PREFIX = "e2e-cat-";

/** Delete all categories this spec ever created (idempotent, 404 tolerated). */
async function purgeE2eCategories(): Promise<void> {
  const response = await fetch(`${CORE}/api/apps/assets/categories`);
  if (!response.ok) throw new Error(`list categories failed: HTTP ${response.status}`);
  const { items } = (await response.json()) as { items: CategoryInfo[] };
  for (const category of items) {
    if (!category.name.startsWith(CATEGORY_PREFIX)) continue;
    const deleted = await fetch(`${CORE}/api/apps/assets/categories/${category.id}`, { method: "DELETE" });
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`delete category "${category.name}" failed: HTTP ${deleted.status}`);
    }
  }
}

/** Create a category through the API (stable id, optional color). */
async function apiCreateCategory(name: string, color?: string): Promise<CategoryInfo> {
  const response = await fetch(`${CORE}/api/apps/assets/categories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(color ? { name, color } : { name }),
  });
  if (response.status !== 201) {
    throw new Error(`create category "${name}" failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as CategoryInfo;
}

/** Create an item through the API (flow-② setup for deterministic AND sets). */
async function apiCreateItem(name: string, categoryIds: string[]): Promise<void> {
  const response = await fetch(`${CORE}/api/apps/assets/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, categoryIds }),
  });
  if (response.status !== 201) {
    throw new Error(`create item "${name}" failed: HTTP ${response.status} ${await response.text()}`);
  }
}

/** An inventory card, identified by its unique item name. */
const invCard = (page: Page, name: string) => page.locator(".inv-card").filter({ hasText: name });

/** A category filter chip (worklist §4.1: the chip itself toggles the filter). */
const filterChip = (page: Page, name: string) =>
  page.getByRole("button", { name: `Filter by category ${name}`, exact: true });

test.beforeAll(async () => {
  // Deterministic start: a disabled assets app would lose its nav and page
  // (idempotent when already enabled), and leftover categories from an
  // interrupted run are gone before the first dialog opens (see header).
  await putCore("/api/core/apps/assets/enabled", { enabled: true });
  await purgeE2eCategories();
});

test.afterAll(async () => {
  // Keep the persistent DB at its seeded category count so the dialog
  // geometry stays stable for every later spec (and later runs).
  await purgeE2eCategories();
});

test("assets categories: create a three-category item and see badges and stripe", async ({ page }) => {
  const run = Date.now();
  // Two categories arrive via the API with colors (colored badges); the third
  // exercises the UI creation entry — the inline "New category" form — and
  // stays colorless (the documented neutral fallback).
  const bravo = await apiCreateCategory(`e2e-cat-bravo-${run}`, "coral");
  const charlie = await apiCreateCategory(`e2e-cat-charlie-${run}`, "violet");
  const alphaName = `e2e-cat-alpha-${run}`;
  const itemName = `e2e-item-tri-${run}`;

  await page.goto("/assets");
  await page.getByLabel("New category name", { exact: true }).fill(alphaName);
  await page.getByRole("button", { name: "Add category", exact: true }).click();
  const alphaChip = filterChip(page, alphaName);
  await expect(alphaChip).toBeVisible({ timeout: 10_000 });
  // The add form only takes a name: no color picked, so no color dot renders.
  await expect(alphaChip.locator(".px-cat-dot")).toHaveCount(0);

  // New Item through the header button (scoped: the empty-inventory state
  // renders a second CTA with the same name), then select all three categories.
  await page.locator(".page-header__actions").getByRole("button", { name: /new item/i }).click();
  const editor = page.getByTestId("item-editor");
  await expect(editor).toBeVisible();
  await editor.getByLabel("Item name").fill(itemName);
  for (const name of [alphaName, bravo.name, charlie.name]) {
    const chip = editor.getByRole("button", { name: `Toggle category ${name}`, exact: true });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: /create item/i }).click();
  await expect(page.getByTestId("item-editor")).toHaveCount(0);

  // The card carries one badge per category (3 = the badge limit, no +N) …
  const card = invCard(page, itemName);
  await expect(card).toBeVisible({ timeout: 10_000 });
  const badges = card.locator(".px-badge");
  await expect(badges).toHaveCount(3);
  for (const name of [alphaName, bravo.name, charlie.name]) {
    await expect(card.getByText(name, { exact: true })).toBeVisible();
  }
  // … the colored ones painted with their accent, the UI-created one neutral.
  await expect(badges.filter({ hasText: bravo.name })).toHaveAttribute("data-accent", "coral");
  await expect(badges.filter({ hasText: charlie.name })).toHaveAttribute("data-accent", "violet");
  await expect(badges.filter({ hasText: alphaName })).not.toHaveAttribute("data-accent");

  // The stripe splits into one segment per category, in name order (server
  // sorts categories by name: alpha < bravo < charlie with this run's suffix).
  const segments = card.locator(".inv-card__stripe-seg");
  await expect(segments).toHaveCount(3);
  const accents = await segments.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-accent")));
  expect(accents).toEqual([null, "coral", "violet"]);
});

test("assets categories: chips filter, AND together and persist across reload", async ({ page }) => {
  const run = Date.now();
  // X belongs to A and B; Y only to A; Z only to C (the faceted-count witness:
  // with A selected, C's chip count must stay at its true value).
  const catA = await apiCreateCategory(`e2e-cat-and-a-${run}`, "mint");
  const catB = await apiCreateCategory(`e2e-cat-and-b-${run}`, "yellow");
  const catC = await apiCreateCategory(`e2e-cat-and-c-${run}`, "danger");
  const itemBoth = `e2e-item-and-both-${run}`;
  const itemOnlyA = `e2e-item-and-onlya-${run}`;
  await apiCreateItem(itemBoth, [catA.id, catB.id]);
  await apiCreateItem(itemOnlyA, [catA.id]);
  await apiCreateItem(`e2e-item-and-onlyc-${run}`, [catC.id]);

  await page.goto("/assets");
  const chipA = filterChip(page, catA.name);
  const chipB = filterChip(page, catB.name);
  const chipC = filterChip(page, catC.name);
  await expect(chipA).toBeVisible({ timeout: 10_000 });
  await expect(chipB).toBeVisible();
  await expect(chipC).toBeVisible();
  await expect(invCard(page, itemBoth)).toBeVisible();
  await expect(invCard(page, itemOnlyA)).toBeVisible();

  // One chip click filters immediately and writes the deep link. Category A
  // is fresh to this run, so exactly its two items remain.
  await chipA.click();
  await expect(chipA).toHaveAttribute("aria-pressed", "true");
  await expect(chipB).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(new RegExp(`[?&]categories=${catA.id}`));
  await expect(page.locator(".inv-card__main")).toHaveCount(2);
  // Faceted counts (worklist §2.4): C holds no item of the visible A-filtered
  // result set, yet its chip count stays 1 — counts derived from the result
  // set would collapse it to 0.
  await expect(chipC.locator(".px-chip__count")).toHaveText("1");

  // The second chip ANDs: only the item in both A and B survives.
  await chipB.click();
  await expect(chipB).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".inv-card__main")).toHaveCount(1);
  await expect(invCard(page, itemBoth)).toBeVisible();
  await expect(invCard(page, itemOnlyA)).toHaveCount(0);
  const active = new URLSearchParams(new URL(page.url()).search).get("categories")?.split(",") ?? [];
  expect(active).toEqual(expect.arrayContaining([catA.id, catB.id]));

  // Reload: the URL deep link restores the filter and the pressed chips.
  await page.reload();
  await expect(chipA).toHaveAttribute("aria-pressed", "true");
  await expect(chipB).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".inv-card__main")).toHaveCount(1);
  await expect(invCard(page, itemBoth)).toBeVisible();

  // Second click cancels: unpressing B widens back to A's two items …
  await chipB.click();
  await expect(chipB).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".inv-card__main")).toHaveCount(2);
  // … and unpressing A deletes the param entirely — full list, All pressed.
  await chipA.click();
  await expect(chipA).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/\/assets$/);
  await expect(page.getByRole("button", { name: "All categories", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(invCard(page, itemBoth)).toBeVisible();
  await expect(invCard(page, itemOnlyA)).toBeVisible();
});

test("assets categories: editing a category color reaches the card stripe and badge", async ({ page }) => {
  const run = Date.now();
  const cat = await apiCreateCategory(`e2e-cat-recolor-${run}`, "mint");
  const itemName = `e2e-item-recolor-${run}`;
  await apiCreateItem(itemName, [cat.id]);

  await page.goto("/assets");
  const card = invCard(page, itemName);
  await expect(card).toBeVisible({ timeout: 10_000 });
  const badge = card.locator(".px-badge").filter({ hasText: cat.name });
  await expect(card.locator(".inv-card__stripe-seg")).toHaveAttribute("data-accent", "mint");
  await expect(badge).toHaveAttribute("data-accent", "mint");

  // Manage reveals the inline tools; the pencil ("Rename") opens the editor
  // dialog with the name and color fields.
  const manage = page.getByRole("button", { name: `Manage category ${cat.name}`, exact: true });
  await expect(manage).toHaveAttribute("aria-expanded", "false");
  await manage.click();
  await expect(manage).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: `Rename category ${cat.name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit Category" })).toBeVisible();
  await expect(page.getByLabel("Category name", { exact: true })).toHaveValue(cat.name);

  await page.getByLabel("Category color", { exact: true }).selectOption("coral");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit Category" })).toHaveCount(0);

  // The refreshed card, badge and chip dot all wear the new accent.
  await expect(card.locator(".inv-card__stripe-seg")).toHaveAttribute("data-accent", "coral");
  await expect(badge).toHaveAttribute("data-accent", "coral");
  await expect(filterChip(page, cat.name).locator(".px-cat-dot")).toHaveAttribute("data-accent", "coral");
});
