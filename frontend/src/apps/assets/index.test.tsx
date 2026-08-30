import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssetsApp from "./index";

interface TestCategory {
  id: string;
  name: string;
  color: string | null;
}

interface TestItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  acquiredAt: string | null;
  targetLocation: string | null;
  createdAt: string;
  updatedAt: string;
  categories: TestCategory[];
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const categories: TestCategory[] = [
  { id: "cat-1", name: "Books", color: "mint" },
  { id: "cat-2", name: "Tools", color: null },
  { id: "cat-3", name: "Games", color: "coral" },
];

function makeItem(overrides: Partial<TestItem> & { id: string; name: string }): TestItem {
  return {
    description: null,
    quantity: 1,
    acquiredAt: null,
    targetLocation: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    categories: [],
    ...overrides,
  };
}

/** Card fixture: three categories (colored / null / colored) + a location. */
const stripedItem = makeItem({
  id: "item-1",
  name: "Desk lamp",
  quantity: 2,
  targetLocation: "shelf-a",
  categories: [categories[0]!, categories[1]!, categories[2]!],
});

interface Fixture {
  items?: TestItem[];
  counts?: { all: number; categories: Record<string, number> };
  detail?: TestItem;
}

function setupFetch(fixture: Fixture = {}) {
  const items = fixture.items ?? [];
  const itemsBody = {
    items,
    counts: fixture.counts ?? { all: items.length, categories: {} },
  };
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/attachments")) return jsonResponse({ items: [] });
    // Detail item path (…/items/<id>) must be matched before the list path.
    if (/\/api\/apps\/assets\/items\/[^/?]+$/.test(url)) {
      if (init?.method === "PATCH") return jsonResponse({});
      return jsonResponse(fixture.detail ?? makeItem({ id: "item-x", name: "Item" }));
    }
    if (url.includes("/api/apps/assets/items")) return jsonResponse(itemsBody);
    if (url.includes("/api/apps/assets/categories")) return jsonResponse({ items: categories });
    if (url.includes("/summary")) return jsonResponse({ items: 0, categories: 0 });
    return jsonResponse(null, false, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** GET list requests (the proxy for the URL filter state). */
function listRequests(fetchMock: ReturnType<typeof setupFetch>): string[] {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).includes("/api/apps/assets/items") &&
        (!init?.method || init.method === "GET"),
    )
    .map(([url]) => decodeURIComponent(String(url)));
}

function renderPage(initialEntry = "/assets") {
  const page = AssetsApp.routes[0]!.element;
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>{page}</MemoryRouter>,
  );
}

