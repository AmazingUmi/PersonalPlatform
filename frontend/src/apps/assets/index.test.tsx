import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssetsApp from "./index";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const categories = {
  items: [{ id: "cat-1", name: "Books", created_at: "2026-01-01T00:00:00Z" }],
};

function setupFetch(items: unknown[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/apps/assets/categories")) return jsonResponse(categories);
    if (url.includes("/api/apps/assets/items?") || url.endsWith("/api/apps/assets/items")) {
      return jsonResponse({ items });
    }
    if (url.includes("/summary")) return jsonResponse({ items: 0, categories: 0 });
    return jsonResponse(null, false, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(initialEntry = "/assets") {
  const page = AssetsApp.routes[0]!.element;
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>{page}</MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AssetsPage", () => {
  it("creates an item through the editor dialog", async () => {
    const fetchMock = setupFetch();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /new item/i }));
    const dialog = await screen.findByTestId("item-editor");
    expect(dialog).toBeDefined();

    fireEvent.change(screen.getByLabelText("Item name"), { target: { value: "Keyboard" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /create item/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("/api/apps/assets/items") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const init = call![1] as RequestInit;
      expect(JSON.parse(String(init.body))).toMatchObject({ name: "Keyboard", quantity: 2 });
    });
  });

  it("loads items with the query string from the URL", async () => {
    const fetchMock = setupFetch();
    renderPage("/assets?q=speaker&sortBy=name&order=asc");

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/apps/assets/items?"));
      expect(String(call![0])).toContain("q=speaker");
      expect(String(call![0])).toContain("sortBy=name");
      expect(String(call![0])).toContain("order=asc");
    });
  });

  it("shows category rename and delete controls", async () => {
    setupFetch();
    renderPage();

    await waitFor(() => expect(screen.getAllByText("Books").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /rename category books/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /delete category books/i })).toBeDefined();
  });

  it("differentiates empty inventory from no matches", async () => {
    setupFetch([]);
    renderPage("/assets?q=nothing");

    expect(await screen.findByText(/no matching items/i)).toBeDefined();

    cleanup();
    setupFetch([]);
    renderPage("/assets");
    expect(await screen.findByText(/your inventory is empty/i)).toBeDefined();
  });
});
