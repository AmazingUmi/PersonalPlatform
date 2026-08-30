import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesPage } from "./NotesPage";
import type { NoteListResponse, NoteView } from "./api";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function note(overrides: Partial<NoteView> = {}): NoteView {
  return {
    id: "note-1",
    title: "Untitled",
    content: "Body text",
    mood: null,
    occurredAt: "2026-08-30T09:00:00.000Z",
    pinned: false,
    createdAt: "2026-08-30T09:05:00.000Z",
    updatedAt: "2026-08-30T09:05:00.000Z",
    tags: [],
    dayKey: "2026-08-30",
    ...overrides,
  };
}

function listResponse(
  items: NoteView[],
  overrides: Partial<NoteListResponse> = {},
): NoteListResponse {
  // dayKey group labels are driven by the server-computed keys, so the
  // frontend never derives "today" itself (worklist §2.1).
  return { items, total: items.length, todayKey: "2026-08-30", yesterdayKey: "2026-08-29", ...overrides };
}

const tagItems = [
  { id: "tag-1", name: "work", createdAt: "2026-08-01T00:00:00.000Z" },
  { id: "tag-2", name: "idea", createdAt: "2026-08-01T00:00:00.000Z" },
];

function setupFetch(list: NoteListResponse = listResponse([]), tags = tagItems) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("/api/apps/notes/tags")) return jsonResponse({ items: tags });
    if (url.includes("/api/apps/notes/notes")) return jsonResponse(list);
    return jsonResponse(null, false, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** URL of the most recent GET /notes request. */
function lastNotesUrl(fetchMock: ReturnType<typeof setupFetch>): string {
  const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/apps/notes/notes"));
  return String(calls.at(-1)![0]);
}

/** Exact param set of the most recent GET /notes request (sort defaults included). */
function expectLastNotesParams(
  fetchMock: ReturnType<typeof setupFetch>,
  expected: Record<string, string>,
): void {
  const [, query] = lastNotesUrl(fetchMock).split("?");
  const actual: Record<string, string> = {};
  new URLSearchParams(query ?? "").forEach((value, key) => {
    actual[key] = value;
  });
  expect(actual).toEqual(expected);
}

function renderPage(initialEntry = "/notes") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <NotesPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotesPage", () => {
  it("groups the timeline by dayKey with Today/Yesterday headings", async () => {
    const olderDay = new Date("2026-08-01T00:00:00").toLocaleDateString();
    setupFetch(
      listResponse([
        note({ id: "n1", title: "Today alpha", content: "First alpha line\nmore", dayKey: "2026-08-30" }),
        note({ id: "n2", title: null, content: "Beta body line\nextra tail", dayKey: "2026-08-30" }),
        note({ id: "n3", title: "Yesterday gamma", dayKey: "2026-08-29" }),
        note({ id: "n4", title: "Older delta", dayKey: "2026-08-01" }),
      ]),
    );
    const { container } = renderPage();

    await screen.findByText("Today alpha");
    const labels = Array.from(container.querySelectorAll(".notes-day__label")).map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Yesterday", olderDay]);
    // Adjacent notes sharing a dayKey collapse into one group.
    expect(screen.getAllByRole("heading", { name: "Today" })).toHaveLength(1);
    // A note without a title falls back to the first content line.
    expect(screen.getByText("Beta body line")).toBeDefined();
  });

  it("renders pinned and mood badges plus tag chips per note", async () => {
    setupFetch(
      listResponse([
        note({
          id: "n1",
          title: "Decorated",
          mood: "great",
          pinned: true,
          tags: [{ id: "tag-1", name: "work" }],
        }),
        note({ id: "n2", title: "Plain" }),
      ]),
    );
    renderPage();

    const decorated = (await screen.findByText("Decorated")).closest("li")!;
    expect(within(decorated).getByText("Great", { selector: ".px-badge" })).toBeDefined();
    expect(within(decorated).getByText("Pinned", { selector: ".px-badge" })).toBeDefined();
    expect(within(decorated).getByText("work", { selector: ".notes-note__tag" })).toBeDefined();

    // No mood and not pinned -> no badge and no chip on that card.
    const plain = screen.getByText("Plain").closest("li")!;
    expect(plain.querySelectorAll(".px-badge")).toHaveLength(0);
    expect(plain.querySelectorAll(".notes-note__tag")).toHaveLength(0);
  });

  it("writes the debounced search into the URL and refetches with q", async () => {
    const fetchMock = setupFetch(listResponse([note()]));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));

    fireEvent.change(screen.getByLabelText("Search notes"), { target: { value: "hello" } });

    // 250ms debounce (tasks precedent) -> URL -> list request. The list always
    // carries the default sort params (sortBy=occurredAt, order=desc).
    await waitFor(
      () =>
        expectLastNotesParams(fetchMock, {
          q: "hello",
          sortBy: "occurredAt",
          order: "desc",
        }),
      { timeout: 3000 },
    );
  });

  it("toggles tag chips into the comma-separated tags param", async () => {
    const fetchMock = setupFetch(listResponse([note()]));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));

    const sortDefaults = { sortBy: "occurredAt", order: "desc" };
    fireEvent.click(await screen.findByRole("button", { name: "Filter by tag work" }));
    await waitFor(() => expectLastNotesParams(fetchMock, { tags: "tag-1", ...sortDefaults }));

    fireEvent.click(screen.getByRole("button", { name: "Filter by tag idea" }));
    await waitFor(() =>
      expectLastNotesParams(fetchMock, { tags: "tag-1,tag-2", ...sortDefaults }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by tag work" }));
    await waitFor(() => expectLastNotesParams(fetchMock, { tags: "tag-2", ...sortDefaults }));
  });

  it("sets mood and pinned params from the filter controls", async () => {
    const fetchMock = setupFetch(listResponse([note()]));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));

    const sortDefaults = { sortBy: "occurredAt", order: "desc" };
    fireEvent.change(screen.getByLabelText("Filter by mood"), { target: { value: "great" } });
    await waitFor(() => expectLastNotesParams(fetchMock, { mood: "great", ...sortDefaults }));

    fireEvent.click(screen.getByLabelText("Pinned only"));
    await waitFor(() =>
      expectLastNotesParams(fetchMock, { mood: "great", pinned: "true", ...sortDefaults }),
    );

    // Unchecking removes the param instead of sending pinned=false.
    fireEvent.click(screen.getByLabelText("Pinned only"));
    await waitFor(() => expectLastNotesParams(fetchMock, { mood: "great", ...sortDefaults }));
  });

  it("differentiates an empty timeline from no matches", async () => {
    setupFetch(listResponse([]));
    renderPage();
    expect(await screen.findByText("No notes yet")).toBeDefined();

    cleanup();
    setupFetch(listResponse([]));
    renderPage("/notes?q=nothing");
    expect(await screen.findByText("No matching notes")).toBeDefined();
  });

  it("shows the loading state while the list is in flight", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/apps/notes/notes")) return new Promise<Response>(() => {});
        return jsonResponse({ items: [] });
      }),
    );
    renderPage();

    expect(screen.getByText("Loading notes…")).toBeDefined();
  });

  it("shows the error state and retries the list", async () => {
    let fail = true;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/apps/notes/notes")) {
        if (fail) {
          return jsonResponse(
            { error: { code: "internal_error", message: "Notes unavailable" } },
            false,
            500,
          );
        }
        return jsonResponse(listResponse([note({ title: "Back after retry" })]));
      }
      return jsonResponse({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Notes unavailable");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Back after retry")).toBeDefined();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/apps/notes/notes")),
    ).toHaveLength(2);
  });

  it("flags a capped result list with the server total", async () => {
    setupFetch(listResponse([note({ id: "n1" }), note({ id: "n2" })], { total: 502 }));
    renderPage();

    expect(await screen.findByText(/Showing first 2 of 502 — refine filters/)).toBeDefined();
  });
});
