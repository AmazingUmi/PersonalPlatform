import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Focus app e2e (APP-1 F09): dashboard quick controls, dashboard/page (and
 * cross-tab) synchronization, cancelled history accounting, settings applied
 * to the next session, reload persistence and the single-active-session
 * invariant. Driven through the real shell; the stack is managed by the
 * playwright webServer config against the E2E database.
 *
 * The server owns all timing, so assertions read server truth (GET /state)
 * wherever possible; the only deliberate wait is the 2s spread between two
 * countdown reads. Every test starts from idle (stop tolerates the 409 the
 * backend answers when no session is active).
 */

const CORE = "http://127.0.0.1:8902";
/** Canonical full-widget layout (same list platform.spec persists). */
const ALL_WIDGETS = ["assets:summary", "mini_game:highscore", "tasks:today", "focus:timer"];
/** The dashboard card's inner window element (Dashboard sets data-widget-key). */
const FOCUS_CARD = '[data-widget-key="focus:timer"]';

const BREAK_DEFAULTS = {
  shortBreakDurationSeconds: 300,
  longBreakDurationSeconds: 900,
  longBreakInterval: 4,
};

interface FocusStateBody {
  active: { id: string; kind: string; status: string; revision: number } | null;
  today: { focusedSeconds: number; completedRounds: number; sessionsEnded: number };
  nextKind: "focus" | "short_break" | "long_break";
}

async function getFocusState(request: APIRequestContext): Promise<FocusStateBody> {
  const response = await request.get(`${CORE}/api/apps/focus/state`);
  expect(response.status(), "GET /api/apps/focus/state").toBe(200);
  return (await response.json()) as FocusStateBody;
}

async function putFocusSettings(request: APIRequestContext, focusDurationSeconds: number) {
  const response = await request.put(`${CORE}/api/apps/focus/settings`, {
    data: { focusDurationSeconds, ...BREAK_DEFAULTS },
  });
  expect(response.status(), "PUT focus settings").toBe(200);
}

/**
 * The idle `nextKind` comes from the pomodoro cycle position (completed focus
 * sessions since the last COMPLETED long break). The E2E database persists
 * across runs, so earlier runs leave the cycle mid-stream and a dashboard
 * START would begin a break instead of a focus round. Completing a minimal
 * 1s long break (via plannedDurationSeconds override) resets the anchor, so
 * the next idle session is deterministically `focus`.
 */
async function ensureNextKindIsFocus(request: APIRequestContext) {
  if ((await getFocusState(request)).nextKind === "focus") return;
  const started = await request.post(`${CORE}/api/apps/focus/start`, {
    data: { kind: "long_break", plannedDurationSeconds: 1 },
  });
  expect(started.status(), "start 1s long break").toBe(201);
  await expect
    .poll(async () => (await getFocusState(request)).active, { timeout: 10_000 })
    .toBe(null);
  expect((await getFocusState(request)).nextKind).toBe("focus");
}

async function ensureDashboardWidget(request: APIRequestContext) {
  const response = await request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
    data: { value: ALL_WIDGETS },
  });
  expect(response.status(), "PUT dashboard.widgets").toBe(200);
}

const widgetState = (page: Page): Locator => page.locator(`${FOCUS_CARD} .focus-widget__state`);
const widgetTime = (page: Page): Locator => page.locator(`${FOCUS_CARD} .focus-widget__time`);

/** Today's completed-round count as rendered by the widget rounds label. */
async function widgetRounds(page: Page): Promise<number> {
  const text = await page.locator(`${FOCUS_CARD} .focus-widget__rounds-label`).innerText();
  const match = /(\d+)\s+ROUNDS/.exec(text);
  expect(match, `widget rounds label carries a count (got: ${text})`).not.toBeNull();
  return Number(match![1]);
}

/** "04:59" -> 299 (only mm:ss is needed; sessions here stay under an hour). */
function parseClock(text: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(text.trim());
  expect(match, `clock renders mm:ss (got: ${text})`).not.toBeNull();
  return Number(match![1]) * 60 + Number(match![2]);
}

