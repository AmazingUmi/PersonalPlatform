import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** jsdom has no matchMedia at all — stub the desktop free-layout media query. */
function stubDesktopMedia() {
  vi.stubGlobal(
    "matchMedia",
    ((query: string) => ({
      matches: query.includes("960"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia,
  );
}

const cardNode = (key: string): HTMLElement => {
  const node = document.querySelector(`.dashboard-card[data-widget="${key}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`card ${key} not rendered`);
  return node;
};

/** Keyboard-drag a card via its handle: Space starts, arrows move, Space drops. */
async function keyboardDrag(handleLabel: RegExp, arrows: string[]) {
  fireEvent.keyDown(screen.getByRole("button", { name: handleLabel }), { code: "Space" });
  // KeyboardSensor attaches its document keydown listener in a setTimeout(0).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (const code of arrows) fireEvent.keyDown(document, { code });
  fireEvent.keyDown(document, { code: "Space" });
}

const twoAppModules = {
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
} satisfies Record<string, FrontendAppModule>;

beforeEach(() => {
  vi.mocked(getSetting).mockResolvedValue(null);
  vi.mocked(putSetting).mockReset();
  for (const key of Object.keys(frontendAppModules)) delete frontendAppModules[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("Dashboard widgets", () => {
  it("renders widgets from multiple enabled apps side by side", async () => {
    Object.assign(frontendAppModules, twoAppModules);

    renderDashboard([app("alpha"), app("beta")]);
    expect(await screen.findByText("Alpha Widget")).toBeDefined();
    expect(screen.getByText("Beta Widget")).toBeDefined();
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("beta")).toBeDefined();
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
        widgets: [{ id: "w2", title: "Fine Widget", render: () => <p>fine</p> }],
      },
    });
    renderDashboard([app("broken"), app("fine")]);
    expect(await screen.findByText(/Widget failed to render/)).toBeDefined();
    expect(screen.getByText("Fine Widget")).toBeDefined();
    expect(screen.getByText("fine")).toBeDefined();
  });

  it("honors the persisted V1 layout from core.settings (legacy compat)", async () => {
    Object.assign(frontendAppModules, twoAppModules);
    vi.mocked(getSetting).mockResolvedValue(["beta:w2"]);
    renderDashboard([app("alpha"), app("beta")]);
    await waitFor(() => expect(screen.getByText("Beta Widget")).toBeDefined());
    expect(screen.queryByText("Alpha Widget")).toBeNull();
    expect(screen.getByText(/1 widget\(s\) hidden/)).toBeDefined();
  });

  it("renders widgets in the persisted V1 order, not module order (FP-5.1)", async () => {
    Object.assign(frontendAppModules, twoAppModules);
    vi.mocked(getSetting).mockResolvedValue(["beta:w2", "alpha:w1"]);
    renderDashboard([app("alpha"), app("beta")]);

    await waitFor(() => expect(screen.getByText("Beta Widget")).toBeDefined());
    const titles = screen.getAllByText(/Widget/).map((node) => node.textContent);
    expect(titles.indexOf("Beta Widget")).toBeLessThan(titles.indexOf("Alpha Widget"));
  });

  it("renders saved V2 placements as absolute positions on desktop", async () => {
    stubDesktopMedia();
    Object.assign(frontendAppModules, twoAppModules);
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      items: { "alpha:w1": { x: 2, y: 3 }, "beta:w2": { x: 10, y: 7 } },
      hidden: [],
    });
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    expect(cardNode("alpha:w1").style.left).toBe("32px");
    expect(cardNode("alpha:w1").style.top).toBe("48px");
    expect(cardNode("beta:w2").style.left).toBe("160px");
    expect(cardNode("beta:w2").style.top).toBe("112px");
    expect(document.querySelector(".dashboard-canvas")!.getAttribute("data-desktop")).toBe("true");
  });

  it("narrow viewports keep the normal flow layout (no absolute positioning)", async () => {
    // No matchMedia stub: jsdom reports the narrow fallback mode.
    Object.assign(frontendAppModules, twoAppModules);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    expect(cardNode("alpha:w1").style.left).toBe("");
    expect(cardNode("alpha:w1").style.top).toBe("");
    expect(document.querySelector(".dashboard-canvas")!.getAttribute("data-desktop")).toBeNull();
  });

  it("auto-places a new widget missing from the saved V2 layout without saving", async () => {
    stubDesktopMedia();
    Object.assign(frontendAppModules, twoAppModules);
    // Saved before the beta app shipped its widget: beta is neither placed
    // nor hidden, so it must appear at the first free runtime slot.
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      items: { "alpha:w1": { x: 0, y: 0 } },
      hidden: [],
    });
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");

    // Default 320x256 cards: beta lands one gap right of alpha (21 units).
    expect(cardNode("beta:w2").style.left).toBe("336px");
    expect(cardNode("beta:w2").style.top).toBe("0px");
    expect(vi.mocked(putSetting)).not.toHaveBeenCalled();
  });
});

describe("Dashboard interaction (FP-5.2 / FP-5.3 / FP-5.4)", () => {
  beforeEach(() => {
    Object.assign(frontendAppModules, twoAppModules);
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

  it("Enter on an inner control does not also navigate the card (FP-14.1)", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    // The hide button lives inside the role=button card wrapper. Enter on it
    // must trigger the hide action only — never the card navigation.
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    const hideButton = screen.getByRole("button", { name: /hide alpha widget/i });
    fireEvent.keyDown(hideButton, { key: "Enter" });
    fireEvent.click(hideButton);

    expect(screen.getByTestId("location").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalled());
    // beta keeps the slot it had in the two-card default layout — hiding a
    // neighbor never re-packs the canvas.
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      items: { "beta:w2": { x: 21, y: 0 } },
      hidden: ["alpha:w1"],
    });
  });

  it("Space on an inner control does not navigate the card either", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    fireEvent.keyDown(screen.getByRole("button", { name: /hide alpha widget/i }), { key: " " });
    expect(screen.getByTestId("location").textContent).toBe("/");
  });

  it("edit mode: hiding a widget and pressing Done persists the V2 layout", async () => {
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
    // beta keeps its default slot (21,0): hiding alpha leaves the gap behind.
    expect(value).toEqual({
      version: 2,
      items: { "beta:w2": { x: 21, y: 0 } },
      hidden: ["alpha:w1"],
    });
  });

  it("edit mode: show hidden re-adds the widget at the first free position", async () => {
    vi.mocked(getSetting).mockResolvedValue(["beta:w2"]);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    const showChip = await screen.findByRole("button", { name: /alpha widget/i });
    fireEvent.click(showChip);

    // beta occupies (0,0); alpha is placed one gap to the right (21 units)
    // — verified through the persisted placement below.
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalled());
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      items: { "beta:w2": { x: 0, y: 0 }, "alpha:w1": { x: 21, y: 0 } },
      hidden: [],
    });
  });

  it("edit mode: restore default re-shows every widget at default placements", async () => {
    vi.mocked(getSetting).mockResolvedValue(["beta:w2"]);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    fireEvent.click(screen.getByRole("button", { name: /restore default/i }));
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));

    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalled());
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      items: { "alpha:w1": { x: 0, y: 0 }, "beta:w2": { x: 21, y: 0 } },
      hidden: [],
    });
  });

  it("save failure keeps edit mode open and reports the error", async () => {
    vi.mocked(putSetting).mockRejectedValueOnce(new Error("disk full"));
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));

    await waitFor(() => expect(screen.getByText(/Layout save failed: disk full/)).toBeDefined());
    // Still in edit mode: the Done button is available for a retry.
    expect(screen.getByRole("button", { name: /^done$/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /edit layout/i })).toBeNull();
  });
});

describe("Dashboard Free Layout V2 (desktop)", () => {
  beforeEach(() => {
    stubDesktopMedia();
    Object.assign(frontendAppModules, twoAppModules);
  });

  it("keyboard drag moves only the dragged widget and leaves its old slot empty", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    // Default placements: alpha (0,0), beta (21,0).
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    await keyboardDrag(/move alpha widget/i, Array.from({ length: 25 }, () => "ArrowDown"));

    expect(cardNode("alpha:w1").style.left).toBe("0px");
    expect(cardNode("alpha:w1").style.top).toBe("400px"); // 25 units down
    // beta must not have moved an inch.
    expect(cardNode("beta:w2").style.left).toBe("336px");
    expect(cardNode("beta:w2").style.top).toBe("0px");
  });

  it("rejects a drop onto an occupied slot and reverts the card", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      // Default 320x256 cards: alpha occupies y 0..16, beta starts at y 20.
      items: { "alpha:w1": { x: 0, y: 0 }, "beta:w2": { x: 0, y: 20 } },
      hidden: [],
    });
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    const arrows = Array.from({ length: 20 }, () => "ArrowDown");
    fireEvent.keyDown(screen.getByRole("button", { name: /move alpha widget/i }), { code: "Space" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (const code of arrows) fireEvent.keyDown(document, { code });

    // Mid-drag: invalid preview is flagged on both the card and the ghost.
    await waitFor(() => {
      expect(cardNode("alpha:w1").className).toContain("dashboard-card--drop-invalid");
      expect(document.querySelector(".dashboard-drop-ghost--invalid")).not.toBeNull();
    });

    fireEvent.keyDown(document, { code: "Space" });
    // Drop rejected: alpha is back at its origin, beta untouched.
    expect(cardNode("alpha:w1").style.top).toBe("0px");
    expect(cardNode("beta:w2").style.top).toBe("320px");
    expect(cardNode("alpha:w1").className).not.toContain("dashboard-card--drop-invalid");
    expect(document.querySelector(".dashboard-drop-ghost")).toBeNull();
  });

  it("Done persists dragged positions and a reload restores them exactly", async () => {
    const { unmount } = renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    await keyboardDrag(/move alpha widget/i, Array.from({ length: 20 }, () => "ArrowDown"));
    expect(cardNode("alpha:w1").style.top).toBe("320px");

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(putSetting).mock.calls[0]![1];
    expect(saved).toEqual({
      version: 2,
      items: { "alpha:w1": { x: 0, y: 20 }, "beta:w2": { x: 21, y: 0 } },
      hidden: [],
    });

    // Simulated reload: the saved value is served by core.settings again.
    unmount();
    vi.mocked(getSetting).mockResolvedValue(saved);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    expect(cardNode("alpha:w1").style.top).toBe("320px");
    expect(cardNode("beta:w2").style.left).toBe("336px");
  });

  it("edit mode shows the pixel guide canvas, normal mode hides it", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    const canvas = () => document.querySelector(".dashboard-canvas")!;

    expect(canvas().className).not.toContain("dashboard-canvas--editing");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    expect(canvas().className).toContain("dashboard-canvas--editing");
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(canvas().className).not.toContain("dashboard-canvas--editing"));
  });

  it("keeps the drag handle click from dragging or navigating", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    // Normal mode has no handle at all; edit mode renders it but a plain
    // click must neither navigate nor change any placement.
    expect(screen.queryByRole("button", { name: /move alpha widget/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    fireEvent.click(screen.getByRole("button", { name: /move alpha widget/i }));
    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(cardNode("alpha:w1").style.left).toBe("0px");
  });
});
