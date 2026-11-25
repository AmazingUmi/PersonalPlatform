import { randomUUID } from "node:crypto";
import { expect, request as playwrightRequest, test, type APIRequestContext, type APIResponse, type Browser, type Page } from "@playwright/test";

const agentName = "Field Assistant";
const endpoint = "/api/agent/mcp";
const protocol = "2025-11-25";
const noSession = { cookies: [], origins: [] };

async function ordinaryAccount(admin: Page, browser: Browser, baseURL: string | undefined, label: string, suffix: string) {
  const username = "agent-" + label.toLowerCase() + "-" + suffix;
  const password = "agent-e2e-password-1";
  const created = await admin.request.post("/api/core/auth/users", { data: { username, password, displayName: label } });
  expect(created.status()).toBe(201);
  const context = await browser.newContext({ baseURL, storageState: noSession });
  try {
    const signedIn = await context.request.post("/api/core/auth/login", { data: { username, password } });
    expect(signedIn.status()).toBe(200);
    return { page: await context.newPage(), username, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function selectPermissions(page: Page) {
  for (const name of ["Read", "Write", "Delete", "Tasks"]) {
    await page.getByRole("checkbox", { name, exact: true }).check();
  }
}

async function confirm(page: Page) {
  await page.getByTestId("confirm-dialog").getByRole("button", { name: "Confirm", exact: true }).click();
}

function bearer(token: string, actor?: string) {
  return { Authorization: "Bearer " + token, ...(actor ? { "X-PP-Acting-User": actor } : {}) };
}

async function httpTool<T>(client: APIRequestContext, token: string, actor: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.post("/api/agent/v1/tools/" + name, { headers: bearer(token, actor), data: args });
  expect(response.status(), await response.text()).toBe(200);
  const result = await response.json() as { ok: boolean; data: T };
  expect(result.ok).toBe(true);
  return result.data;
}

async function rpcResponse<T>(response: APIResponse, id: number): Promise<T> {
  const text = await response.text();
  expect(response.status(), text).toBe(200);
  if (response.headers()["content-type"]?.startsWith("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      const frame = /^data:\s*(\{.*\})$/.exec(line)?.[1];
      if (!frame) continue;
      const message = JSON.parse(frame) as { id?: number; result?: T; error?: unknown };
      if (message.id === id) {
        expect(message.error).toBeUndefined();
        expect(message.result).toBeDefined();
        return message.result!;
      }
    }
    throw new Error("MCP response did not contain the request result");
  }
  const message = JSON.parse(text) as { id: number; result?: T; error?: unknown };
  expect(message.id).toBe(id);
  expect(message.error).toBeUndefined();
  expect(message.result).toBeDefined();
  return message.result!;
}

function mcpClient(client: APIRequestContext, token: string, actor: string) {
  let sequence = 0;
  const headers = { ...bearer(token, actor), Accept: "application/json, text/event-stream" };
  async function call<T>(method: string, params?: unknown): Promise<T> {
    const id = ++sequence;
    const response = await client.post(endpoint, {
      headers: { ...headers, ...(method !== "initialize" && { "MCP-Protocol-Version": protocol }) },
      data: { jsonrpc: "2.0", id, method, ...(params && { params }) },
    });
    return rpcResponse<T>(response, id);
  }
  return {
    call,
    async initialize() {
      const init = await call<{ protocolVersion: string }>("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "PersonalPlatform browser test", version: "1.0.0" } });
      expect(init.protocolVersion).toBe(protocol);
      const initialized = await client.post(endpoint, {
        headers: { ...headers, "MCP-Protocol-Version": protocol },
        data: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      expect(initialized.status()).toBe(202);
      expect(await initialized.text()).toBe("");
    },
    async tool<T>(name: string, args: Record<string, unknown>) {
      const result = await call<{ isError?: boolean; structuredContent: { ok: boolean; data: T } }>("tools/call", { name, arguments: args });
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent.ok).toBe(true);
      return result.structuredContent.data;
    },
  };
}

test("two browser users consent to the same Agent and reconcile isolated MCP and HTTP activity", async ({ page, browser, baseURL }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await ordinaryAccount(page, browser, baseURL, "Owner", suffix);
  const contexts = [owner];
  const wire = await playwrightRequest.newContext({ baseURL, storageState: noSession });
  try {
    const recipient = await ordinaryAccount(page, browser, baseURL, "Recipient", suffix);
    contexts.push(recipient);
    await owner.page.goto("/settings?section=agents");
    await owner.page.getByRole("button", { name: "Create personal Agent" }).click();
    await owner.page.getByLabel("Agent name").fill(agentName);
    await selectPermissions(owner.page);
    await owner.page.getByRole("button", { name: "Review authorization" }).click();
    await expect(owner.page.getByTestId("confirm-dialog").getByText("Create Field Assistant with Read, Write, Delete · Tasks?")).toBeVisible();
    await confirm(owner.page);
    const secret = owner.page.getByRole("region", { name: "One-time token" });
    await expect(secret).toBeVisible();
    const token = await secret.locator("pre").first().innerText();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(secret.getByText(/X-PP-Acting-User:/)).toContainText(owner.username);
    await secret.getByRole("button", { name: "Dismiss" }).click();
    await expect(secret).toHaveCount(0);

    const personal = await wire.get("/api/agent/v1/manifest", { headers: bearer(token) });
    expect(personal.status()).toBe(200);
    expect((await personal.json()).actingUser.username).toBe(owner.username);
    await owner.page.getByRole("button", { name: "Create pairing code" }).click();
    await selectPermissions(owner.page);
    await owner.page.getByRole("button", { name: "Generate pairing code" }).click();
    const issued = owner.page.getByRole("region", { name: "Pairing code" });
    await expect(issued).toBeVisible();
    const code = await issued.locator("pre").innerText();
    expect(code.length).toBeGreaterThanOrEqual(22);

    await recipient.page.goto("/settings?section=agents");
    await recipient.page.getByLabel("Pairing code").fill(code);
    await recipient.page.getByRole("button", { name: "Preview pairing" }).click();
    await expect(recipient.page.getByText(/Owned by Owner.*Rotating it retains/)).toBeVisible();
    await recipient.page.getByRole("button", { name: "Review pairing approval" }).click();
    await expect(recipient.page.getByTestId("confirm-dialog").getByText("Allow Field Assistant to use Read, Write, Delete · Tasks on your account?")).toBeVisible();
    await confirm(recipient.page);
    await expect(recipient.page.getByText("Pairing approved.")).toBeVisible();
    await expect(recipient.page.getByLabel("Pairing code")).toHaveValue("");

    const missingActor = await wire.get("/api/agent/v1/manifest", { headers: bearer(token) });
    expect(missingActor.status()).toBe(400);
    expect((await missingActor.json()).error.code).toBe("acting_user_required");

    const ownerTitle = "Owner's archived task";
    const recipientTitle = "Recipient's archived task";
    const own = await httpTool<{ id: string }>(wire, token, owner.username, "tasks_create", { title: ownerTitle, idempotencyKey: randomUUID() });
    const ownerProof = await httpTool<{ baseHash: string }>(wire, token, owner.username, "tasks_get", { id: own.id });

    const mcp = mcpClient(wire, token, recipient.username);
    await mcp.initialize();
    const tools = await mcp.call<{ tools: { name: string }[] }>("tools/list");
    expect(tools.tools.map(tool => tool.name)).toContain("tasks_delete");
    const resources = await mcp.call<{ resources: { uri: string }[] }>("resources/list");
    const uri = "pp://apps/tasks/summary";
    expect(resources.resources.map(item => item.uri)).toContain(uri);
    const summary = await mcp.call<{ contents: { uri: string }[] }>("resources/read", { uri });
    expect(summary.contents[0]?.uri).toBe(uri);
    const paired = await mcp.tool<{ id: string }>("tasks_create", { title: recipientTitle, idempotencyKey: randomUUID() });
    const pairedProof = await mcp.tool<{ baseHash: string }>("tasks_get", { id: paired.id });

    const foreign = await wire.post("/api/agent/v1/tools/tasks_get", { headers: bearer(token, recipient.username), data: { id: own.id } });
    expect(foreign.status()).toBe(404);
    await httpTool(wire, token, owner.username, "tasks_delete", { id: own.id, baseHash: ownerProof.baseHash });
    await mcp.tool("tasks_delete", { id: paired.id, baseHash: pairedProof.baseHash });

    for (const [account, ownId, foreignId] of [[owner, own.id, paired.id], [recipient, paired.id, own.id]] as const) {
      await account.page.reload();
      await expect(account.page.getByText("tasks_create", { exact: true })).toBeVisible();
      await expect(account.page.getByText("tasks_delete", { exact: true })).toBeVisible();
      await expect(account.page.getByText(ownId, { exact: true })).toHaveCount(2);
      await expect(account.page.getByText(foreignId, { exact: true })).toHaveCount(0);
      await account.page.goto("/settings?section=trash");
      await expect(account.page.getByText("Agent: " + agentName)).toBeVisible();
    }
    await expect(owner.page.getByRole("heading", { name: ownerTitle, exact: true })).toBeVisible();
    await expect(owner.page.getByRole("heading", { name: recipientTitle, exact: true })).toHaveCount(0);
    await expect(recipient.page.getByRole("heading", { name: ownerTitle, exact: true })).toHaveCount(0);
    await recipient.page.getByRole("button", { name: "Restore " + recipientTitle, exact: true }).click();
    const restoredLink = recipient.page.getByRole("link", { name: "Open restored item" });
    const restoredPath = await restoredLink.getAttribute("href");
    expect(restoredPath).toMatch(/^\/tasks\/[0-9a-f-]{36}$/);
    expect(restoredPath).not.toBe("/tasks/" + paired.id);
    await restoredLink.click();
    await expect(recipient.page.getByRole("heading", { name: recipientTitle, exact: true })).toBeVisible();

    await recipient.page.goto("/settings?section=agents");
    await recipient.page.getByRole("button", { name: "Revoke grant", exact: true }).click();
    await confirm(recipient.page);
    await expect(recipient.page.getByText("Grant revoked.")).toBeVisible();
    const revoked = await wire.get("/api/agent/v1/manifest", { headers: bearer(token, recipient.username) });
    expect(revoked.status()).toBe(403);
    expect((await revoked.json()).error.code).toBe("forbidden");
    expect((await wire.get("/api/agent/v1/manifest", { headers: bearer(token, owner.username) })).status()).toBe(200);
    expect((await wire.get("/api/agent/v1/manifest", { headers: bearer(token) })).status()).toBe(400);
  } finally {
    await Promise.all([wire.dispose(), ...contexts.map(context => context.close())]);
  }
});
