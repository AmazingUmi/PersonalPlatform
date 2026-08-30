import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Notes app e2e (Phase 7A-1 T11), worklist §4: the two mandated flows —
 * quick capture from the dashboard widget, and the full note lifecycle
 * (create with every field, filter by tag, search, edit, delete via the
 * confirm dialog). Driven through the real shell; the stack is managed by
 * the playwright webServer config against the E2E database, which persists
 * across runs — every user-visible string is timestamp-unique so residual
 * data from earlier runs can never satisfy an assertion.
 */

const CORE = "http://127.0.0.1:8902";
/**
 * Canonical widget layout (the same four keys platform.spec/focus.spec
 * persist) with the notes card appended. Appending — not replacing — keeps
 * the layout-agnostic assertions of the other specs green, while the explicit
 * PUT guarantees the quick_note card is visible regardless of what an earlier
 * run left persisted. No global widget-count assertions here (5th widget).
 */
const DASHBOARD_LAYOUT = [
  "assets:summary",
  "mini_game:highscore",
  "tasks:today",
  "focus:timer",
  "notes:quick_note",
];
/** The dashboard card's inner window element (Dashboard sets data-widget-key). */
const QUICK_NOTE_CARD = '[data-widget-key="notes:quick_note"]';
/** A timeline card link, identified by its unique title/content text. */
const noteCard = (page: Page, text: string) =>
  page.getByRole("link", { name: "Open note" }).filter({ hasText: text });

async function putCore(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${CORE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`PUT ${path} failed: HTTP ${response.status}`);
}

async function putDashboardLayout(request: APIRequestContext) {
  const response = await request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: DASHBOARD_LAYOUT },
  });
  expect(response.status(), "PUT dashboard.widgets").toBe(200);
}

test.beforeAll(async () => {
  // Deterministic start: a disabled notes app would lose its nav, page and
  // widget (idempotent when already enabled).
  await putCore("/api/core/apps/notes/enabled", { enabled: true });
});

test("notes: quick note from dashboard opens the deep-linked editor", async ({ page, request }) => {
  await putDashboardLayout(request);

  await page.goto("/");
  const card = page.locator(QUICK_NOTE_CARD);
  await expect(card).toBeVisible({ timeout: 10_000 });

  const content = `e2e quick note ${Date.now()}`;
  await card.getByLabel("Quick note content").fill(content);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });

  // Open deep-links into the editor at /notes/:id — a uuid, never /notes/new.
  await card.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(
    /\/notes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  await expect(page.getByLabel("Note content")).toHaveValue(content);
  await expect(page.getByLabel("Note title")).toHaveValue(""); // quick note has no title

  // Back to the timeline: the note sits in the Today group (server-computed
  // dayKey; the untitled card falls back to the content's first line).
  await page.locator(".page-header__actions").getByRole("link", { name: "Notes" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  const today = page.locator('section[aria-label="Today"]');
  await expect(today).toBeVisible({ timeout: 10_000 });
  await expect(today).toContainText(content);

  // Server persistence: a fresh load renders the same note.
  await page.reload();
  await expect(page.locator('section[aria-label="Today"]')).toContainText(content, {
    timeout: 10_000,
  });
});

test("notes: create, filter, search, edit and delete a note", async ({ page }) => {
  const run = Date.now();
  const title = `e2e note ${run}`;
  const content = `e2e note content ${run}`;
  const tagName = `e2e-tag-${run}`;
  const titleEdited = `e2e note edited ${run}`;
  const contentEdited = `e2e note content edited ${run}`;

  await page.goto("/notes");
  // Header link, not the empty-state CTA with the same name (fresh DB).
  await page.locator(".page-header__actions").getByRole("link", { name: /new note/i }).click();
  await expect(page).toHaveURL(/\/notes\/new$/);

  await page.getByLabel("Note title").fill(title);
  await page.getByLabel("Note content").fill(content);
  await page.getByLabel("Mood").selectOption("good");
  // A brand-new tag name + Enter fires the get-or-create upsert and renders
  // the chip selected, without submitting the note form.
  const newTagInput = page.getByLabel("New tag name");
  await newTagInput.fill(tagName);
  await newTagInput.press("Enter");
  const tagChip = page.locator(".notes-editor__tags").getByRole("button", { name: tagName });
  await expect(tagChip).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
  await page.getByLabel("Pinned", { exact: true }).check();

  await page.getByRole("button", { name: /create note/i }).click();
  await expect(page).toHaveURL(/\/notes$/);

  // The timeline card carries every field just set.
  const card = noteCard(page, title);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("Good", { exact: true })).toBeVisible();
  await expect(card.getByText(tagName, { exact: true })).toBeVisible();
  await expect(card.getByText("Pinned", { exact: true })).toBeVisible();

  // Tag filter: the unique tag isolates this note from everything else the
  // persistent E2E database holds.
  await page.locator(".page-header__actions").getByRole("button", { name: /filters/i }).click();
  await page
    .getByRole("button", { name: new RegExp(`filter by tag ${tagName}`, "i") })
    .click();
  await expect(page).toHaveURL(/tags=/);
  await expect(page.getByRole("link", { name: "Open note" })).toHaveCount(1);

  // Reset restores the unfiltered timeline, then a title-fragment search hits
  // the note (and only it — the fragment carries this run's timestamp).
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\??$/);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Search notes").fill(`note ${run}`);
  // The debounced (250ms) search writes q= back to the URL once applied.
  await expect(page).toHaveURL(/[?&]q=(note\+|note%20)\d+/);
  await expect(page.getByRole("link", { name: "Open note" })).toHaveCount(1);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\??$/);
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Edit: open the editor, change title and content, save back to the
  // timeline.
  await card.click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f]{8}-/);
  await page.getByLabel("Note title").fill(titleEdited);
  await page.getByLabel("Note content").fill(contentEdited);
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page).toHaveURL(/\/notes$/);
  const editedCard = noteCard(page, titleEdited);
  await expect(editedCard).toBeVisible({ timeout: 10_000 });
  await expect(editedCard).toContainText(contentEdited);
  await expect(noteCard(page, title)).toHaveCount(0);

  // Delete asks for confirmation first (the dialog's confirm button shares
  // the editor button's "Delete" name — scope to the dialog).
  await editedCard.click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f]{8}-/);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(noteCard(page, titleEdited)).toHaveCount(0);
});
