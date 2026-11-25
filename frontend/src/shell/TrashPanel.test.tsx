import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../shared/i18n";
import { TrashPanel } from "./TrashPanel";

const userEntry = {
  id: "trash-1", appId: "tasks", entityType: "task", entityId: "old-task", title: "Draft task",
  summary: "Old draft", deletedByType: "user", deletedByLabel: "ada",
  deletedAt: "2026-11-23T09:00:00.000Z", expiresAt: "2026-11-26T10:00:00.000Z",
};
const agentEntry = {
  ...userEntry,
  id: "trash-2", appId: "clock", entityType: "clock_alarm", entityId: "old-alarm", title: "Morning alarm",
  summary: null, deletedByType: "agent", deletedByLabel: "Pepper",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function showTrash() {
  return render(<I18nProvider initialLanguage="en"><MemoryRouter><TrashPanel apps={[]} /></MemoryRouter></I18nProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TrashPanel", () => {
  it("shows actor and remaining days, paginates, filters, and links to the restored alarm's fresh ID", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-25T09:00:00.000Z"));
    let restored = false;
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (init?.method === "POST") {
        restored = true;
        return json({ restoredId: "fresh-alarm", appId: "clock", entityType: "clock_alarm" });
      }
      if (url.searchParams.get("appId") === "clock") return json({ items: restored ? [] : [agentEntry], hasMore: false });
      if (url.searchParams.get("offset") === "20") return json({ items: [agentEntry], hasMore: false });
      return json({ items: [userEntry], hasMore: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    showTrash();
    expect(await screen.findByText("Draft task")).toBeVisible();
    expect(screen.getByText("Old draft")).toBeVisible();
    expect(screen.getByText("You")).toBeVisible();
    expect(screen.getByText("2 days left")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Agent: Pepper")).toBeVisible();
    expect(requests).toContain("GET /api/core/trash?limit=20&offset=20");

    fireEvent.change(screen.getByLabelText("App"), { target: { value: "clock" } });
    expect(await screen.findByText("Morning alarm")).toBeVisible();
    expect(requests).toContain("GET /api/core/trash?limit=20&offset=0&appId=clock");
    fireEvent.click(screen.getByRole("button", { name: "Restore Morning alarm" }));
    expect(await screen.findByRole("link", { name: "Open restored item" })).toHaveAttribute("href", "/clock?alarm=fresh-alarm");
    expect(await screen.findByText("No items from this app")).toBeVisible();
    expect(requests).toContain("POST /api/core/trash/trash-2/restore");
  });

  it("requires confirmation for both permanent deletion and emptying the entire Trash", async () => {
    let entries = [userEntry, agentEntry];
    const deletes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      if (init?.method === "DELETE") {
        deletes.push(url.pathname);
        entries = url.pathname.endsWith("/trash-1") ? entries.filter((entry) => entry.id !== "trash-1") : [];
        return new Response(null, { status: 204 });
      }
      const appId = url.searchParams.get("appId");
      return json({ items: appId ? entries.filter((entry) => entry.appId === appId) : entries, hasMore: false });
    }));

    showTrash();
    const purge = await screen.findByRole("button", { name: "Permanently delete Draft task" });
    fireEvent.click(purge);
    expect(deletes).toEqual([]);
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Cancel" }));
    expect(deletes).toEqual([]);
    fireEvent.click(purge);
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Permanent Delete" }));
    expect(await screen.findByText("Item permanently deleted.")).toBeVisible();
    expect(deletes).toEqual(["/api/core/trash/trash-1"]);

    await screen.findByText("Morning alarm");
    fireEvent.change(screen.getByLabelText("App"), { target: { value: "clock" } });
    await screen.findByText("Morning alarm");
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    expect(within(screen.getByTestId("confirm-dialog")).getByText(/across all apps/)).toBeVisible();
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Empty Trash" }));
    expect(await screen.findByText("Trash emptied.")).toBeVisible();
    expect(deletes).toEqual(["/api/core/trash/trash-1", "/api/core/trash"]);
  });

  it("keeps an item visible and explains when its app is disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => init?.method === "POST"
      ? json({ error: { code: "app_disabled" } }, 409)
      : json({ items: [userEntry], hasMore: false })));

    showTrash();
    fireEvent.click(await screen.findByRole("button", { name: "Restore Draft task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enable this app in App Center before restoring the item.");
    expect(screen.getByText("Draft task")).toBeVisible();
    expect(screen.getByRole("button", { name: "Restore Draft task" })).toBeEnabled();
  });
});
