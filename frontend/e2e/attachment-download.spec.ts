import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { adminFetch } from "./helpers";

test("uploaded HTML downloads without opening an executable app-origin page", async ({ page, context }) => {
  const enabled = await adminFetch("PUT", "/api/core/apps/assets/enabled", { enabled: true });
  expect(enabled.ok).toBe(true);
  const created = await page.request.post("http://127.0.0.1:8902/api/apps/assets/items", { data: { name: "Attachment download regression" } });
  expect(created.status()).toBe(201);
  const item = await created.json();
  const bytes = Buffer.from("<script>fetch('/attachment-execution-probe')</script><h1>Untrusted file</h1>");
  let executed = false;
  let popups = 0;
  await context.route("**/attachment-execution-probe", async (route) => {
    executed = true;
    await route.fulfill({ status: 204 });
  });
  page.on("popup", () => { popups += 1; });
  try {
    const uploaded = await page.request.post(`http://127.0.0.1:8902/api/apps/assets/items/${item.id}/attachments`, {
      multipart: { file: { name: "active-upload.html", mimeType: "text/html", buffer: bytes } },
    });
    expect(uploaded.status()).toBe(201);
    await page.goto(`/assets/items/${item.id}`);
    const link = page.getByRole("link", { name: "active-upload.html", exact: true });
    await expect(link).toHaveAttribute("download", "");
    const downloading = page.waitForEvent("download");
    await link.click();
    const download = await downloading;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe("active-upload.html");
    expect(await readFile((await download.path())!)).toEqual(bytes);
    await expect(page).toHaveURL(new RegExp(`/assets/items/${item.id}$`));
    expect(popups).toBe(0);
    expect(executed).toBe(false);
  } finally {
    const removed = await page.request.delete(`http://127.0.0.1:8902/api/apps/assets/items/${item.id}`);
    expect(removed.status()).toBe(204);
  }
});
