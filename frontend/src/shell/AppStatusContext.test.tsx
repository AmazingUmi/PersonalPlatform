import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStatusChip, FrontendAppModule } from "../shared/appTypes";
import { AppStatusProvider, useAppStatuses } from "./AppStatusContext";

/**
 * Shell app-status feed (FE polish worklist): providers load into a map,
 * failures hide an app's chips instead of erroring, route changes refresh,
 * subscribe pushes refresh, and the hook works without any provider mounted
 * (defensive default for direct-render components/tests).
 */

/** Consumer that dumps the map as text rows: "appId:chipLabel...". */
function StatusDump() {
  const statuses = useAppStatuses();
  return (
    <div>
      {[...statuses.entries()].map(([appId, chips]) => (
        <p key={appId} data-testid={`status-${appId}`}>
          {appId}:{chips.map((chip) => chip.label).join(",")}
        </p>
      ))}
      <Link to="/other">go</Link>
    </div>
  );
}

function makeModule(id: string, status: FrontendAppModule["status"]): FrontendAppModule {
  return { id, routes: [], status };
}

function renderAt(path: string, modules: FrontendAppModule[]) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppStatusProvider modules={modules}>
        <Routes>
          <Route path="/" element={<StatusDump />} />
          <Route path="/other" element={<StatusDump />} />
        </Routes>
      </AppStatusProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AppStatusProvider", () => {
  it("loads every provider's chips; zero chips mean no entry", async () => {
    renderAt("/", [
      makeModule("tasks", { load: async () => [{ id: "today", label: "4", tone: "info" }] }),
      makeModule("notes", { load: async () => [] }),
    ]);
    await act(async () => {});

    expect(screen.getByTestId("status-tasks").textContent).toBe("tasks:4");
    expect(screen.queryByTestId("status-notes")).toBeNull();
  });

  it("hides an app's chips when its provider fails (e.g. disabled app 404)", async () => {
    const load = vi.fn(async () => {
      throw new Error("boom");
    });
    renderAt("/", [makeModule("tasks", { load })]);
    await act(async () => {});

    expect(load).toHaveBeenCalled();
    expect(screen.queryByTestId("status-tasks")).toBeNull();
  });

  it("refreshes on route change", async () => {
    let chips: AppStatusChip[] = [{ id: "today", label: "1", tone: "info" }];
    const load = vi.fn(async () => chips);
    renderAt("/", [makeModule("tasks", { load })]);
    await act(async () => {});
    expect(screen.getByTestId("status-tasks").textContent).toBe("tasks:1");

    chips = [{ id: "today", label: "7", tone: "info" }];
    await act(async () => {
      fireEvent.click(screen.getByText("go"));
    });
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("status-tasks").textContent).toBe("tasks:7");
  });

  it("re-reads load() when a provider subscribe fires", async () => {
    let running = false;
    const load = vi.fn(async () =>
      running ? [{ id: "running", label: "●", tone: "success" as const }] : [],
    );
    let push: (() => void) | undefined;
    renderAt("/", [
      makeModule("focus", {
        load,
        subscribe: (onChange) => {
          push = onChange;
          return () => {};
        },
      }),
    ]);
    await act(async () => {});
    expect(screen.queryByTestId("status-focus")).toBeNull();

    running = true;
    await act(async () => {
      push!();
    });
    expect(load.mock.calls.length).toBe(2);
    expect(screen.getByTestId("status-focus").textContent).toBe("focus:●");
  });

  it("subscribes once per provider and unsubscribes on unmount", async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const { unmount } = renderAt("/", [makeModule("focus", { load: async () => [], subscribe })]);
    await act(async () => {});
    expect(subscribe).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps the hook usable without any provider (default empty map)", () => {
    render(
      <MemoryRouter>
        <StatusDump />
      </MemoryRouter>,
    );
    expect(document.querySelectorAll("[data-testid^='status-']")).toHaveLength(0);
  });
});
