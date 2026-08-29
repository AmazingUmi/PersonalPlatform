import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { getSetting, putSetting, type AppInfo } from "../shared/api";
import type { FrontendAppModule } from "../shared/appTypes";

vi.mock("../shared/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  putSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../generated/apps", () => ({
  frontendAppModules: {} as Record<string, FrontendAppModule>,
}));

import { frontendAppModules } from "../generated/apps";

function app(id: string, status: AppInfo["status"] = "enabled"): AppInfo {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "",
    status,
    enabled: status === "enabled",
    defaultEnabled: true,
    route: `/${id}`,
    capabilities: { database: false, storage: false, scheduler: false, events: false },
    widgets: [],
    hasBackend: true,
    hasFrontend: true,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderDashboard(apps: AppInfo[]) {
  return render(
    <MemoryRouter>
      <LocationProbe />
      <Dashboard apps={apps} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getSetting).mockResolvedValue(null);
  vi.mocked(putSetting).mockReset();
  for (const key of Object.keys(frontendAppModules)) delete frontendAppModules[key];
});

afterEach(() => {
  cleanup();
});

describe("Dashboard widgets", () => {
  it("renders widgets from multiple enabled apps side by side", async () => {
    Object.assign(frontendAppModules, {
      alpha: {
        id: "alpha",
        routes: [],
        widgets: [{ id: "w1", title: "Alpha Widget", render: () => <p>alpha content</p> }],
      },
      beta: {
        id: "beta",
        routes: [],
        widgets: [{ id: "w2", title: "Beta Widget", render: () => <p>beta content</p> }],
      },
    } satisfies Record<string, FrontendAppModule>);

    renderDashboard([app("alpha"), app("beta")]);
    expect(await screen.findByText("Alpha Widget")).toBeDefined();
    expect(screen.getByText("Beta Widget")).toBeDefined();
    expect(screen.getByText("alpha content")).toBeDefined();
    expect(screen.getByText("beta content")).toBeDefined();
  });

  it("drops widgets whose app is disabled", async () => {
    Object.assign(frontendAppModules, {
      alpha: {
        id: "alpha",
        routes: [],
        widgets: [{ id: "w1", title: "Alpha Widget", render: () => <p>alpha</p> }],
      },
    });
    renderDashboard([app("alpha", "disabled")]);
    await waitFor(() => expect(screen.getByText(/No widgets available/)).toBeDefined());
  });

  it("isolates a throwing widget behind its error boundary", async () => {
    const Boom = (): never => {
      throw new Error("widget exploded");
    };
    Object.assign(frontendAppModules, {
      broken: {
        id: "broken",
        routes: [],
        widgets: [{ id: "w1", title: "Broken Widget", render: () => <Boom /> }],
      },
      fine: {
        id: "fine",
        routes: [],
        widgets: [{ id: "w2", title: "Fine Widget", render: () => <p>fine content</p> }],
      },
    });
    renderDashboard([app("broken"), app("fine")]);
    expect(await screen.findByText(/Widget failed to render/)).toBeDefined();
    expect(screen.getByText("Fine Widget")).toBeDefined();
    expect(screen.getByText("fine content")).toBeDefined();
  });

  it("honors the persisted layout from core.settings", async () => {
    Object.assign(frontendAppModules, {
      alpha: {
        id: "alpha",
        routes: [],
        widgets: [{ id: "w1", title: "Alpha Widget", render: () => <p>alpha</p> }],
      },
      beta: {
        id: "beta",
        routes: [],
        widgets: [{ id: "w2", title: "Beta Widget", render: () => <p>beta</p> }],
      },
    });
    vi.mocked(getSetting).mockResolvedValue(["beta:w2"]);
    renderDashboard([app("alpha"), app("beta")]);
    await waitFor(() => expect(screen.getByText("Beta Widget")).toBeDefined());
    expect(screen.queryByText("Alpha Widget")).toBeNull();
    expect(screen.getByText(/1 widget\(s\) hidden/)).toBeDefined();
  });

  it("renders widgets in the persisted order, not module order (FP-5.1)", async () => {
    Object.assign(frontendAppModules, {
      alpha: {
        id: "alpha",
        routes: [],
        widgets: [{ id: "w1", title: "Alpha Widget", render: () => <p>alpha</p> }],
      },
      beta: {
        id: "beta",
        routes: [],
        widgets: [{ id: "w2", title: "Beta Widget", render: () => <p>beta</p> }],
      },
    });
    vi.mocked(getSetting).mockResolvedValue(["beta:w2", "alpha:w1"]);
    renderDashboard([app("alpha"), app("beta")]);

    await waitFor(() => expect(screen.getByText("Beta Widget")).toBeDefined());
    const titles = screen.getAllByText(/Widget/).map((node) => node.textContent);
    expect(titles.indexOf("Beta Widget")).toBeLessThan(titles.indexOf("Alpha Widget"));
  });
});

describe("Dashboard interaction (FP-5.2 / FP-5.3 / FP-5.4)", () => {
  beforeEach(() => {
    Object.assign(frontendAppModules, {
      alpha: {
        id: "alpha",
        routes: [],
        widgets: [{ id: "w1", title: "Alpha Widget", render: () => <p>alpha</p> }],
      },
      beta: {
        id: "beta",
        routes: [],
        widgets: [
          {
            id: "w2",
            title: "Beta Widget",
            href: "/beta/deep-link",
            render: () => <p>beta</p>,
          },
        ],
      },
    } satisfies Record<string, FrontendAppModule>);
  });

  it("navigates to the widget href when a card is clicked", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");

    fireEvent.click(screen.getByRole("button", { name: /open beta widget/i }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/beta/deep-link"));
  });

  it("falls back to the app root route when the widget has no href", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.click(screen.getByRole("button", { name: /open alpha widget/i }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/alpha"));
  });

  it("keyboard activation opens the widget", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.keyDown(screen.getByRole("button", { name: /open alpha widget/i }), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/alpha"));
  });

  it("edit mode: hiding a widget and pressing Done persists the layout", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    fireEvent.click(screen.getByRole("button", { name: /hide alpha widget/i }));

    // The hidden section lists the widget with a Show action.
    expect(screen.getByText(/Alpha Widget/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalled());
    const [key, value] = vi.mocked(putSetting).mock.calls[0]!;
    expect(key).toBe("dashboard.widgets");
    expect(value).toEqual(["beta:w2"]);
  });

  it("edit mode: show hidden re-adds the widget to the draft", async () => {
    vi.mocked(getSetting).mockResolvedValue(["beta:w2"]);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    const showChip = await screen.findByRole("button", { name: /alpha widget/i });
    fireEvent.click(showChip);
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));

    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalled());
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual(["beta:w2", "alpha:w1"]);
  });

  it("edit mode: restore default re-shows every widget", async () => {
    vi.mocked(getSetting).mockResolvedValue(["beta:w2"]);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    fireEvent.click(screen.getByRole("button", { name: /restore default/i }));
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));

    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalled());
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual(["alpha:w1", "beta:w2"]);
  });
});
