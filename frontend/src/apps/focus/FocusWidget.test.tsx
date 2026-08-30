import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FocusWidget } from "./FocusWidget";
import type { ActiveSessionView, FocusState } from "./api";

/**
 * APP-1 F08a: the dashboard widget renders the compact focus card from
 * useFocusState and only ever emits native <button> controls, so the
 * Dashboard card's isInteractiveTarget guard keeps control presses from
 * navigating to the app route.
 */

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function activeSession(overrides: Partial<ActiveSessionView> = {}): ActiveSessionView {
  return {
    id: "s1",
    kind: "focus",
    status: "running",
    plannedDurationSeconds: 1500,
    elapsedSeconds: 900,
    remainingSeconds: 600,
    expectedEndAt: null,
    startedAt: new Date().toISOString(),
    pausedAt: null,
    revision: 1,
    ...overrides,
  };
}

function focusStateFixture(active: ActiveSessionView | null, overrides: Partial<FocusState> = {}): FocusState {
  return {
    now: new Date().toISOString(),
    active,
    today: { focusedSeconds: 0, completedRounds: 0, sessionsEnded: 0 },
    nextKind: "focus",
    settings: {
      focusDurationSeconds: 1500,
      shortBreakDurationSeconds: 300,
      longBreakDurationSeconds: 900,
      longBreakInterval: 4,
    },
    ...overrides,
  };
}

function stubFetch(handler: (url: string, method: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(String(input), init?.method ?? "GET"),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Render + flush the initial GET /state round-trip. */
async function renderLoaded() {
  const utils = render(<FocusWidget />);
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

describe("FocusWidget", () => {
  it("idle: shows READY, the next-kind default 25:00, today summary, and Start", async () => {
    stubFetch((url) =>
      url === "/api/apps/focus/state"
        ? jsonResponse(
            focusStateFixture(null, {
              today: { focusedSeconds: 5400, completedRounds: 2, sessionsEnded: 3 },
            }),
          )
        : jsonResponse(null, false, 404),
    );

    await renderLoaded();

    expect(screen.getByText("READY · Focus")).toBeTruthy();
    expect(screen.getByText("25:00")).toBeTruthy();
    expect(screen.getByText("Focused 1h 30m · 2 rounds")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("running: shows FOCUSING, the derived countdown, Pause and Stop", async () => {
    // expectedEndAt 600.9s out: floor() lands exactly on 600 → "10:00".
    stubFetch((url) =>
      url === "/api/apps/focus/state"
        ? jsonResponse(
            focusStateFixture(
              activeSession({
                expectedEndAt: new Date(Date.now() + 600_900).toISOString(),
                remainingSeconds: 600,
              }),
            ),
          )
        : jsonResponse(null, false, 404),
    );

    await renderLoaded();

    expect(screen.getByText("FOCUSING · Focus")).toBeTruthy();
    expect(screen.getByText("10:00")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("paused: shows PAUSED, the frozen remaining time, Resume and Stop", async () => {
    stubFetch((url) =>
      url === "/api/apps/focus/state"
        ? jsonResponse(
            focusStateFixture(
              activeSession({
                status: "paused",
                expectedEndAt: null,
                pausedAt: new Date().toISOString(),
                remainingSeconds: 583,
              }),
            ),
          )
        : jsonResponse(null, false, 404),
    );

    await renderLoaded();

    expect(screen.getByText("PAUSED · Focus")).toBeTruthy();
    expect(screen.getByText("09:43")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("clicking Pause POSTs to /api/apps/focus/pause", async () => {
    const fetchMock = stubFetch((url, method) => {
      if (url === "/api/apps/focus/state") {
        return jsonResponse(focusStateFixture(activeSession({ expectedEndAt: new Date(Date.now() + 600_900).toISOString() })));
      }
      if (url === "/api/apps/focus/pause" && method === "POST") {
        return jsonResponse({
          state: focusStateFixture(activeSession({ status: "paused", expectedEndAt: null, remainingSeconds: 600 })),
        });
      }
      return jsonResponse(null, false, 404);
    });

    await renderLoaded();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });

    const pauseCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/apps/focus/pause" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(pauseCall).toBeDefined();
  });

  it("emits only native <button> interactive elements — no widget-level navigation", async () => {
    // Same selector list as Dashboard's isInteractiveTarget: every hit must
    // be a real <button>, and no element may fake it with role="button".
    stubFetch((url) =>
      url === "/api/apps/focus/state" ? jsonResponse(focusStateFixture(null)) : jsonResponse(null, false, 404),
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
