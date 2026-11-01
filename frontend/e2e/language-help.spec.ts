import { expect, test } from "@playwright/test";

test("language persists and synchronizes tabs without losing WebDAV drafts", async ({ page, context }) => {
  await page.goto("/settings?section=webdav");
  const endpoint = page.getByLabel("WebDAV folder URL");
  await endpoint.fill("https://example.com/MyFolder/");
  await page.getByLabel("WebDAV username").fill("My English username");
  const preferences = await context.newPage();
  await preferences.goto("/settings");
  await preferences.getByLabel("Language / 语言").selectOption("zh");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByLabel("WebDAV 目录地址")).toHaveValue("https://example.com/MyFolder/");
  await expect(page.getByLabel("WebDAV 用户名")).toHaveValue("My English username");
  await expect(page.getByRole("button", { name: "测试连接", exact: true })).toBeVisible();
  await preferences.reload();
  await expect(preferences.getByLabel("Language / 语言")).toHaveValue("zh");
  await preferences.getByLabel("Language / 语言").selectOption("en");
  await expect(endpoint).toHaveValue("https://example.com/MyFolder/");
  await expect(page.getByRole("button", { name: "Test connection", exact: true })).toBeVisible();
  await preferences.close();
});

test("Chinese navigation covers every app and keeps user data unchanged", async ({ page }) => {
  const title = `My English task ${Date.now()}`;
  const created = await page.request.post("/api/apps/tasks/tasks", { data: { title, priority: 2 } });
  expect(created.status()).toBe(201);
  const task = await created.json() as { id: string };
  try {
    await page.goto("/settings");
    await page.getByLabel("Language / 语言").selectOption("zh");
    for (const [route, title] of [["/apps", "应用中心"], ["/tasks", "任务"], ["/assets", "资产"], ["/notes", "笔记"], ["/clock", "时钟"], ["/focus", "专注"], ["/mini_game", "2048"], ["/", "仪表盘"]]) {
      await page.goto(route);
      await expect(page.locator("h1")).toHaveText(title);
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    }
    await page.goto("/tasks");
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  } finally {
    await page.request.delete(`/api/apps/tasks/tasks/${task.id}`);
  }
});

test("help is accessible on keyboard and stays inside narrow viewports", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings");
  await page.getByLabel("Language / 语言").selectOption("zh");
  const help = page.getByRole("button", { name: "帮助：设置", exact: true });
  await help.focus();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("settings-zh-desktop.png"), fullPage: true });

  await page.getByRole("navigation", { name: "设置分区" }).getByRole("link", { name: "WebDAV", exact: true }).click();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    const connectionHelp = page.getByRole("button", { name: "帮助：连接设置", exact: true });
    await connectionHelp.click();
    const dialog = page.getByRole("dialog", { name: "连接设置", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link", { name: "坚果云官方说明" })).toHaveAttribute("href", "https://help.jianguoyun.com/?p=3234");
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox();
      return !!bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height;
    }).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`help-zh-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});

test("touch opens help and outside tap closes it", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true, storageState: "playwright/.auth/user.json" });
  try {
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:5199/settings");
    await page.getByLabel("Language / 语言").selectOption("zh");
    await page.getByRole("button", { name: "帮助：设置", exact: true }).tap();
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    await page.getByRole("heading", { name: "系统", exact: true }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally { await context.close(); }
});


test("first visit follows browser Chinese and translates login feedback", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN", storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:5199/login");
    await expect(page.getByRole("heading", { name: "登录平台", exact: true })).toBeVisible();
    await page.getByLabel("用户名", { exact: true }).fill("unknown-language-test-user");
    await page.getByLabel("密码", { exact: true }).fill("incorrect-password");
    await page.getByRole("button", { name: "登录 ▸", exact: true }).click();
    await expect(page.getByText("登录失败：用户名或密码不正确。", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  } finally { await context.close(); }
});
