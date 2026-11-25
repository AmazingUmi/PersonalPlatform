import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppInfo, AuthUser } from "../shared/api";
import { I18nProvider } from "../shared/i18n";
import { SESSION_ENDING_EVENT } from "../shared/sync";
import { Settings } from "./Settings";

const account: AuthUser = { id: "ada-id", username: "ada", displayName: "Ada", role: "user" };
const auth = vi.hoisted(() => ({ user: null as AuthUser | null }));
vi.mock("./AuthContext", () => ({ useAuth: () => auth }));

const tasks: AppInfo = {
  id: "tasks", name: "Tasks", route: "/tasks", version: "1", description: "",
  status: "enabled", enabled: true, defaultEnabled: true, hasBackend: true, hasFrontend: true, widgets: [],
  capabilities: { database: true, storage: false, events: false, scheduler: false },
};
const agent = {
  id: "owned-agent", name: "Pepper", description: "Task helper", status: "active", tokenPrefix: "sampleab",
  requiresExplicitActor: true, createdAt: "2026-11-24T08:00:00.000Z", lastUsedAt: null,
};
const grant = {
  id: "grant-1", agentId: "paired-agent", agentName: "Partner", ownerName: "Lina",
  status: "active", agentStatus: "active", expiresAt: null, scopes: ["read", "write"], allowedApps: ["tasks"],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function showAgents(apps: AppInfo[] = [tasks]) {
  auth.user = account;
  return render(<I18nProvider initialLanguage="en"><MemoryRouter initialEntries={["/settings?section=agents"]}>
    <Settings apps={apps} />
  </MemoryRouter></I18nProvider>);
}

function confirm() {
  fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Confirm" }));
}

afterEach(() => {
  cleanup();
  auth.user = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agents Settings", () => {
  it("requires explicit personal consent and removes the one-time token when leaving the panel", async () => {
    const token = "one-time-token-for-ada";
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes("/audit")) return json({ items: [], nextCursor: null });
      if (init?.method === "POST") return json({ agent, token }, 201);
      return json({ owned: [], grants: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    showAgents([tasks, { ...tasks, id: "future_app", name: "Future App", route: "/future_app" }]);
    fireEvent.click(await screen.findByRole("button", { name: "Create personal Agent" }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Pepper" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Read" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tasks" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Future App" }));
    fireEvent.click(screen.getByRole("button", { name: "Review authorization" }));
    expect(within(screen.getByTestId("confirm-dialog")).getByText("Create Pepper with Read · Tasks, Future App?")).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    confirm();
    const secret = await screen.findByRole("region", { name: "One-time token" });
    expect(within(secret).getByText(token, { exact: true })).toBeVisible();
    expect(secret).toHaveTextContent("@modelcontextprotocol/inspector@2.16.0");
    expect(secret).toHaveTextContent("X-PP-Acting-User: ada");
    expect(JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as string))
      .toEqual({ name: "Pepper", description: "", scopes: ["read"], allowedApps: ["tasks", "future_app"] });

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(nav).getByRole("link", { name: "General" }));
    expect(screen.queryByText(token)).not.toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("link", { name: "Agents" }));
    expect(screen.queryByText(token)).not.toBeInTheDocument();
  });

  it("previews an owner-controlled pairing, narrows it, and submits the code only after consent", async () => {
    let approved = false;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/pairings/preview")) {
        return json({ agentName: grant.agentName, ownerName: grant.ownerName, scopes: grant.scopes, allowedApps: grant.allowedApps, expiresAt: "2026-11-25T14:00:00Z" });
      }
      if (input.endsWith("/pairings/approve")) {
        approved = true;
        return json({ grant: { ...grant, scopes: ["read"] } });
      }
      if (input.includes("/audit")) return json({ items: [], nextCursor: null });
      return json({ owned: [], grants: approved ? [{ ...grant, scopes: ["read"] }] : [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    showAgents();
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "invite-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview pairing" }));
    expect(await screen.findByText(/Owned by Lina.*Rotating it retains/)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Write" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Write" }));
    fireEvent.click(screen.getByRole("button", { name: "Review pairing approval" }));
    expect(within(screen.getByTestId("confirm-dialog")).getByText("Allow Partner to use Read · Tasks on your account?")).toBeVisible();
    expect(approved).toBe(false);
    confirm();
    expect(await screen.findByText("Pairing approved.")).toBeVisible();
    expect(screen.getByLabelText("Pairing code")).toHaveValue("");
    const approval = fetchMock.mock.calls.find(([input]) => input.endsWith("/pairings/approve"))!;
    expect(JSON.parse(approval[1]!.body as string)).toEqual({ code: "invite-code", scopes: ["read"], allowedApps: ["tasks"] });
    expect(fetchMock.mock.calls.every(([input]) => !input.includes("invite-code"))).toBe(true);
  });

  it("limits grant edits to existing access and pages through the acting user's audit", async () => {
    const first = { id: "event-1", agentName: "Partner", appId: "tasks", toolName: "tasks_complete", actionKind: "write",
      resourceId: "owned-task", status: "ok", errorCode: null, createdAt: "2026-11-25T09:00:00Z" };
    const second = { ...first, id: "event-2", toolName: "tasks_delete", status: "conflict", errorCode: "conflict" };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return json({ grant: { ...grant, scopes: ["read"] } });
      if (input.includes("cursor=next-page")) return json({ items: [second], nextCursor: null });
      if (input.includes("/audit")) return json({ items: [first], nextCursor: "next-page" });
      return json({ owned: [], grants: [grant] });
    });
    vi.stubGlobal("fetch", fetchMock);
    showAgents();
    expect(await screen.findByText("Agent: Partner")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("tasks_delete")).toBeVisible();
    expect(screen.getByText(/^Conflict/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("tasks_complete")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Narrow access" }));
    expect(screen.queryByRole("checkbox", { name: "Delete" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Write" }));
    fireEvent.click(screen.getByRole("button", { name: "Save grant" }));
    expect(await screen.findByText("Grant updated.")).toBeVisible();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/core/agents/grants/grant-1");
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ scopes: ["read"], allowedApps: ["tasks"] });
  });

  it("discards a generated pairing code as soon as account sign-out starts", async () => {
    const pairingCode = "issued-secret-code";
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes("/audit")) return json({ items: [], nextCursor: null });
      if (init?.method === "POST") return json({ code: pairingCode, expiresAt: "2026-11-25T14:00:00Z" }, 201);
      return json({ owned: [agent], grants: [] });
    }));
    showAgents();
    fireEvent.click(await screen.findByRole("button", { name: "Create pairing code" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Read" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate pairing code" }));
    expect(await screen.findByText(pairingCode)).toBeVisible();
    fireEvent(window, new Event(SESSION_ENDING_EVENT));
    expect(screen.queryByText(pairingCode)).not.toBeInTheDocument();
  });
});