/** The edit flow lives on the detail route (useParams needs a real match). */
function renderDetail(detail: TestItem) {
  return render(
    <MemoryRouter initialEntries={[`/assets/items/${detail.id}`]}>
      <Routes>
        <Route path="/assets" element={AssetsApp.routes[0]!.element} />
        <Route path="/assets/items/:id" element={AssetsApp.routes[1]!.element} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AssetsPage", () => {
  it("creates an item through the editor dialog, sending the selected category ids", async () => {
    const fetchMock = setupFetch({ items: [stripedItem] });
    renderPage();

    // Bare create: the (empty) category set is sent explicitly.
    fireEvent.click(screen.getByRole("button", { name: "New Item" }));
    const dialog = await screen.findByTestId("item-editor");
    expect(dialog).toBeDefined();

    fireEvent.change(screen.getByLabelText("Item name"), { target: { value: "Keyboard" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /create item/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("/api/apps/assets/items") && init?.method === "POST",
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({
        name: "Keyboard",
        quantity: 2,
        categoryIds: [],
      });
    });

    // Second create with two categories toggled on in the chip group.
    fireEvent.click(screen.getByRole("button", { name: "New Item" }));
    await screen.findByTestId("item-editor");
    fireEvent.change(screen.getByLabelText("Item name"), { target: { value: "Lamp" } });
    fireEvent.click(screen.getByRole("button", { name: "Toggle category Books" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle category Games" }));
    fireEvent.click(screen.getByRole("button", { name: /create item/i }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/api/apps/assets/items") && init?.method === "POST",
      );
      expect(posts.length).toBe(2);
      expect(JSON.parse(String(posts[1]![1]!.body))).toMatchObject({
        name: "Lamp",
        categoryIds: ["cat-1", "cat-3"],
      });
    });
  });

  it("loads items with the query string from the URL", async () => {
    const fetchMock = setupFetch();
    renderPage("/assets?q=speaker&sortBy=name&order=asc");

    await waitFor(() => {
      const last = listRequests(fetchMock).at(-1)!;
      expect(last).toContain("q=speaker");
      expect(last).toContain("sortBy=name");
      expect(last).toContain("order=asc");
    });
  });

  it("passes multiple URL categories through to the items query string", async () => {
    const fetchMock = setupFetch();
    renderPage("/assets?categories=cat-1,cat-2");

    await waitFor(() => {
      expect(listRequests(fetchMock).at(-1)!).toContain("categories=cat-1,cat-2");
    });
    // Both chips light up; the All chip does not.
    expect(screen.getByRole("button", { name: "Filter by category Books" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Filter by category Tools" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "All categories" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("filters on chip click and reveals manage actions behind the menu button", async () => {
    const fetchMock = setupFetch({ items: [stripedItem] });
    renderPage();

    const chip = await screen.findByRole("button", { name: "Filter by category Books" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    const requestsBefore = listRequests(fetchMock).length;

    // Chip main click = filter toggle: pressed flips, URL gains the category,
    // and the items request refires.
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(listRequests(fetchMock).at(-1)!).toContain("categories=cat-1");
    });
    expect(listRequests(fetchMock).length).toBeGreaterThan(requestsBefore);

    // Manage actions live behind the dedicated menu button, not the chip.
    const manage = screen.getByRole("button", { name: "Manage category Books" });
    expect(manage).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Rename category Books" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete category Books" })).toBeNull();

    fireEvent.click(manage);
    expect(manage).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Rename category Books" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Delete category Books" })).toBeDefined();
    // The old standalone filter tool is gone — the chip itself filters now.
    const tools = manage.closest(".px-chip-group")!.querySelectorAll(".px-chip__tools button");
    expect(tools.length).toBe(2);
  });

  it("deselects a category chip on the second click", async () => {
    const fetchMock = setupFetch();
    renderPage();

    const chip = await screen.findByRole("button", { name: "Filter by category Books" });
    fireEvent.click(chip);
    await waitFor(() => {
      expect(listRequests(fetchMock).at(-1)!).toContain("categories=cat-1");
    });

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      const last = listRequests(fetchMock).at(-1)!;
      expect(last).not.toContain("categories=");
    });
  });

  it("activates two category chips at once (AND filter)", async () => {
    const fetchMock = setupFetch();
    renderPage();

    const books = await screen.findByRole("button", { name: "Filter by category Books" });
    fireEvent.click(books);
    await waitFor(() => {
      expect(listRequests(fetchMock).at(-1)!).toContain("categories=cat-1");
    });

    const tools = screen.getByRole("button", { name: "Filter by category Tools" });
    fireEvent.click(tools);
    expect(books).toHaveAttribute("aria-pressed", "true");
    expect(tools).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(listRequests(fetchMock).at(-1)!).toContain("categories=cat-1,cat-2");
    });
  });

  it("collapses filters behind a header button and opens on demand", async () => {
    const fetchMock = setupFetch();
    renderPage();

    // Panel is collapsed by default.
    expect(screen.queryByLabelText("Search items")).toBeNull();
    expect(screen.getByRole("button", { name: /filters/i })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    expect(screen.getByLabelText("Search items")).toBeDefined();
    // The duplicate category <select> is gone — chips are the only category
    // filter entry point (worklist §4.2).
    expect(screen.queryByLabelText("Filter by category")).toBeNull();
    // Opening filters does not fire an extra items request beyond the initial one.
    expect(listRequests(fetchMock).length).toBe(1);
  });

  it("differentiates empty inventory from no matches", async () => {
    setupFetch();
    renderPage("/assets?q=nothing");

    expect(await screen.findByText(/no matching items/i)).toBeDefined();

    cleanup();
    setupFetch();
    renderPage("/assets");
    expect(await screen.findByText(/your inventory is empty/i)).toBeDefined();
  });

  it("renders colored category badges and a segmented stripe on cards", async () => {
    const bareItem = makeItem({ id: "item-2", name: "Bare cable" });
    setupFetch({ items: [stripedItem, bareItem] });
    renderPage();

    expect(await screen.findByText("Desk lamp")).toBeDefined();
    const cards = document.querySelectorAll("li.inv-card");
    expect(cards.length).toBe(2);
    const [striped, bare] = cards as unknown as HTMLElement[];

    // Stripe: one equal segment per category, accent via data-accent; a null
    // color segment renders no attribute and falls back to CSS.
    const segs = striped.querySelectorAll(".inv-card__stripe-seg");
    expect(segs.length).toBe(3);
    expect(segs[0]).toHaveAttribute("data-accent", "mint");
    expect(segs[1]).not.toHaveAttribute("data-accent");
    expect(segs[2]).toHaveAttribute("data-accent", "coral");

    // Badges carry the category color through PixelBadge's accent prop.
    expect(striped.querySelector('.px-badge[data-accent="mint"]')?.textContent).toBe("Books");
    expect(within(striped).getByText("Tools").closest(".px-badge")).not.toHaveAttribute(
      "data-accent",
    );
    expect(within(striped).getByText("Games").closest(".px-badge")).toHaveAttribute(
      "data-accent",
      "coral",
    );
    // Location badge is untouched.
    expect(within(striped).getByText("shelf-a")).toBeDefined();

    // Zero categories: no stripe element, no category badges.
    expect(bare.querySelector(".inv-card__stripe")).toBeNull();
    expect(bare.querySelectorAll(".px-badge").length).toBe(0);
  });

  it("clamps card badges to three categories with a +N overflow badge", async () => {
    const many = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((name, index) => ({
      id: `cat-${index + 1}`,
      name,
      color: index % 2 === 0 ? "violet" : null,
    }));
    setupFetch({ items: [makeItem({ id: "item-1", name: "Overflowing", categories: many })] });
    renderPage();

    const card = (await screen.findByText("Overflowing")).closest("li.inv-card") as HTMLElement;
    // Stripe keeps every segment; only the badges clamp.
    expect(card.querySelectorAll(".inv-card__stripe-seg").length).toBe(5);
    expect(within(card).getByText("Alpha")).toBeDefined();
    expect(within(card).getByText("Gamma")).toBeDefined();
    expect(within(card).queryByText("Delta")).toBeNull();

    const overflow = within(card).getByText("+2");
    expect(overflow.closest(".px-badge")).not.toHaveAttribute("data-accent");
    expect(overflow.closest(".px-badge")).toHaveAttribute("title", "Delta, Epsilon");
  });

  it("reads chip counts from the response counts block", async () => {
    const fetchMock = setupFetch({
      items: [stripedItem],
      counts: { all: 5, categories: { "cat-1": 2, "cat-2": 3, "cat-3": 0 } },
    });
    // Books selected: the faceted response still reports Tools' real count.
    renderPage("/assets?categories=cat-1");

    await waitFor(() => {
      expect(listRequests(fetchMock).at(-1)!).toContain("categories=cat-1");
    });
    const allChip = await screen.findByRole("button", { name: "All categories" });
    expect(allChip.textContent).toContain("5");
    expect(allChip).toHaveAttribute("aria-pressed", "false");

    const booksChip = screen.getByRole("button", { name: "Filter by category Books" });
    expect(booksChip.textContent).toContain("2");
    expect(booksChip).toHaveAttribute("aria-pressed", "true");

    const toolsChip = screen.getByRole("button", { name: "Filter by category Tools" });
    expect(toolsChip.textContent).toContain("3");
  });
});

