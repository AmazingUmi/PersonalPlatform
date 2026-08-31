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
