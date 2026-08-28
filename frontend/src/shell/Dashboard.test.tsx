import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

    render(<Dashboard apps={[app("alpha"), app("beta")]} />);
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
    render(<Dashboard apps={[app("alpha", "disabled")]} />);
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
    render(<Dashboard apps={[app("broken"), app("fine")]} />);
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
    render(<Dashboard apps={[app("alpha"), app("beta")]} />);
    await waitFor(() => expect(screen.getByText("Beta Widget")).toBeDefined());
    expect(screen.queryByText("Alpha Widget")).toBeNull();
    expect(screen.getByText(/1 widget\(s\) hidden/)).toBeDefined();
  });
});
