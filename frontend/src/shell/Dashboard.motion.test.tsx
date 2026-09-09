import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

vi.mock("../shared/motion/pixelEntrance", () => ({
  listStagger: vi.fn(),
}));

vi.mock("../shared/motion/pixelFeedback", () => ({
  pickUp: vi.fn(),
  dropSnap: vi.fn(),
  resizeSnap: vi.fn(),
  shake: vi.fn(),
  pop: vi.fn(),
  blink: vi.fn(),
  tick: vi.fn(),
}));

import { frontendAppModules } from "../generated/apps";
import { listStagger } from "../shared/motion/pixelEntrance";
import { dropSnap, pickUp, resizeSnap, shake } from "../shared/motion/pixelFeedback";

function app(id: string): AppInfo {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "",
    status: "enabled",
    enabled: true,
    defaultEnabled: true,
    route: `/${id}`,
    capabilities: { database: false, storage: false, scheduler: false, events: false },
    widgets: [],
    hasBackend: true,
    hasFrontend: true,
  };
}

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

/** Keyboard-drag a card via its handle: Space starts, arrows move, Space drops. */
async function keyboardDrag(handleLabel: RegExp, arrows: string[]) {
  fireEvent.keyDown(screen.getByRole("button", { name: handleLabel }), { code: "Space" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (const code of arrows) fireEvent.keyDown(document, { code });
  fireEvent.keyDown(document, { code: "Space" });
}

/** Fresh module map per test (render functions cannot be structurally cloned). */
const makeModules = (): Record<string, FrontendAppModule> => ({
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

const innerOf = (key: string): HTMLElement => {
  const node = document.querySelector(`.dashboard-card[data-widget="${key}"] .dashboard-card__inner`);
  if (!(node instanceof HTMLElement)) throw new Error(`inner wrapper for ${key} not rendered`);
  return node;
};

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
  vi.mocked(getSetting).mockResolvedValue(null);
  vi.mocked(putSetting).mockReset();
  vi.mocked(listStagger).mockClear();
  vi.mocked(pickUp).mockClear();
  vi.mocked(dropSnap).mockClear();
  vi.mocked(resizeSnap).mockClear();
  vi.mocked(shake).mockClear();
  for (const key of Object.keys(frontendAppModules)) delete frontendAppModules[key];
  Object.assign(frontendAppModules, makeModules());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard motion wiring", () => {
  it("plays the load stagger exactly once over the card inner wrappers", async () => {
    render(
      <MemoryRouter>
        <Dashboard apps={[app("alpha"), app("beta")]} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelectorAll(".dashboard-card__inner")).toHaveLength(2);
    });
    expect(listStagger).toHaveBeenCalledTimes(1);
    const targets = vi.mocked(listStagger).mock.calls[0][0] as NodeListOf<Element>;
    expect(targets).toHaveLength(2);

    // A later re-render (e.g. save state change) must not replay it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(listStagger).toHaveBeenCalledTimes(1);
  });

  it("keeps dnd-kit as the only writer of the card transform (inner wrapper carries animations)", async () => {
    stubDesktopMedia();
    render(
      <MemoryRouter>
        <Dashboard apps={[app("alpha"), app("beta")]} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector(".dashboard-canvas")).toBeTruthy();
    });

    const card = document.querySelector('.dashboard-card[data-widget="alpha:w1"]') as HTMLElement;
    expect(card.querySelector(":scope > .dashboard-card__inner")).toBeTruthy();
    // No animation inline styles ever land on the card node itself.
    expect(card.style.transform).toBe("");
  });

  it("drag start plays pickUp on the dragged card's inner wrapper only", async () => {
    stubDesktopMedia();
    render(
      <MemoryRouter>
        <Dashboard apps={[app("alpha"), app("beta")]} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector(".dashboard-canvas")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    fireEvent.keyDown(screen.getByRole("button", { name: "Move Alpha Widget" }), { code: "Space" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(pickUp).toHaveBeenCalledTimes(1);
    expect(pickUp).toHaveBeenCalledWith(innerOf("alpha:w1"));

    // Drop where it started (no movement): no drop feedback.
    fireEvent.keyDown(document, { code: "Space" });
    expect(dropSnap).not.toHaveBeenCalled();
    expect(shake).not.toHaveBeenCalled();
  });

  it("a valid moved drop plays dropSnap on the moved card", async () => {
    stubDesktopMedia();
    render(
      <MemoryRouter>
        <Dashboard apps={[app("alpha"), app("beta")]} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector(".dashboard-canvas")).toBeTruthy();
    });
    stubCanvasWidth(1200);
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // Default placements: alpha (0,0) 20x16, beta (21,0) — one unit down is free.
    await keyboardDrag(/Move Alpha Widget/, ["ArrowDown"]);
    expect(dropSnap).toHaveBeenCalledTimes(1);
    expect(dropSnap).toHaveBeenCalledWith(innerOf("alpha:w1"));
    expect(shake).not.toHaveBeenCalled();
  });

  it("an invalid drop (occupied target) plays shake on the dragged card", async () => {
    stubDesktopMedia();
    render(
      <MemoryRouter>
        <Dashboard apps={[app("alpha"), app("beta")]} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector(".dashboard-canvas")).toBeTruthy();
    });
    stubCanvasWidth(1200);
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    // Drag alpha far right: beyond the canvas bounds / into beta's column so
    // the snapped candidate is invalid and the drop reverts with a shake.
    await keyboardDrag(/Move Alpha Widget/, [
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
    ]);
    expect(shake).toHaveBeenCalledWith(innerOf("alpha:w1"));
    expect(dropSnap).not.toHaveBeenCalled();
  });

  it("a committed keyboard resize plays resizeSnap; feedback never touches the resize numbers", async () => {
    stubDesktopMedia();
    render(
      <MemoryRouter>
        <Dashboard apps={[app("alpha"), app("beta")]} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector(".dashboard-canvas")).toBeTruthy();
    });
    stubCanvasWidth(1200);
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));

    const card = document.querySelector('.dashboard-card[data-widget="alpha:w1"]') as HTMLElement;
    const before = { width: card.style.width, height: card.style.height };
    // Grow downward (right is blocked by beta at x=21 on the default layout).
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize Alpha Widget" }), { code: "ArrowDown" });
    await waitFor(() => {
      // The resize itself happened (height grows on the 16px grid)…
      expect(card.style.height).not.toBe(before.height);
    });
    // …and keyboard commits stay quiet: the pulse is reserved for pointer
    // resize endings so held-arrow repeats don't jitter.
    expect(resizeSnap).not.toHaveBeenCalled();
    expect(shake).not.toHaveBeenCalled();
  });
});