describe("AssetDetailPage editor", () => {
  const detailItem = makeItem({
    id: "item-1",
    name: "Multitool",
    targetLocation: "drawer",
    categories: [categories[0]!, categories[1]!], // Books (mint) + Tools (null)
  });

  it("refills the editor chip group from the item and omits unchanged categoryIds", async () => {
    const fetchMock = setupFetch({ detail: detailItem });
    renderDetail(detailItem);

    // The deflist Category row shows every assigned category as a badge.
    expect(await screen.findByText("Multitool")).toBeDefined();
    expect(document.querySelectorAll(".asset-detail__categories .px-badge").length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByTestId("item-editor");
    expect(screen.getByRole("button", { name: "Toggle category Books" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Toggle category Tools" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Toggle category Games" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // Unchanged set -> PATCH carries no categoryIds key (absent = keep).
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("/api/apps/assets/items/item-1") && init?.method === "PATCH",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call![1]!.body)) as Record<string, unknown>;
      expect("categoryIds" in body).toBe(false);
    });
  });

  it("submits a replacement categoryIds array when the set changes", async () => {
    const fetchMock = setupFetch({ detail: detailItem });
    renderDetail(detailItem);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByTestId("item-editor");
    fireEvent.click(screen.getByRole("button", { name: "Toggle category Books" })); // off
    fireEvent.click(screen.getByRole("button", { name: "Toggle category Games" })); // on
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("/api/apps/assets/items/item-1") && init?.method === "PATCH",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call![1]!.body)) as Record<string, unknown>;
      expect(body.categoryIds).toEqual(["cat-2", "cat-3"]);
    });
  });
});
