import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClockWidget } from "./ClockWidget";
import type { ClockSettings } from "./useClockSettings";

/**
 * Dashboard widget (worklist PHASE8 §8): renders the settings row from the
 * server, shows focus state from the Tasks public status, persists display
 * mode changes back to the same row, and only ever emits native <button>
 * controls so the Dashboard's isInteractiveTarget guard keeps presses local.
 */

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const DEFAULT_SETTINGS: ClockSettings = {
  displayMode: "digital",
  showSeconds: true,
  showDate: true,
  hourFormat: 24,
};

function stubFetch(
  handler: (url: string, method: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(String(input), init?.method ?? "GET"),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Widget + both initial GETs flushed. */
async function renderLoaded() {
  const utils = render(<ClockWidget />);
  await act(async () => {});
  return utils;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ClockWidget", () => {
  it("renders the digital face from the stored settings", async () => {
    stubFetch((url) => {
      if (url === "/api/apps/clock/settings") return jsonResponse({ ...DEFAULT_SETTINGS, showSeconds: false });
      if (url === "/api/apps/tasks/public/status")
        return jsonResponse({ current: null, next: null, today: { remainingCount: 0 } });
      return jsonResponse(null, false, 404);
    });

    await renderLoaded();

    expect(screen.getByText("CLOCK")).toBeTruthy();
    expect(screen.getByRole("timer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "DIGITAL" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows FOCUS state when the Tasks public status reports a current task", async () => {
    stubFetch((url) => {
      if (url === "/api/apps/clock/settings") return jsonResponse(DEFAULT_SETTINGS);
      if (url === "/api/apps/tasks/public/status")
        return jsonResponse({
          current: { id: "t1", title: "Deep work", startAt: new Date(Date.now() - 90 * 60_000).toISOString() },
          next: null,
          today: { remainingCount: 0 },
        });
      return jsonResponse(null, false, 404);
    });

    const { container } = await renderLoaded();

    expect(screen.getByText("FOCUS")).toBeTruthy();
    expect(screen.queryByText("CLOCK")).toBeNull();
    // 90 minutes elapsed → "01:30".
    expect(container.textContent).toContain("RUNNING · 01:30");
    expect(container.textContent).toContain("Deep work");
  });

  it("stays calm when the Tasks app is disabled (404 → no focus, no error)", async () => {
    stubFetch((url) => {
      if (url === "/api/apps/clock/settings") return jsonResponse(DEFAULT_SETTINGS);
      if (url === "/api/apps/tasks/public/status")
        return jsonResponse({ error: { code: "not_found", message: "no route" } }, false, 404);
      return jsonResponse(null, false, 404);
    });

    await renderLoaded();

    expect(screen.getByText("CLOCK")).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("switching to ANALOG PUTs the merged settings row", async () => {
    const fetchMock = stubFetch((url, method) => {
      if (url === "/api/apps/clock/settings" && method === "PUT") {
        return jsonResponse({ ...DEFAULT_SETTINGS, displayMode: "analog" });
      }
      if (url === "/api/apps/clock/settings") return jsonResponse(DEFAULT_SETTINGS);
      if (url === "/api/apps/tasks/public/status")
        return jsonResponse({ current: null, next: null, today: { remainingCount: 0 } });
      return jsonResponse(null, false, 404);
    });

    await renderLoaded();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ANALOG" }));
    });

    const put = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/apps/clock/settings" && (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({
      ...DEFAULT_SETTINGS,
      displayMode: "analog",
    });
    // The widget immediately renders the analog face after the PUT round-trip.
    expect(document.querySelector(".clock-analog")).not.toBeNull();
  });

  it("emits only native <button> interactive elements — no widget-level navigation", async () => {
    stubFetch((url) =>
      url === "/api/apps/clock/settings"
        ? jsonResponse(DEFAULT_SETTINGS)
        : jsonResponse({ current: null, next: null, today: { remainingCount: 0 } }),
    );
    const { container } = await renderLoaded();

    const interactive = container.querySelectorAll(
      "button, a, input, select, textarea, label, [role='button'], [onclick]",
    );
    expect(interactive.length).toBeGreaterThan(0);
    interactive.forEach((element) => expect(element.tagName).toBe("BUTTON"));
    expect(container.querySelectorAll(":not(button)[role='button']")).toHaveLength(0);
  });
});

describe("ClockWidget density (Phase 10)", () => {
  const statusWith = (current: unknown, next: unknown, remainingCount: number) => ({
    current,
    next,
    today: { remainingCount },
  });

  function stubDensityFetch(status: unknown, settings = DEFAULT_SETTINGS) {
    return stubFetch((url) => {
      if (url === "/api/apps/clock/settings") return jsonResponse(settings);
      if (url === "/api/apps/tasks/public/status") return jsonResponse(status);
      return jsonResponse(null, false, 404);
    });
  }

  it("compact renders only the time — no label row, date or mode toggle", async () => {
    stubDensityFetch(statusWith(null, null, 0));
    const { container } = render(<ClockWidget density="compact" />);
    await act(async () => {});

    expect(screen.getByRole("timer")).toBeTruthy();
    expect(container.querySelector(".clock-digital__top")).toBeNull();
    expect(container.querySelector(".clock-digital__date")).toBeNull();
    expect(screen.queryByRole("button", { name: "DIGITAL" })).toBeNull();
  });

  it("normal renders the full face with the mode toggle", async () => {
    stubDensityFetch(statusWith(null, null, 0));
    render(<ClockWidget density="normal" />);
    await act(async () => {});

    expect(screen.getByText("CLOCK")).toBeTruthy();
    expect(containerHasDate()).toBe(true);
    expect(screen.getByRole("button", { name: "DIGITAL" })).toBeTruthy();
    // The Tasks zone belongs to expanded only.
    expect(screen.queryByText("MORE TASKS TODAY")).toBeNull();
  });

  it("expanded adds the current/next/remaining task zone", async () => {
    stubDensityFetch(
      statusWith(
        { id: "t1", title: "Deep work", startAt: new Date().toISOString() },
        { id: "t2", title: "Review PR", startAt: new Date(Date.now() + 3_600_000).toISOString() },
        2,
      ),
    );
    const { container } = render(<ClockWidget density="expanded" />);
    await act(async () => {});

    expect(container.textContent).toContain("CURRENT");
    expect(container.textContent).toContain("Deep work");
    expect(container.textContent).toContain("NEXT");
    expect(container.textContent).toContain("Review PR");
    // next (1) + remainingCount (2).
    expect(container.textContent).toContain("3 MORE TASKS TODAY");
    // The clock stays the primary visual — the face is still there.
    expect(screen.getByRole("timer")).toBeTruthy();
    // No Alarm / World Clock content leaks into the widget.
    expect(screen.queryByText(/alarm/i)).toBeNull();
  });

  it("expanded hides the task zone when the Tasks app is disabled", async () => {
    // A 404 envelope must surface as status=null, not as a rendered error.
    stubFetch((url) => {
      if (url === "/api/apps/clock/settings") return jsonResponse(DEFAULT_SETTINGS);
      if (url === "/api/apps/tasks/public/status") return jsonResponse(null, false, 404);
      return jsonResponse(null, false, 404);
    });
    const { container } = render(<ClockWidget density="expanded" />);
    await act(async () => {});

    expect(container.textContent).not.toContain("MORE TASKS TODAY");
    expect(screen.getByRole("timer")).toBeTruthy();
  });

  function containerHasDate(): boolean {
    return document.querySelector(".clock-digital__date") !== null;
  }
});
