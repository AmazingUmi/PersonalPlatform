import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      // Non-overlapping slots (Phase 11 runtime collision repair would move
      // a stacked card; absolute rendering is asserted with clear slots).
      items: { "alpha:w1": { x: 2, y: 3 }, "beta:w2": { x: 30, y: 7 } },
      hidden: [],
    });
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    expect(cardNode("alpha:w1").style.left).toBe("32px");
    expect(cardNode("alpha:w1").style.top).toBe("48px");
    expect(cardNode("beta:w2").style.left).toBe("480px");
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
    // neighbor never re-packs the canvas. Phase 10: saves carry full w/h.
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      items: { "beta:w2": { x: 21, y: 0, w: 20, h: 16 } },
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
      items: { "beta:w2": { x: 21, y: 0, w: 20, h: 16 } },
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
      items: { "beta:w2": { x: 0, y: 0, w: 20, h: 16 }, "alpha:w1": { x: 21, y: 0, w: 20, h: 16 } },
      hidden: [],
    });
  });

  it("edit mode: Reset Layout re-shows every widget at default placements and persists", async () => {
    vi.mocked(getSetting).mockResolvedValue(["beta:w2"]);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    // Reset asks for confirmation first; the dialog confirm button shares the
    // header label, so scope the query to the dialog.
    fireEvent.click(screen.getByRole("button", { name: /reset layout/i }));
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: /reset layout/i }));

    // Phase 11: reset persists immediately — no Done press needed.
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      items: { "alpha:w1": { x: 0, y: 0, w: 20, h: 16 }, "beta:w2": { x: 21, y: 0, w: 20, h: 16 } },
      hidden: [],
    });

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /edit layout/i })).toBeDefined());
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

  it("drag auto-saves at drop; Done persists the same state; reload restores", async () => {
    const { unmount } = renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    await keyboardDrag(/move alpha widget/i, Array.from({ length: 20 }, () => "ArrowDown"));
    expect(cardNode("alpha:w1").style.top).toBe("320px");

    // Phase 11: a committed drag persists at action end — no Done needed.
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(putSetting).mock.calls[0]![1];
    expect(saved).toEqual({
      version: 2,
      items: { "alpha:w1": { x: 0, y: 20, w: 20, h: 16 }, "beta:w2": { x: 21, y: 0, w: 20, h: 16 } },
      hidden: [],
    });

    // Done afterwards persists the identical state (no stale contradiction).
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(putSetting).mock.calls[1]![1]).toEqual(saved);

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

describe("Dashboard resize (Phase 10, desktop)", () => {
  /**
   * Widget with a declared layout contract: platform constraints (min 12x8,
   * default 20x16) plus density thresholds so context rendering is
   * observable. Renders its received context for assertions.
   */
  const densityModules = {
    gamma: {
      id: "gamma",
      routes: [],
      widgets: [
        {
          id: "w1",
          title: "Gamma Widget",
          render: (context?: {
            layout: { widthUnits: number; heightUnits: number; density: string };
          }) => {
            const layout = context?.layout;
            return (
              <p>{`gamma:${layout?.density ?? "none"}:${layout?.widthUnits ?? 0}x${layout?.heightUnits ?? 0}`}</p>
            );
          },
          layout: {
            density: { normal: { minW: 18, minH: 14 }, expanded: { minW: 26, minH: 20 } },
          },
        },
      ],
    },
  } satisfies Record<string, FrontendAppModule>;

  /** Saved layout where alpha has free space to its right and below. */
  const stackedLayout = {
    version: 2,
    // beta sits BELOW alpha so alpha can grow right/down without colliding.
    items: { "alpha:w1": { x: 0, y: 0, w: 20, h: 16 }, "beta:w2": { x: 0, y: 20, w: 20, h: 16 } },
    hidden: [] as string[],
  };

  const resizeHandle = (label: RegExp) => screen.getByRole("button", { name: label });

  /** Drive a pointer resize on a card's handle by a pixel delta. */
  async function pointerResize(label: RegExp, dx: number, dy: number) {
    const handle = resizeHandle(label);
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: dx, clientY: dy, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
  }

  /** Drive a keyboard resize on a card's handle (arrow codes). */
  function keyboardResize(label: RegExp, codes: string[]) {
    const handle = resizeHandle(label);
    for (const code of codes) fireEvent.keyDown(handle, { code });
  }

  /** Give the jsdom canvas a real width so capacity clamping engages. */
  function stubCanvasWidth(px: number) {
    const canvas = document.querySelector(".dashboard-canvas");
    if (!(canvas instanceof HTMLElement)) throw new Error("canvas not rendered");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: px,
      bottom: 800,
      width: px,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent(window, new Event("resize"));
  }

  beforeEach(() => {
    stubDesktopMedia();
    Object.assign(frontendAppModules, twoAppModules);
  });

  it("shows the resize handle only in edit mode", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    expect(screen.queryByRole("button", { name: /resize alpha widget/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    expect(screen.getByRole("button", { name: /resize alpha widget/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /resize beta widget/i })).toBeDefined();
  });

  it("pointer resize changes only w/h of the resized widget", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // +48px / +32px = +3 / +2 grid units from the 20x16 default.
    await pointerResize(/resize alpha widget/i, 48, 32);

    const alpha = cardNode("alpha:w1");
    expect(alpha.style.width).toBe("368px"); // 23 units
    expect(alpha.style.height).toBe("288px"); // 18 units
    expect(alpha.style.left).toBe("0px"); // x/y anchored
    expect(alpha.style.top).toBe("0px");
    const beta = cardNode("beta:w2");
    expect(beta.style.width).toBe("320px");
    expect(beta.style.height).toBe("256px");
    expect(beta.style.left).toBe("0px");
    expect(beta.style.top).toBe("320px");
  });

  it("keyboard resize grows/shrinks by one grid unit per arrow", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    keyboardResize(/resize alpha widget/i, ["ArrowRight", "ArrowRight", "ArrowDown"]);
    expect(cardNode("alpha:w1").style.width).toBe("352px"); // 22 units
    expect(cardNode("alpha:w1").style.height).toBe("272px"); // 17 units

    keyboardResize(/resize alpha widget/i, ["ArrowLeft", "ArrowUp"]);
    expect(cardNode("alpha:w1").style.width).toBe("336px"); // back to 21
    expect(cardNode("alpha:w1").style.height).toBe("256px"); // back to 16
    // Position never moves.
    expect(cardNode("alpha:w1").style.left).toBe("0px");
    expect(cardNode("alpha:w1").style.top).toBe("0px");
  });

  it("clamps at the minimum size (platform defaults)", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    keyboardResize(/resize alpha widget/i, Array.from({ length: 30 }, () => "ArrowLeft"));
    expect(cardNode("alpha:w1").style.width).toBe("192px"); // min 12 units
    keyboardResize(/resize alpha widget/i, Array.from({ length: 30 }, () => "ArrowUp"));
    expect(cardNode("alpha:w1").style.height).toBe("128px"); // min 8 units
  });

  it("clamps at the canvas right edge", async () => {
    renderDashboard([app("alpha")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    stubCanvasWidth(320); // 20-unit canvas
    keyboardResize(/resize alpha widget/i, Array.from({ length: 30 }, () => "ArrowRight"));
    expect(cardNode("alpha:w1").style.width).toBe("320px"); // clamped to 20 units
  });

  it("rejects a resize into a neighboring widget and keeps the size", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // beta sits at x=21; growing alpha rightwards collides at the 1-unit gap.
    keyboardResize(/resize alpha widget/i, Array.from({ length: 10 }, () => "ArrowRight"));
    expect(cardNode("alpha:w1").style.width).toBe("320px"); // unchanged (20 units)

    // The pointer path flags the invalid candidate live, then reverts.
    const handle = resizeHandle(/resize alpha widget/i);
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 64, clientY: 0, pointerId: 1 }); // +4 units into beta
    expect(cardNode("alpha:w1").className).toContain("dashboard-card--resizing");
    expect(cardNode("alpha:w1").className).toContain("dashboard-card--resize-invalid");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(cardNode("alpha:w1").style.width).toBe("320px"); // reverted
    expect(cardNode("alpha:w1").className).not.toContain("dashboard-card--resizing");
  });

  it("keyboard resize auto-saves per action; Done persists the same state; reload restores", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    const { unmount } = renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    keyboardResize(/resize alpha widget/i, ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown"]);
    expect(cardNode("alpha:w1").style.width).toBe("368px");

    // Phase 11: every valid keyboard action auto-saves (5 arrows = 5 saves).
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(5));
    const last = vi.mocked(putSetting).mock.calls[4]![1];
    expect(last).toEqual({
      version: 2,
      items: {
        "alpha:w1": { x: 0, y: 0, w: 23, h: 18 },
        "beta:w2": { x: 0, y: 20, w: 20, h: 16 },
      },
      hidden: [],
    });

    // Done after an auto-saved resize persists the identical state — never a
    // contradictory stale save.
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(6));
    expect(vi.mocked(putSetting).mock.calls[5]![1]).toEqual(last);

    unmount();
    vi.mocked(getSetting).mockResolvedValue(last);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    expect(cardNode("alpha:w1").style.width).toBe("368px");
    expect(cardNode("alpha:w1").style.height).toBe("288px");
    expect(cardNode("beta:w2").style.width).toBe("320px");
  });

  it("Reset Layout restores default sizes too", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      items: { "alpha:w1": { x: 0, y: 0, w: 30, h: 24 }, "beta:w2": { x: 21, y: 0, w: 20, h: 16 } },
      hidden: [],
    });
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    expect(cardNode("alpha:w1").style.width).toBe("480px");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    fireEvent.click(screen.getByRole("button", { name: /reset layout/i }));
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: /reset layout/i }));
    await waitFor(() => expect(cardNode("alpha:w1").style.width).toBe("320px"));
    expect(cardNode("alpha:w1").style.height).toBe("256px");

    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalled());
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      items: {
        "alpha:w1": { x: 0, y: 0, w: 20, h: 16 },
        "beta:w2": { x: 21, y: 0, w: 20, h: 16 },
      },
      hidden: [],
    });
  });

  it("hidden -> show re-adds the widget with its default size", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      items: { "beta:w2": { x: 0, y: 0, w: 20, h: 16 } },
      hidden: ["alpha:w1"],
    });
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    fireEvent.click(await screen.findByRole("button", { name: /alpha widget/i }));
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalled());
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      items: {
        "beta:w2": { x: 0, y: 0, w: 20, h: 16 },
        "alpha:w1": { x: 21, y: 0, w: 20, h: 16 },
      },
      hidden: [],
    });
  });

  it("resize handle clicks never drag or navigate", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    fireEvent.click(resizeHandle(/resize alpha widget/i));
    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(cardNode("alpha:w1").style.left).toBe("0px");
    expect(cardNode("alpha:w1").style.width).toBe("320px");
  });

  it("density follows the resized size and reaches the widget render context", async () => {
    Object.assign(frontendAppModules, densityModules);
    renderDashboard([app("gamma")]);
    await screen.findByText(/gamma:normal:20x16/);
    expect(cardNode("gamma:w1").getAttribute("data-density")).toBe("normal");

    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    keyboardResize(/resize gamma widget/i, [
      ...Array.from({ length: 6 }, () => "ArrowRight"),
      ...Array.from({ length: 4 }, () => "ArrowDown"),
    ]);
    // 26x20 crosses the expanded threshold — content and attribute switch.
    await screen.findByText(/gamma:expanded:26x20/);
    expect(cardNode("gamma:w1").getAttribute("data-density")).toBe("expanded");

    keyboardResize(/resize gamma widget/i, [
      ...Array.from({ length: 9 }, () => "ArrowLeft"),
      ...Array.from({ length: 8 }, () => "ArrowUp"),
    ]);
    // 17x12 falls below the normal threshold — compact.
    await screen.findByText(/gamma:compact:17x12/);
    expect(cardNode("gamma:w1").getAttribute("data-density")).toBe("compact");
  });

  it("narrow viewports render widgets at normal density with default sizes", async () => {
    // Override the describe-wide desktop stub: this test needs the narrow
    // flow layout (jsdom falls back to it when the query does not match).
    vi.stubGlobal(
      "matchMedia",
      ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia,
    );
    Object.assign(frontendAppModules, densityModules);
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      // A huge desktop size must not leak into the mobile flow.
      items: { "gamma:w1": { x: 0, y: 0, w: 40, h: 30 } },
      hidden: [],
    });
    renderDashboard([app("gamma")]);
    await screen.findByText(/gamma:normal:20x16/);
    expect(cardNode("gamma:w1").getAttribute("data-density")).toBe("normal");
    expect(cardNode("gamma:w1").style.width).toBe("");
    expect(cardNode("gamma:w1").style.height).toBe("");
  });
});

