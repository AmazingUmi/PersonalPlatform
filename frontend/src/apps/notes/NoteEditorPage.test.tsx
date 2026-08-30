import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteEditorPage } from "./NoteEditorPage";
import type { NoteView, TagView } from "./api";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Marker rendered at /notes — proves Save/Delete navigated back to the list. */
const TIMELINE = "notes timeline marker";

const tagList: TagView[] = [
  { id: "tag-1", name: "work", createdAt: "2026-08-01T00:00:00.000Z" },
  { id: "tag-2", name: "idea", createdAt: "2026-08-01T00:00:00.000Z" },
];

function noteFixture(overrides: Partial<NoteView> = {}): NoteView {
  return {
    id: "note-1",
    title: "Existing title",
    content: "Existing body",
    mood: "good",
    occurredAt: "2026-08-30T01:30:00.000Z",
    pinned: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    tags: [{ id: "tag-1", name: "work" }],
    dayKey: "2026-08-30",
    ...overrides,
  };
}

/** Mirrors the editor's ISO -> datetime-local conversion (browser-local, repo convention). */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setupFetch(existing: NoteView | null = null) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/apps/notes/tags") {
      if (method === "POST") {
        // get-or-create: 201 for a newly created tag (worklist §2.3).
        const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
        return jsonResponse({ id: "tag-9", name: body.name, createdAt: "2026-08-31T00:00:00.000Z" }, true, 201);
      }
      return jsonResponse({ items: tagList });
    }
    if (url === "/api/apps/notes/notes" && method === "POST") {
      return jsonResponse(noteFixture({ id: "note-created" }));
    }
    const noteId = existing?.id ?? "note-1";
    if (url === `/api/apps/notes/notes/${noteId}`) {
      if (method === "DELETE") return jsonResponse({});
      return jsonResponse(existing ?? noteFixture());
    }
    return jsonResponse(null, false, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(
  fetchMock: ReturnType<typeof setupFetch>,
  method: string,
  url: string,
): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    ([calledUrl, init]) =>
      String(calledUrl) === url && (init as RequestInit | undefined)?.method === method,
  );
  expect(call).toBeDefined();
  return JSON.parse(String((call![1] as RequestInit).body));
}

