import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { AppInfo } from "../shared/api";
import { AppStatusProvider } from "./AppStatusContext";
import { AppDock } from "./AppDock";

/**
 * App dock (FE polish worklist): per-app accent variable on the item, live
 * status chips right-aligned and aria-hidden (accessible name stays the app
 * name), and core entries without chrome.
 */

const CAPS = { database: false, storage: false, scheduler: false, events: false };

const APPS: AppInfo[] = [
  { id: "tasks", name: "Tasks", route: "/tasks", version: "1.0.0", status: "enabled", enabled: true, defaultEnabled: true, description: "", capabilities: CAPS, widgets: [], hasBackend: true, hasFrontend: true },
  { id: "notes", name: "Notes", route: "/notes", version: "1.0.0", status: "enabled", enabled: true, defaultEnabled: true, description: "", capabilities: CAPS, widgets: [], hasBackend: true, hasFrontend: true },
];

afterEach(cleanup);

describe("AppDock", () => {
  it("sets the resolved app accent as a CSS variable on each app item", () => {
    render(
      <MemoryRouter>
        <AppDock apps={APPS} />
      </MemoryRouter>,
    );

    const tasks = screen.getByRole("link", { name: "Tasks" });
    expect(tasks.style.getPropertyValue("--app-accent")).toBe("var(--px-mint)");
    const notes = screen.getByRole("link", { name: "Notes" });
    expect(notes.style.getPropertyValue("--app-accent")).toBe("var(--px-info)");
  });

  it("renders live status chips aria-hidden inside the item", async () => {
    render(
      <MemoryRouter>
        <AppStatusProvider
          modules={[
            {
              id: "tasks",
              routes: [],
              status: { load: async () => [{ id: "today", label: "4", tone: "info" }] },
            },
          ]}
        >
          <AppDock apps={APPS} />
        </AppStatusProvider>
      </MemoryRouter>,
    );
    await act(async () => {});

    const row = screen.getByRole("link", { name: "Tasks" });
    const status = row.querySelector(".dock__item-status");
    expect(status).not.toBeNull();
    expect(status!.getAttribute("aria-hidden")).toBe("true");
    expect(status!.textContent).toBe("4");
    // Items without status render no status container.
    expect(screen.getByRole("link", { name: "Notes" }).querySelector(".dock__item-status")).toBeNull();
  });

  it("keeps core entries free of status chrome", () => {
    render(
      <MemoryRouter>
        <AppDock apps={APPS} />
      </MemoryRouter>,
    );

    for (const label of ["Dashboard", "App Center", "Settings"]) {
      const link = screen.getByRole("link", { name: label });
      expect(link.querySelector(".dock__item-status")).toBeNull();
      expect(link.style.getPropertyValue("--app-accent")).toBe("");
    }
  });
});