test.beforeEach(async ({ request }) => {
  // Deterministic idle start; 409 = no active session, which is fine here.
  const response = await request.post(`${CORE}/api/apps/focus/stop`);
  expect([200, 409]).toContain(response.status());
});

test("focus: dashboard quick controls run a short session end-to-end", async ({ page, request }) => {
  // The mounted widget reconciles at the deadline and shows a persistent
  // notice, without waiting for its 15-second safety-net poll.
  test.setTimeout(45_000);
  await putFocusSettings(request, 4);
  await ensureNextKindIsFocus(request);
  await ensureDashboardWidget(request);

  await page.goto("/");
  const card = page.locator(FOCUS_CARD);
  await expect(card).toBeVisible({ timeout: 10_000 });
  const roundsBefore = await widgetRounds(page);
  const urlBefore = page.url();

  await card.getByRole("button", { name: "start" }).click();
  await expect(widgetState(page)).toContainText("FOCUSING", { timeout: 10_000 });
  await expect(widgetTime(page)).toHaveText(/^\d{2}:\d{2}$/, { timeout: 10_000 });

  // A control press must never trigger the surrounding card's navigation.
  expect(page.url()).toBe(urlBefore);

  const completion = card.locator(".focus-completion");
  await expect(completion).toContainText("Focus complete", { timeout: 10_000 });
  await expect(widgetState(page)).toContainText("READY");
  expect(await widgetRounds(page)).toBe(roundsBefore + 1);
  await card.getByRole("button", { name: "Dismiss completion", exact: true }).click();
  await expect(completion).toHaveCount(0);
  expect(page.url()).toBe(urlBefore);
});

test("focus: foreground completion is visible without notification permission and stays dismissed", async ({ page, request }) => {
  // The reported defect: a foreground timer reached zero with no effective
  // notification. Deny the optional API to verify the visible fallback.
  await page.addInitScript(() => {
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class {
        static permission = "denied";
        static requestPermission() { throw new Error("must not request permission automatically"); }
        constructor() { throw new Error("must not notify without permission"); }
      },
    });
  });
  await putFocusSettings(request, 4);
  await ensureNextKindIsFocus(request);
  await page.goto("/focus");
  await page.getByRole("button", { name: "START", exact: true }).click();
  await expect(page.getByText("FOCUSING", { exact: true })).toBeVisible();
  const completion = page.locator(".focus-completion");
  await expect(completion).toHaveAttribute("role", "status", { timeout: 10_000 });
  await expect(completion).toContainText("Focus complete");
  await expect(page.getByText("READY", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(completion).toContainText("Focus complete");
  await page.getByRole("button", { name: "Dismiss completion", exact: true }).click();
  await expect(completion).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(completion).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("READY", { exact: true })).toBeVisible();
  await expect(completion).toHaveCount(0);
});

