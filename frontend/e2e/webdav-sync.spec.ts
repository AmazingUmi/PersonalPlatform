import { expect, test } from "@playwright/test";

const linked = {
  linked: true, enabled: true, phase: "linked", intervalSeconds: 0, identityId: "identity-1",
  openConflicts: 0, lastError: null, backoffUntil: null, baseline: true, pending: false,
};

test("sync uses a real Web Lock without a cancellation signal", async ({ page }) => {
  await page.addInitScript(() => {
    const locks = navigator.locks;
    const request = locks.request.bind(locks);
    const calls: { ifAvailable?: boolean; hasSignal: boolean }[] = [];
    (window as unknown as { __syncLockCalls?: typeof calls }).__syncLockCalls = calls;
    locks.request = ((name: string, options?: LockOptions & { ifAvailable?: boolean }, callback?: (lock: Lock | null) => Promise<unknown>) => {
      const opts = typeof options === "function" ? undefined : options;
      const fn = typeof options === "function" ? options : callback;
      calls.push({ ifAvailable: opts?.ifAvailable, hasSignal: Boolean(opts && "signal" in opts) });
      if (opts?.ifAvailable && opts && "signal" in opts) {
        return Promise.reject(new DOMException("signal and ifAvailable", "NotSupportedError"));
      }
      return request(name, opts ?? {}, fn as (lock: Lock | null) => Promise<unknown>);
    }) as LockManager["request"];
  });
  await page.route("**/api/core/data/webdav**", async (route) => {
    const url = route.request().url();
    if (url.includes("/history")) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ json: { configured: true, endpoint: "https://drive.example.com/backup/", username: "backup-user", hasPassword: true, scope: "own", intervalHours: 0, nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null } });
  });
  await page.route("**/api/core/data/sync**", async (route) => {
    const url = route.request().url();
    if (route.request().method() === "POST" && url.endsWith("/cycle")) {
      return route.fulfill({ json: { ...linked, result: "idle", dataChanged: false } });
    }
    if (url.includes("/conflicts")) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ json: linked });
  });
  await page.goto("/settings?section=webdav&view=sync");
  await expect(page.getByRole("heading", { name: "Continuous sync" })).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("NotSupportedError")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __syncLockCalls?: { ifAvailable?: boolean; hasSignal: boolean }[] }).__syncLockCalls ?? [])).toEqual([
    expect.objectContaining({ ifAvailable: true, hasSignal: false }),
  ]);
});