/** /notes/:id must go through real route matching so useParams resolves the id. */
function renderPage(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/notes" element={<div>{TIMELINE}</div>} />
        <Route path="/notes/new" element={<NoteEditorPage />} />
        <Route path="/notes/:id" element={<NoteEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NoteEditorPage", () => {
  it("creates a note sending explicit defaults for untouched fields", async () => {
    const fetchMock = setupFetch();
    renderPage("/notes/new");

    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "Fresh thought" } });
    fireEvent.click(screen.getByRole("button", { name: /create note/i }));

    await waitFor(() => {
      expect(sentBody(fetchMock, "POST", "/api/apps/notes/notes")).toEqual({
        content: "Fresh thought",
        title: null,
        mood: null,
        occurredAt: null,
        pinned: false,
        tagIds: [],
      });
    });
    // A successful save navigates back to the timeline.
    expect(await screen.findByText(TIMELINE)).toBeDefined();
  });

  it("creates a note with every field set", async () => {
    const fetchMock = setupFetch();
    renderPage("/notes/new");

    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Full note" } });
    fireEvent.change(screen.getByLabelText("Occurred at"), { target: { value: "2026-08-30T09:00" } });
    fireEvent.change(screen.getByLabelText("Mood"), { target: { value: "great" } });
    fireEvent.click(await screen.findByRole("button", { name: "Toggle tag work" }));
    fireEvent.click(screen.getByLabelText("Pinned"));
    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "All fields body" } });
    fireEvent.click(screen.getByRole("button", { name: /create note/i }));

    await waitFor(() => {
      expect(sentBody(fetchMock, "POST", "/api/apps/notes/notes")).toEqual({
        content: "All fields body",
        title: "Full note",
        mood: "great",
        // Same datetime-local -> ISO conversion as the implementation, so the
        // assertion holds in any test-runner timezone.
        occurredAt: new Date("2026-08-30T09:00").toISOString(),
        pinned: true,
        tagIds: ["tag-1"],
      });
    });
  });

  it("keeps Create disabled for blank content and never posts", async () => {
    const fetchMock = setupFetch();
    renderPage("/notes/new");

    const create = screen.getByRole("button", { name: /create note/i });
    expect(create).toBeDisabled();

    // Whitespace-only content is still blank (frontend trim guard).
    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "   " } });
    expect(create).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/apps/notes/notes")),
    ).toHaveLength(0);
  });

  it("fills the form from the fetched note and PATCHes only the changed field", async () => {
    const existing = noteFixture();
    const fetchMock = setupFetch(existing);
    renderPage(`/notes/${existing.id}`);

    await screen.findByDisplayValue("Existing title");
    expect(screen.getByLabelText("Note title")).toHaveValue("Existing title");
    expect(screen.getByLabelText("Mood")).toHaveValue("good");
    expect(screen.getByLabelText("Note content")).toHaveValue("Existing body");
    expect(screen.getByLabelText("Occurred at")).toHaveValue(toLocalInputValue(existing.occurredAt));
    expect(screen.getByLabelText("Pinned")).toBeChecked();
    const chip = await screen.findByRole("button", { name: "Toggle tag work" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      // Everything else is unchanged -> absent from the three-state PATCH.
      expect(sentBody(fetchMock, "PATCH", "/api/apps/notes/notes/note-1")).toEqual({ title: "Renamed" });
    });
    expect(await screen.findByText(TIMELINE)).toBeDefined();
  });

  it("PATCHes explicit nulls when fields are cleared", async () => {
    const existing = noteFixture();
    const fetchMock = setupFetch(existing);
    renderPage(`/notes/${existing.id}`);
    await screen.findByDisplayValue("Existing title");

    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Mood"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Occurred at"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Pinned"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(sentBody(fetchMock, "PATCH", "/api/apps/notes/notes/note-1")).toEqual({
        title: null,
        mood: null,
        occurredAt: null,
        pinned: false,
      });
    });
  });

  it("sends the full replacement tagIds set when a tag is added", async () => {
    const existing = noteFixture();
    const fetchMock = setupFetch(existing);
    renderPage(`/notes/${existing.id}`);
    await screen.findByDisplayValue("Existing title");

    const idea = await screen.findByRole("button", { name: "Toggle tag idea" });
    expect(idea.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(idea);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(sentBody(fetchMock, "PATCH", "/api/apps/notes/notes/note-1")).toEqual({
        tagIds: ["tag-1", "tag-2"],
      });
    });
  });

  it("sends an empty tagIds set when every tag is removed", async () => {
    const existing = noteFixture();
    const fetchMock = setupFetch(existing);
    renderPage(`/notes/${existing.id}`);
    await screen.findByDisplayValue("Existing title");

    fireEvent.click(await screen.findByRole("button", { name: "Toggle tag work" }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(sentBody(fetchMock, "PATCH", "/api/apps/notes/notes/note-1")).toEqual({ tagIds: [] });
    });
  });

  it("omits tagIds entirely when the tag selection is unchanged", async () => {
    const existing = noteFixture();
    const fetchMock = setupFetch(existing);
    renderPage(`/notes/${existing.id}`);
    await screen.findByDisplayValue("Existing title");

    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "Edited body" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      // Exact equality proves the unchanged tag set never reaches the wire.
      expect(sentBody(fetchMock, "PATCH", "/api/apps/notes/notes/note-1")).toEqual({
        content: "Edited body",
      });
    });
  });

  it("creates a tag from Enter and selects it for the note", async () => {
    const fetchMock = setupFetch();
    renderPage("/notes/new");

    const input = await screen.findByLabelText("New tag name");
    fireEvent.change(input, { target: { value: "urgent" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(sentBody(fetchMock, "POST", "/api/apps/notes/tags")).toEqual({ name: "urgent" });
    });
    const chip = await screen.findByRole("button", { name: "Toggle tag urgent" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // Enter must create the tag without submitting the note itself.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/apps/notes/notes")),
    ).toBe(false);
  });

  it("deletes the note after confirming the dialog", async () => {
    const existing = noteFixture();
    const fetchMock = setupFetch(existing);
    renderPage(`/notes/${existing.id}`);
    await screen.findByDisplayValue("Existing title");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(screen.getByText(/delete this note\? this cannot be undone\./i)).toBeDefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/apps/notes/notes/note-1" &&
          (init as RequestInit | undefined)?.method === "DELETE",
      );
      expect(call).toBeDefined();
    });
    expect(await screen.findByText(TIMELINE)).toBeDefined();
  });
});