test("focus: default and minimum desktop widgets keep timer and completion controls inside the card", async ({ page, request }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const apps = await request.get(`${CORE}/api/core/apps`);
  expect(apps.status()).toBe(200);
  const { items } = await apps.json() as { items: Array<{ id: string; widgets: Array<{ id: string }> }> };
  const hidden = items.flatMap((app) => app.widgets.map((widget) => `${app.id}:${widget.id}`)).filter((key) => key !== "focus:timer");
  const card = page.locator(FOCUS_CARD);
  async function insideCard(locator: Locator) {
    const bounds = await card.boundingBox();
    const content = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    expect(content).not.toBeNull();
    expect(content!.y).toBeGreaterThanOrEqual(bounds!.y);
    expect(content!.y + content!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
    expect(content!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(content!.x + content!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
  }
  try {
    for (const [w, h] of [[26, 18], [16, 12]]) {
      await ensureNextKindIsFocus(request);
      await putFocusSettings(request, 3);
      const saved = await request.put(`${CORE}/api/core/settings/dashboard.widgets`, {
        data: { value: { version: 2, items: { "focus:timer": { x: 0, y: 0, w, h } }, hidden } },
      });
      expect(saved.status()).toBe(200);
      await page.goto("/");
      const start = card.getByRole("button", { name: "Start", exact: true });
      await expect(start).toBeVisible();
      // The initially empty live region must stay in the accessibility tree;
      // revealing a display:none region only at completion can miss its announcement.
      expect(await card.locator('.focus-alerts--compact [role="status"]').evaluate((element) => {
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden" || node.getAttribute("aria-hidden") === "true") return false;
        }
        return true;
      })).toBe(true);
      await insideCard(start);
      await insideCard(card.locator(".focus-widget__time"));
      await start.click();
      await expect(widgetState(page)).toContainText("FOCUSING");
      await insideCard(card.getByRole("button", { name: "Pause", exact: true }));
      await insideCard(card.getByRole("button", { name: "Stop", exact: true }));
      const completion = card.locator(".focus-completion");
      await expect(completion).toContainText("Focus complete", { timeout: 10_000 });
      await insideCard(completion);
      await insideCard(card.locator(".focus-widget__time"));
      await insideCard(start);
      const dismiss = card.getByRole("button", { name: "Dismiss completion", exact: true });
      await insideCard(dismiss);
      await dismiss.click();
      const alerts = card.getByRole("button", { name: "Alert settings", exact: true });
      await alerts.click();
      await expect(alerts).toHaveAttribute("aria-expanded", "true");
      await card.getByRole("button", { name: "Enable sound", exact: true }).scrollIntoViewIfNeeded();
      await expect(card.getByRole("button", { name: "Enable sound", exact: true })).toBeVisible();
      await alerts.click();
      await expect(alerts).toHaveAttribute("aria-expanded", "false");
      await expect(page).toHaveURL(/\/$/);
    }
  } finally {
    await ensureDashboardWidget(request);
  }
});

test("focus: dashboard pause and focus page resume stay in sync", async ({ page, request, context }) => {
  await putFocusSettings(request, 300);
  await ensureNextKindIsFocus(request);
  await ensureDashboardWidget(request);

  const pageB = await context.newPage();
  try {
    await page.goto("/");
    const card = page.locator(FOCUS_CARD);
    await card.getByRole("button", { name: "start" }).click();
    await expect(widgetState(page)).toContainText("FOCUSING", { timeout: 10_000 });

    await card.getByRole("button", { name: "pause" }).click();
    await expect(widgetState(page)).toContainText("PAUSED", { timeout: 10_000 });
    const pausedMinutes = /^(\d{2}):/.exec(await widgetTime(page).innerText());
    expect(pausedMinutes).not.toBeNull();

    // The /focus page adopts the same paused session with the same remaining
    // minutes (both read the server-frozen remainingSeconds; match to the
    // minute, not the second).
    await pageB.goto("/focus");
    await expect(pageB.getByText("PAUSED", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByRole("timer")).toHaveText(
      new RegExp(`^${pausedMinutes![1]}:\\d{2}$`),
      { timeout: 10_000 },
    );

    // Resume on the page; the dashboard widget follows WITHOUT any reload —
    // the focus BroadcastChannel makes it refetch.
    await pageB.getByRole("button", { name: "RESUME" }).click();
    await expect(pageB.getByText("FOCUSING", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(widgetState(page)).toContainText("FOCUSING", { timeout: 10_000 });

    // Stop on the page; both surfaces end up READY (page: local state,
    // dashboard: channel-driven refetch).
    await pageB.getByRole("button", { name: "STOP" }).click();
    await expect(pageB.getByText("READY", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(widgetState(page)).toContainText("READY", { timeout: 10_000 });
  } finally {
    await pageB.close();
  }
});

test("focus: page flow start-pause-resume-stop creates cancelled history", async ({ page, request }) => {
  await putFocusSettings(request, 300);
  await ensureNextKindIsFocus(request);
  const todayBefore = (await getFocusState(request)).today;

  await page.goto("/focus");
  await page.getByRole("button", { name: "START", exact: true }).click();
  await expect(page.getByText("FOCUSING", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "PAUSE", exact: true }).click();
  await expect(page.getByText("PAUSED", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".focus-completion")).toHaveCount(0);
  await page.getByRole("button", { name: "RESUME", exact: true }).click();
  await expect(page.getByText("FOCUSING", { exact: true })).toBeVisible({ timeout: 10_000 });
  // Let ≥2s of real focus time accumulate so the cancelled session's actual
  // duration survives the server's floor-to-seconds accounting.
  await page.waitForTimeout(2_500);
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".focus-completion")).toHaveCount(0);

  // Server accounting: the really-elapsed focus time counts, a cancelled
  // session does NOT count as a completed round, but it did end a session.
  const todayAfter = (await getFocusState(request)).today;
  expect(todayAfter.focusedSeconds).toBeGreaterThan(todayBefore.focusedSeconds);
  expect(todayAfter.completedRounds).toBe(todayBefore.completedRounds);
  expect(todayAfter.sessionsEnded).toBe(todayBefore.sessionsEnded + 1);

  // The Today zone renders the same numbers live (no reload needed).
  const stat = (label: string) => page.locator(".px-stat", { hasText: label }).locator(".px-stat__value");
  await expect(stat("Rounds")).toHaveText(String(todayBefore.completedRounds), { timeout: 10_000 });
  await expect(stat("Sessions")).toHaveText(String(todayBefore.sessionsEnded + 1), { timeout: 10_000 });

  // History fetches on mount, so reload to see the fresh terminal session:
  // newest first, carrying the Cancelled badge.
  await page.reload();
  const firstRow = page.locator(".focus-history__row").first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  await expect(firstRow).toContainText("Cancelled");
});

test("focus: settings changes apply to the next session", async ({ page, request }) => {
  await ensureNextKindIsFocus(request);

  await page.goto("/focus");
  await page.getByLabel("Focus minutes").fill("2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Settings saved")).toBeVisible({ timeout: 10_000 });

  // The idle preview already runs off the saved 120s...
  await expect(page.getByRole("timer")).toHaveText("02:00", { timeout: 10_000 });

  // ...and so does the session the next START creates (the response lands
  // a few ms after its expectedEndAt, so accept 119 remaining too).
  await page.getByRole("button", { name: "START", exact: true }).click();
  await expect(page.getByRole("timer")).toHaveText(/^(02:00|01:59)$/, { timeout: 10_000 });

  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("focus: reload while running keeps the timer", async ({ page, request }) => {
  await putFocusSettings(request, 300);
  await ensureNextKindIsFocus(request);

  await page.goto("/focus");
  await page.getByRole("button", { name: "START", exact: true }).click();
  await expect(page.getByText("FOCUSING", { exact: true })).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.getByText("FOCUSING", { exact: true })).toBeVisible({ timeout: 10_000 });
  const firstRead = parseClock(await page.getByRole("timer").innerText());
  expect(firstRead).toBeLessThanOrEqual(300);

  // The countdown is derived from expectedEndAt, so it keeps decreasing.
  await page.waitForTimeout(2_000);
  const secondRead = parseClock(await page.getByRole("timer").innerText());
  expect(secondRead).toBeLessThan(firstRead);

  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("focus: two tabs cannot create two conflicting timers", async ({ page, request, context }) => {
  await putFocusSettings(request, 300);
  await ensureNextKindIsFocus(request);

  const pageB = await context.newPage();
  try {
    await page.goto("/focus");
    await page.getByRole("button", { name: "START", exact: true }).click();
    await expect(page.getByText("FOCUSING", { exact: true })).toBeVisible({ timeout: 10_000 });

    // A second tab adopts the running session instead of offering a START
    // (running state only exposes PAUSE/STOP).
    await pageB.goto("/focus");
    await expect(pageB.getByText("FOCUSING", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByRole("button", { name: "START", exact: true })).toHaveCount(0);
    await expect(pageB.getByRole("button", { name: "PAUSE", exact: true })).toBeVisible();
    await expect(pageB.getByRole("button", { name: "STOP", exact: true })).toBeVisible();

    // The backend tracks exactly one active session: the first one, unmutated.
    const state = await getFocusState(request);
    expect(state.active).not.toBeNull();
    expect(state.active?.status).toBe("running");
    expect(state.active?.kind).toBe("focus");
    expect(state.active?.revision).toBe(1);

    await page.getByRole("button", { name: "STOP", exact: true }).click();
    await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByText("READY", { exact: true })).toBeVisible({ timeout: 10_000 });
  } finally {
    await pageB.close();
  }
});
