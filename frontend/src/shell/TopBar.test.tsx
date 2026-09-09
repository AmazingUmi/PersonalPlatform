import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppInfo } from "../shared/api";
import { AppStatusProvider } from "./AppStatusContext";
import { formatWallClock, TopBar } from "./TopBar";

/**
 * OS status bar (FE polish worklist): wall clock, live status chips from
 * the app-status providers, and the apps-active badge — real values only.
 */

const CAPS = { database: false, storage: false, scheduler: false, events: false };

const APPS: AppInfo[] = [
  { id: "tasks", name: "Tasks", route: "/tasks", version: "1.0.0", status: "enabled", enabled: true, defaultEnabled: true, description: "", capabilities: CAPS, widgets: [], hasBackend: true, hasFrontend: true },
  { id: "notes", name: "Notes", route: "/notes", version: "1.0.0", status: "enabled", enabled: true, defaultEnabled: true, description: "", capabilities: CAPS, widgets: [], hasBackend: true, hasFrontend: true },
  { id: "clock", name: "Clock", route: "/clock", version: "1.0.0", status: "disabled", enabled: false, defaultEnabled: true, description: "", capabilities: CAPS, widgets: [], hasBackend: true, hasFrontend: true },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 9, 22, 34, 12));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatWallClock", () => {
  it("formats 24h zero-padded", () => {
    expect(formatWallClock(new Date(2026, 8, 9, 22, 34))).toBe("22:34");
    expect(formatWallClock(new Date(2026, 8, 9, 0, 5))).toBe("00:05");
  });
});

describe("TopBar", () => {
  it("shows the page title, minute clock and apps-active count", () => {
    render(
      <MemoryRouter>
        <TopBar apps={APPS} />
      </MemoryRouter>,
    );

    expect(screen.getByText("▸ Dashboard")).toBeTruthy();
    expect(screen.getByText("22:34")).toBeTruthy();
    expect(screen.getByText("2 apps active")).toBeTruthy();
  });

  it("renders readable status chips for apps with live status", async () => {
    render(
      <MemoryRouter>
        <AppStatusProvider
          modules={[
            {
              id: "tasks",
              routes: [],
              status: {
                load: async () => [{ id: "today", label: "4", tone: "info", title: "4 tasks due today" }],
              },
            },
          ]}
        >
          <TopBar apps={APPS} />
        </AppStatusProvider>
      </MemoryRouter>,
    );
    await act(async () => {});

    const chip = screen.getByText("TASKS 4");
    expect(chip.getAttribute("title")).toBe("4 tasks due today");
    expect(chip.className).toContain("topbar__status-chip");
  });

  it("renders no chips when no provider reports status", () => {
    render(
      <MemoryRouter>
        <TopBar apps={APPS} />
      </MemoryRouter>,
    );

    expect(document.querySelectorAll(".topbar__status-chip")).toHaveLength(0);
  });
});
