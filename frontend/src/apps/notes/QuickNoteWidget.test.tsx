import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickNoteWidget } from "./QuickNoteWidget";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const savedNote = {
  id: "note-9",
  title: null,
  content: "quick thought",
  mood: null,
  occurredAt: "2026-08-31T08:00:00.000Z",
  pinned: false,
  createdAt: "2026-08-31T08:00:00.000Z",
  updatedAt: "2026-08-31T08:00:00.000Z",
  tags: [],
  dayKey: "2026-08-31",
};

/** The widget renders a Link, so it needs a router context. */
function renderWidget() {
  return render(
    <MemoryRouter>
      <QuickNoteWidget />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QuickNoteWidget", () => {
  it("renders the textarea and keeps Save disabled while empty", () => {
    renderWidget();

    expect(screen.getByLabelText("Quick note content")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("posts only { content } and links to the saved note", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input) === "/api/apps/notes/notes" && init?.method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { content: string };
        return jsonResponse({ ...savedNote, content: body.content });
      }
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWidget();

    fireEvent.change(screen.getByLabelText("Quick note content"), {
      target: { value: "quick thought" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      // Exact equality: the body carries only { content } — no title/mood/
      // tagIds/pinned/occurredAt keys (P7A1-09 server-side defaults).
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ content: "quick thought" });
    });

    expect(await screen.findByText("Saved")).toBeDefined();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/notes/note-9");
    // Success clears the draft for the next capture.
    expect(screen.getByLabelText("Quick note content")).toHaveValue("");
  });

  it("disables Save while the request is in flight", async () => {
    let resolveSave!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveSave = resolve;
          }),
      ),
    );
    renderWidget();

    fireEvent.change(screen.getByLabelText("Quick note content"), { target: { value: "slow save" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.queryByText("Saved")).toBeNull();

    await act(async () => {
      resolveSave(jsonResponse(savedNote));
    });

    expect(await screen.findByText("Saved")).toBeDefined();
    expect(screen.getByLabelText("Quick note content")).toHaveValue("");
  });

  it("shows the error and retries the save on the next click", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { error: { code: "internal_error", message: "Save failed" } },
          false,
          500,
        );
      }
      return jsonResponse(savedNote);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWidget();

    fireEvent.change(screen.getByLabelText("Quick note content"), { target: { value: "retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    // The draft is kept so the same content can be retried.
    expect(screen.getByLabelText("Quick note content")).toHaveValue("retry me");
    const retry = screen.getByRole("button", { name: "Save" });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    expect(await screen.findByText("Saved")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("QuickNoteWidget density (Phase 10)", () => {
  const recentNotes = Array.from({ length: 4 }, (_, i) => ({
    ...savedNote,
    id: `note-${i}`,
    content: `recent entry ${i}`,
    dayKey: `2026-09-0${i + 1}`,
  }));

  function renderWidget(density: "compact" | "normal" | "expanded") {
    return render(
      <MemoryRouter>
        <QuickNoteWidget density={density} />
      </MemoryRouter>,
    );
  }

  function setupRecentFetch() {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/apps/notes/notes" && init?.method === "POST") {
        return jsonResponse({ ...savedNote, content: "quick thought" });
      }
      if (url.startsWith("/api/apps/notes/notes")) return jsonResponse({ items: recentNotes, total: 4, todayKey: "2026-09-01", yesterdayKey: "2026-08-31" });
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("compact shrinks the input and skips the recent list", async () => {
    const calls = setupRecentFetch();
    renderWidget("compact");
    await act(async () => {});

    expect(screen.getByLabelText("Quick note content")).toHaveAttribute("rows", "2");
    expect(screen.queryByText(/recent entry/)).toBeNull();
    expect(calls.filter((url) => url.startsWith("/api/apps/notes/notes") && !url.includes("POST"))).toHaveLength(0);
  });

  it("normal keeps the default input and hides recent entries", async () => {
    setupRecentFetch();
    renderWidget("normal");
    await act(async () => {});

    expect(screen.getByLabelText("Quick note content")).toHaveAttribute("rows", "3");
    expect(screen.queryByText(/recent entry/)).toBeNull();
  });

  it("expanded lists up to three recent entries with their day keys", async () => {
    setupRecentFetch();
    renderWidget("expanded");

    expect(await screen.findByText("recent entry 0")).toBeDefined();
    expect(screen.getByText("recent entry 1")).toBeDefined();
    expect(screen.getByText("recent entry 2")).toBeDefined();
    expect(screen.queryByText("recent entry 3")).toBeNull();
    expect(screen.getByText("2026-09-01")).toBeDefined();
    expect(screen.getByLabelText("Quick note content")).toHaveAttribute("rows", "3");
  });
});
