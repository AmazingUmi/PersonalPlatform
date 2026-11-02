import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteEditorPage } from "./NoteEditorPage";
import type { NoteView, TagView } from "./api";
import { I18nProvider } from "../../shared/i18n";
import { AuthProvider } from "../../shell/AuthContext";
import { SYNC_DATA_CHANGED } from "../../shared/sync";

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
  index = 0,
): Record<string, unknown> {
  const calls = fetchMock.mock.calls.filter(
    ([calledUrl, init]) =>
      String(calledUrl) === url && (init as RequestInit | undefined)?.method === method,
  );
  const call = calls[index];
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

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const AUTH_USER = { id: "user-1", username: "ada", displayName: null, role: "user" as const };

function emitOwnSync() {
  act(() => {
    window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED, {
      detail: { userId: "user-1", identityId: "replica-1", result: "committed", baseline: false, openConflicts: 0 },
    }));
  });
}

function renderSignedInEditor(id: string) {
  return render(
    <I18nProvider initialLanguage="en">
      <AuthProvider>
        <MemoryRouter initialEntries={[`/notes/${id}`]}>
          <Routes>
            <Route path="/notes/:id" element={<NoteEditorPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("NoteEditorPage sync draft", () => {
  it("applies a clean background fetch as fields and hash together", async () => {
    let current = noteFixture({ title: "Existing title", content: "Existing body", baseHash: HASH_A });
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url === "/api/apps/notes/tags") return jsonResponse({ items: tagList });
      if (url === `/api/apps/notes/notes/${current.id}` && method === "PATCH") {
        return jsonResponse({ ...current, ...(JSON.parse(String(init?.body ?? "{}")) as object) });
      }
      if (url === `/api/apps/notes/notes/${current.id}`) return jsonResponse(current);
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInEditor(current.id);
    await screen.findByDisplayValue("Existing title");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    current = noteFixture({ title: "Server title", content: "Server body", baseHash: HASH_B, updatedAt: "2026-09-01T00:00:00.000Z" });
    emitOwnSync();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Server title"));
    expect(screen.getByLabelText("Note content")).toHaveValue("Server body");
    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "Server body!" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(sentBody(fetchMock, "PATCH", `/api/apps/notes/notes/${current.id}`)).toMatchObject({
        content: "Server body!",
        baseHash: HASH_B,
      });
    });
  });

  it("keeps a draft and the old hash when the user types during a fetch", async () => {
    const original = noteFixture({ title: "Existing title", content: "Existing body", baseHash: HASH_A });
    let current = original;
    let hold: ((value: Response) => void) | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url === "/api/apps/notes/tags") return jsonResponse({ items: tagList });
      if (url === `/api/apps/notes/notes/${original.id}` && method === "PATCH") {
        return jsonResponse(original);
      }
      if (url === `/api/apps/notes/notes/${original.id}` && method === "GET") {
        if (hold) return new Promise<Response>((resolve) => { hold = resolve; });
        return jsonResponse(current);
      }
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInEditor(original.id);
    await screen.findByDisplayValue("Existing title");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    const getsBefore = fetchMock.mock.calls.filter(([url, init]) =>
      String(url) === `/api/apps/notes/notes/${original.id}` && !(init as RequestInit | undefined)?.method,
    ).length;
    hold = () => undefined;
    current = noteFixture({ title: "Server title", content: "Server body", baseHash: HASH_B, updatedAt: "2026-09-01T00:00:00.000Z" });
    emitOwnSync();
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url, init]) =>
        String(url) === `/api/apps/notes/notes/${original.id}` && !(init as RequestInit | undefined)?.method,
      ).length).toBeGreaterThan(getsBefore),
    );
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Kept draft" } });
    act(() => { hold?.(jsonResponse(current) as Response); });
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Kept draft"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(sentBody(fetchMock, "PATCH", `/api/apps/notes/notes/${original.id}`)).toMatchObject({
        title: "Kept draft",
        baseHash: HASH_A,
      });
    });
  });

  it("keeps the draft after a failed discard reload and does not auto-adopt later", async () => {
    let current = noteFixture({ title: "Existing title", content: "Existing body", baseHash: HASH_A });
    let failGet = false;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url === "/api/apps/notes/tags") return jsonResponse({ items: tagList });
      if (url === `/api/apps/notes/notes/${current.id}` && method === "PATCH") return jsonResponse(current);
      if (url === `/api/apps/notes/notes/${current.id}` && (method === "GET" || !init?.method)) {
        if (failGet) return jsonResponse({ error: { message: "offline", code: "unavailable" } }, false, 500);
        return jsonResponse(current);
      }
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInEditor("note-1");
    await screen.findByDisplayValue("Existing title");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Local draft" } });
    emitOwnSync();
    expect(await screen.findByRole("button", { name: "Discard draft and reload" })).toBeTruthy();
    const getsBeforeFail = fetchMock.mock.calls.filter(([url, init]) =>
      String(url) === `/api/apps/notes/notes/${current.id}` && ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
    ).length;
    failGet = true;
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url) === `/api/apps/notes/notes/${current.id}` && ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
    ).length).toBe(getsBeforeFail + 1));
    for (let step = 0; step < 20; step += 1) await Promise.resolve();
    expect(screen.getByLabelText("Note title")).toHaveValue("Local draft");
    failGet = false;
    current = noteFixture({ title: "Remote title", content: "Remote body", baseHash: HASH_B, updatedAt: "2026-09-02T00:00:00.000Z" });
    const gets = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes("/api/apps/notes/notes/note-1") && (!(init as RequestInit | undefined)?.method || (init as RequestInit).method === "GET"),
    ).length;
    emitOwnSync();
    expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes("/api/apps/notes/notes/note-1") && (!(init as RequestInit | undefined)?.method || (init as RequestInit).method === "GET"),
    ).length).toBe(gets);
    expect(screen.getByLabelText("Note title")).toHaveValue("Local draft");
  });

  it("adopts fields and hash on a successful discard reload", async () => {
    let current = noteFixture({ title: "Existing title", content: "Existing body", baseHash: HASH_A });
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url === "/api/apps/notes/tags") return jsonResponse({ items: tagList });
      if (url === `/api/apps/notes/notes/${current.id}` && method === "PATCH") {
        return jsonResponse({ ...current, ...(JSON.parse(String(init?.body ?? "{}")) as object) });
      }
      if (url === `/api/apps/notes/notes/${current.id}`) return jsonResponse(current);
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInEditor(current.id);
    await screen.findByDisplayValue("Existing title");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Local draft" } });
    emitOwnSync();
    current = noteFixture({ title: "Remote title", content: "Remote body", baseHash: HASH_B, updatedAt: "2026-09-02T00:00:00.000Z" });
    fireEvent.click(await screen.findByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Remote title"));
    expect(screen.getByLabelText("Note content")).toHaveValue("Remote body");
    expect(screen.queryByRole("button", { name: "Discard draft and reload" })).toBeNull();
    expect(screen.queryByText("Server data changed. Your unsaved edits are kept.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "Remote body!" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(sentBody(fetchMock, "PATCH", `/api/apps/notes/notes/${current.id}`)).toMatchObject({
        content: "Remote body!",
        baseHash: HASH_B,
      });
    });
  });

  it("keeps the draft and offers reload when save returns 409 sync_stale without an event", async () => {
    let current = noteFixture({ title: "Existing title", content: "Existing body", baseHash: HASH_A });
    let patchConflict = true;
    let failGet = false;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url === "/api/apps/notes/tags") return jsonResponse({ items: tagList });
      if (url === `/api/apps/notes/notes/${current.id}` && method === "PATCH") {
        if (patchConflict) {
          return jsonResponse({ error: { code: "sync_stale", message: "stale" } }, false, 409);
        }
        return jsonResponse({ ...current, ...(JSON.parse(String(init?.body ?? "{}")) as object) });
      }
      if (url === `/api/apps/notes/notes/${current.id}`) {
        if (failGet) return jsonResponse({ error: { message: "offline", code: "unavailable" } }, false, 500);
        return jsonResponse(current);
      }
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInEditor(current.id);
    await screen.findByDisplayValue("Existing title");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Local draft" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByRole("button", { name: "Discard draft and reload" })).toBeTruthy();
    expect(screen.getByLabelText("Note title")).toHaveValue("Local draft");
    const getsBeforeFail = fetchMock.mock.calls.filter(([url, init]) =>
      String(url) === `/api/apps/notes/notes/${current.id}` && ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
    ).length;
    failGet = true;
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url) === `/api/apps/notes/notes/${current.id}` && ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
    ).length).toBe(getsBeforeFail + 1));
    for (let step = 0; step < 20; step += 1) await Promise.resolve();
    expect(screen.getByLabelText("Note title")).toHaveValue("Local draft");
    expect(screen.getByRole("button", { name: "Discard draft and reload" })).toBeTruthy();
    failGet = false;
    patchConflict = false;
    current = noteFixture({ title: "Remote title", content: "Remote body", baseHash: HASH_B, updatedAt: "2026-09-02T00:00:00.000Z" });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Remote title"));
    expect(screen.getByLabelText("Note content")).toHaveValue("Remote body");
    expect(screen.queryByRole("button", { name: "Discard draft and reload" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "Remote body!" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      const patchUrl = `/api/apps/notes/notes/${current.id}`;
      const patches = fetchMock.mock.calls.filter(([url, init]) =>
        String(url) === patchUrl && (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patches).toHaveLength(2);
      expect(sentBody(fetchMock, "PATCH", patchUrl, 0)).toMatchObject({
        title: "Local draft",
        baseHash: HASH_A,
      });
      expect(sentBody(fetchMock, "PATCH", patchUrl, 1)).toMatchObject({
        content: "Remote body!",
        baseHash: HASH_B,
      });
    });
  });
});