describe("Dashboard layout stabilization (Phase 11, desktop)", () => {
  /** Saved layout where alpha (0,0) has free space right and below. */
  const stackedLayout = {
    version: 2,
    items: { "alpha:w1": { x: 0, y: 0, w: 20, h: 16 }, "beta:w2": { x: 0, y: 20, w: 20, h: 16 } },
    hidden: [] as string[],
  };

  const resizeHandle = (label: RegExp) => screen.getByRole("button", { name: label });

  async function pointerResizeRaw(label: RegExp, dx: number, dy: number, up = true) {
    const handle = resizeHandle(label);
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: dx, clientY: dy, pointerId: 1 });
    if (up) fireEvent.pointerUp(handle, { pointerId: 1 });
  }

  function keyboardResize(label: RegExp, codes: string[]) {
    const handle = resizeHandle(label);
    for (const code of codes) fireEvent.keyDown(handle, { code });
  }

  beforeEach(() => {
    stubDesktopMedia();
    Object.assign(frontendAppModules, twoAppModules);
  });

  it("pointer resize: pointerup auto-saves exactly once; pointermove never saves", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // Several moves during the gesture — none may persist.
    await pointerResizeRaw(/resize alpha widget/i, 16, 16, false);
    fireEvent.pointerMove(resizeHandle(/resize alpha widget/i), { clientX: 32, clientY: 32, pointerId: 1 });
    expect(vi.mocked(putSetting)).not.toHaveBeenCalled();
    fireEvent.pointerUp(resizeHandle(/resize alpha widget/i), { pointerId: 1 });

    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      // +2/+2 grid units from 20x16, x/y anchored, beta untouched.
      items: { "alpha:w1": { x: 0, y: 0, w: 22, h: 18 }, "beta:w2": { x: 0, y: 20, w: 20, h: 16 } },
      hidden: [],
    });
  });

  it("pointer resize released invalid: reverted, nothing saved, others untouched", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // Straight down into beta (y=20): invalid candidate the whole way.
    await pointerResizeRaw(/resize alpha widget/i, 0, 500);
    expect(cardNode("alpha:w1").style.width).toBe("320px");
    expect(cardNode("alpha:w1").style.height).toBe("256px");
    expect(cardNode("beta:w2").style.top).toBe("320px");
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(putSetting)).not.toHaveBeenCalled();
  });

  it("pointer resize without any size change saves nothing", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // A sub-unit wiggle snaps back to the start size.
    await pointerResizeRaw(/resize alpha widget/i, 4, 0);
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(putSetting)).not.toHaveBeenCalled();
  });

  it("keyboard resize: invalid (collision) and clamped no-op presses save nothing", async () => {
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // Default layout: beta sits at x=21 — growing alpha rightwards collides.
    keyboardResize(/resize alpha widget/i, Array.from({ length: 10 }, () => "ArrowRight"));
    expect(cardNode("alpha:w1").style.width).toBe("320px");
    expect(vi.mocked(putSetting)).not.toHaveBeenCalled();

    // Shrinking to the platform minimum (12 units) is valid and saves per
    // action; presses beyond the minimum clamp to a no-op and save nothing.
    keyboardResize(/resize alpha widget/i, Array.from({ length: 8 }, () => "ArrowLeft"));
    await waitFor(() => expect(vi.mocked(putSetting).mock.calls.length).toBe(8));
    expect(cardNode("alpha:w1").style.width).toBe("192px");

    keyboardResize(/resize alpha widget/i, Array.from({ length: 5 }, () => "ArrowLeft"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(cardNode("alpha:w1").style.width).toBe("192px");
    expect(vi.mocked(putSetting).mock.calls.length).toBe(8);
  });

  it("resize save failure keeps the local result and reports the error", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    vi.mocked(putSetting).mockRejectedValueOnce(new Error("disk full"));
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    await pointerResizeRaw(/resize alpha widget/i, 32, 0);

    await waitFor(() => expect(screen.getByText(/Layout save failed: disk full/)).toBeDefined());
    // No rollback: the resized geometry stays visible.
    expect(cardNode("alpha:w1").style.width).toBe("352px");
  });

  it("an overlapping saved V2 layout renders repaired, without saving", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      // Hand-edited stacked cards: identical placements must not render
      // overlapping — the later widget in reading order moves right.
      items: { "alpha:w1": { x: 0, y: 0, w: 20, h: 16 }, "beta:w2": { x: 0, y: 0, w: 20, h: 16 } },
      hidden: [],
    });
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    expect(cardNode("alpha:w1").style.left).toBe("0px");
    expect(cardNode("beta:w2").style.left).toBe("336px"); // 21 units — gap kept
    expect(vi.mocked(putSetting)).not.toHaveBeenCalled();
  });

  it("Reset Layout is available in normal mode and persists immediately", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      items: {
        "alpha:w1": { x: 0, y: 40, w: 30, h: 24 },
        "beta:w2": { x: 42, y: 40, w: 18, h: 12 },
      },
      hidden: [],
    });
    const { unmount } = renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    // Normal mode header: Reset Layout + Edit Layout side by side.
    expect(screen.getByRole("button", { name: /reset layout/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /edit layout/i })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /reset layout/i }));
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: /reset layout/i }));

    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toEqual({
      version: 2,
      items: { "alpha:w1": { x: 0, y: 0, w: 20, h: 16 }, "beta:w2": { x: 21, y: 0, w: 20, h: 16 } },
      hidden: [],
    });
    // The committed state updated: defaults render without entering edit mode.
    await waitFor(() => expect(cardNode("alpha:w1").style.top).toBe("0px"));
    expect(cardNode("alpha:w1").style.width).toBe("320px");

    // Simulated reload: the saved value is served again.
    unmount();
    vi.mocked(getSetting).mockResolvedValue(vi.mocked(putSetting).mock.calls[0]![1]);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    expect(cardNode("alpha:w1").style.top).toBe("0px");
    expect(cardNode("beta:w2").style.left).toBe("336px");
  });

  it("Reset Layout also clears hidden widgets (all available widgets return)", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      version: 2,
      items: { "beta:w2": { x: 0, y: 0, w: 20, h: 16 } },
      hidden: ["alpha:w1"],
    });
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Beta Widget");
    expect(screen.queryByText("Alpha Widget")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /reset layout/i }));
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: /reset layout/i }));

    await waitFor(() => expect(screen.getByText("Alpha Widget")).toBeDefined());
    expect(screen.queryByText(/widget\(s\) hidden/)).toBeNull();
    await waitFor(() => expect(vi.mocked(putSetting)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putSetting).mock.calls[0]![1]).toMatchObject({ hidden: [] });
  });

  it("cancelling the reset confirmation changes nothing", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");

    fireEvent.click(screen.getByRole("button", { name: /reset layout/i }));
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: /cancel/i }));

    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(cardNode("alpha:w1").style.top).toBe("0px");
    expect(cardNode("beta:w2").style.top).toBe("320px");
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(putSetting)).not.toHaveBeenCalled();
  });

  it("an active resize blocks drag (global mutex)", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // Start a pointer resize and keep it live (no pointerup).
    const handle = resizeHandle(/resize alpha widget/i);
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 32, clientY: 32, pointerId: 1 });
    expect(cardNode("alpha:w1").className).toContain("dashboard-card--resizing");

    // A keyboard drag attempt on the same card must not move it.
    await keyboardDrag(/move alpha widget/i, Array.from({ length: 10 }, () => "ArrowDown"));
    expect(cardNode("alpha:w1").style.top).toBe("0px");
    expect(cardNode("beta:w2").style.top).toBe("320px");

    fireEvent.pointerUp(handle, { pointerId: 1 });
  });

  it("an active drag blocks resize (global mutex)", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // Keyboard drag in progress (Space activates, arrows move, no drop).
    fireEvent.keyDown(screen.getByRole("button", { name: /move alpha widget/i }), { code: "Space" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(document, { code: "ArrowDown" });

    // Arrow keys on the resize handle are rejected while the drag is live.
    keyboardResize(/resize alpha widget/i, Array.from({ length: 5 }, () => "ArrowRight"));
    expect(cardNode("alpha:w1").style.width).toBe("320px");

    fireEvent.keyDown(document, { code: "Space" });
  });

  it("resize handle exposes its current size to screen readers", async () => {
    vi.mocked(getSetting).mockResolvedValue(stackedLayout);
    renderDashboard([app("alpha"), app("beta")]);
    await screen.findByText("Alpha Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    const handle = resizeHandle(/resize alpha widget/i);
    expect(handle.getAttribute("aria-label")).toBe("Resize Alpha Widget");
    expect(handle.getAttribute("aria-describedby")).toBe("resize-status-alpha-w1");
    expect(document.getElementById("resize-status-alpha-w1")!.textContent).toBe("20 by 16 grid units");

    keyboardResize(/resize alpha widget/i, ["ArrowRight"]);
    expect(document.getElementById("resize-status-alpha-w1")!.textContent).toBe("21 by 16 grid units");
  });
});
