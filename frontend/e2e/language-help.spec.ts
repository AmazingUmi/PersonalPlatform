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


/** Visible help triggers must share a row with real anchor text, and the page must not scroll sideways. */
async function helpLayoutIssues(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => {
    const shown = (element: Element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (element.closest("[hidden]")) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const issues: string[] = [];
    const helps = [...document.querySelectorAll(".px-help")].filter(shown);
    if (helps.length === 0) issues.push("no visible help");
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) issues.push("page overflows horizontally");
    for (const help of helps) {
      const name = help.getAttribute("aria-label") ?? "?";
      const parent = help.parentElement;
      if (!parent) { issues.push(`detached ${name}`); continue; }
      if (help.closest("h1, h2, h3, label, a")) issues.push(`nested ${name}`);
      if (parent.closest("button, a, label")) issues.push(`interactive host ${name}`);
      const triggers = [...parent.children].filter((element) => element.classList.contains("px-help"));
      if (triggers.length !== 1) issues.push(`cluster ${name}`);
      const anchor = [...parent.children].find((element) => element !== help && !element.classList.contains("px-help") && (element.textContent ?? "").trim());
      if (!anchor) { issues.push(`orphan ${name}`); continue; }
      const anchorBox = anchor.getBoundingClientRect();
      const helpBox = help.getBoundingClientRect();
      const overlap = Math.min(anchorBox.bottom, helpBox.bottom) - Math.max(anchorBox.top, helpBox.top);
      if (overlap < Math.min(helpBox.height, 16) * 0.5) issues.push(`separate row ${name}`);
      if (helpBox.left + 2 < anchorBox.left) issues.push(`before anchor ${name}`);
      if (helpBox.left - anchorBox.right > 20) issues.push(`far ${name}`);
    }
    for (const heading of document.querySelectorAll("h1, h2, h3")) {
      if (heading.querySelector(".px-help")) issues.push(`heading contains help ${heading.textContent}`);
    }
    return issues;
  });
}

async function expectSettledHelp(page: import("@playwright/test").Page) {
  await expect.poll(() => helpLayoutIssues(page), { timeout: 5000 }).toEqual([]);
}

test("help stays beside its anchor in English and Chinese at desktop and 320px", async ({ page }) => {
  test.setTimeout(180_000);
  const routes: Array<{ path: string; en: string; zh: string }> = [
    { path: "/", en: "Dashboard", zh: "仪表盘" },
    { path: "/apps", en: "App Center", zh: "应用中心" },
    { path: "/tasks", en: "Tasks", zh: "任务" },
    { path: "/notes", en: "Notes", zh: "笔记" },
    { path: "/assets", en: "Assets", zh: "资产" },
    { path: "/clock", en: "Clock", zh: "时钟" },
    { path: "/focus", en: "Focus", zh: "专注" },
    { path: "/mini_game", en: "2048", zh: "2048" },
    { path: "/settings", en: "Settings", zh: "设置" },
    { path: "/settings?section=data", en: "Data management", zh: "数据管理" },
    { path: "/settings?section=webdav", en: "WebDAV backup", zh: "WebDAV 备份" },
    { path: "/settings?section=webdav&view=backup", en: "WebDAV backup", zh: "WebDAV 备份" },
    { path: "/settings?section=webdav&view=history", en: "WebDAV backup", zh: "WebDAV 备份" },
  ];
  for (const language of ["en", "zh"] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true }).or(page.getByRole("heading", { name: "设置", exact: true }))).toBeVisible();
    await page.getByLabel("Language / 语言").selectOption(language);
    for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await page.goto(route.path);
        await expect(page.getByRole("heading", { name: language === "zh" ? route.zh : route.en, exact: true })).toBeVisible();
        await expect.poll(() => page.locator(".px-help").count()).toBeGreaterThan(0);
        await expectSettledHelp(page);
      }
      await page.goto("/clock");
      await page.getByRole("button", { name: language === "zh" ? "+ 添加闹钟" : "+ Add Alarm", exact: true }).click();
      await expect(page.getByRole("heading", { name: language === "zh" ? "新闹钟" : "New Alarm", exact: true })).toBeVisible();
      const repeatText = page.getByText(language === "zh" ? "重复" : "Repeat", { exact: true });
      const repeatHelp = page.getByRole("button", { name: language === "zh" ? "帮助：重复日期" : "Help: Repeat days", exact: true });
      await expect(repeatText).toBeVisible();
      await expect(repeatHelp).toBeVisible();
      await expect.poll(async () => {
        const textBox = await repeatText.boundingBox();
        const helpBox = await repeatHelp.boundingBox();
        if (!textBox || !helpBox) return "missing box";
        const overlap = Math.min(textBox.y + textBox.height, helpBox.y + helpBox.height) - Math.max(textBox.y, helpBox.y);
        if (overlap < 12) return `separate row ${textBox.y}/${helpBox.y}`;
        if (helpBox.x + 2 < textBox.x) return "before text";
        if (helpBox.x - (textBox.x + textBox.width) > 20) return `far ${helpBox.x - textBox.x - textBox.width}`;
        return "ok";
      }).toBe("ok");
      await expectSettledHelp(page);
      await page.getByRole("button", { name: language === "zh" ? "取消" : "Cancel", exact: true }).click();
      await expect(page.getByRole("heading", { name: language === "zh" ? "新闹钟" : "New Alarm", exact: true })).toHaveCount(0);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings");
  await page.getByLabel("Language / 语言").selectOption("en");
  await page.goto("/settings?section=webdav");
  await expect(page.getByRole("heading", { name: "WebDAV backup", exact: true })).toBeVisible();
  const connection = page.getByRole("button", { name: "Help: Connection setup", exact: true });
  await expect(connection.locator("xpath=..")).toContainText("WebDAV folder URL");
  await expect(page.getByRole("navigation", { name: "WebDAV sections" }).locator(".px-help")).toHaveCount(0);
  await connection.click();
  const dialog = page.getByRole("dialog", { name: "Connection setup", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Nutstore instructions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Help: 2048 high score", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("dialog", { name: "2048 high score", exact: true })).toBeVisible();

  const longTitle = `Long task title ${"Overflow".repeat(12)}`;
  const created = await page.request.post("/api/apps/tasks/tasks", { data: { title: longTitle, priority: 2 } });
  expect(created.status()).toBe(201);
  const task = await created.json() as { id: string };
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/tasks/${task.id}`);
      await expect(page.getByRole("heading", { name: longTitle, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Help: Task detail", exact: true })).toBeVisible();
      await expectSettledHelp(page);
    }
  } finally {
    await page.request.delete(`/api/apps/tasks/tasks/${task.id}`);
  }
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
