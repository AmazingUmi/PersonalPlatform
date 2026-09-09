import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppInfo } from "../shared/api";
import { AppCenter } from "./AppCenter";

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

import { listStagger } from "../shared/motion/pixelEntrance";
import { blink, pop } from "../shared/motion/pixelFeedback";

function app(id: string, enabled = true): AppInfo {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "",
    status: enabled ? "enabled" : "disabled",
    enabled,
    defaultEnabled: true,
    route: `/${id}`,
    capabilities: { database: false, storage: false, scheduler: false, events: false },
    widgets: [],
    hasBackend: true,
    hasFrontend: true,
  };
}

const iconOf = (id: string): HTMLElement => {
  const node = document.querySelector(`.app-card[data-app="${id}"] .app-card__icon`);
  if (!(node instanceof HTMLElement)) throw new Error(`icon for ${id} not rendered`);
  return node;
};

const badgeOf = (id: string): HTMLElement => {
  const node = document.querySelector(`.app-card[data-app="${id}"] .app-card__foot .px-badge`);
  if (!(node instanceof HTMLElement)) throw new Error(`badge for ${id} not rendered`);
  return node;
};

beforeEach(() => {
  vi.mocked(listStagger).mockClear();
  vi.mocked(blink).mockClear();
  vi.mocked(pop).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("app center motion wiring", () => {
  it("plays the grid stagger exactly once when apps first arrive, never on re-renders", async () => {
    const view = render(<AppCenter apps={[]} onChanged={() => undefined} />);
    expect(listStagger).not.toHaveBeenCalled();

    view.rerender(<AppCenter apps={[app("alpha"), app("beta")]} onChanged={() => undefined} />);
    await waitFor(() => {
      expect(document.querySelectorAll(".app-card")).toHaveLength(2);
    });
    expect(listStagger).toHaveBeenCalledTimes(1);
    const targets = vi.mocked(listStagger).mock.calls[0]![0] as NodeListOf<Element>;
    expect(targets).toHaveLength(2);

    // A later re-render (refresh, presentation change) must not replay it.
    view.rerender(
      <AppCenter
        apps={[app("alpha"), app("beta")]}
        presentation={{ alpha: { displayName: "Renamed" } }}
        onChanged={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText("Renamed")).toBeTruthy());
    expect(listStagger).toHaveBeenCalledTimes(1);
  });

  it("an enabled flip pulses only that app's icon and badge; nothing pulses on initial mount", async () => {
    const view = render(<AppCenter apps={[app("alpha"), app("beta")]} onChanged={() => undefined} />);
    await waitFor(() => {
      expect(document.querySelectorAll(".app-card")).toHaveLength(2);
    });
    expect(blink).not.toHaveBeenCalled();
    expect(pop).not.toHaveBeenCalled();

    view.rerender(<AppCenter apps={[app("alpha", false), app("beta")]} onChanged={() => undefined} />);
    await waitFor(() => expect(blink).toHaveBeenCalledTimes(1));
    expect(pop).toHaveBeenCalledTimes(1);
    // Reference identity (icons serialize identically across cards): exactly
    // alpha's nodes were pulsed, beta's were never passed to a preset.
    expect(vi.mocked(blink).mock.calls[0]![0]).toBe(iconOf("alpha"));
    expect(vi.mocked(pop).mock.calls[0]![0]).toBe(badgeOf("alpha"));
  });

  it("pulses in both directions: enable→disable and disable→enable", async () => {
    const view = render(<AppCenter apps={[app("alpha")]} onChanged={() => undefined} />);
    await waitFor(() => {
      expect(document.querySelectorAll(".app-card")).toHaveLength(1);
    });

    view.rerender(<AppCenter apps={[app("alpha", false)]} onChanged={() => undefined} />);
    await waitFor(() => expect(blink).toHaveBeenCalledTimes(1));

    view.rerender(<AppCenter apps={[app("alpha")]} onChanged={() => undefined} />);
    await waitFor(() => expect(blink).toHaveBeenCalledTimes(2));
    expect(pop).toHaveBeenCalledTimes(2);
    expect(vi.mocked(blink).mock.calls[1]![0]).toBe(iconOf("alpha"));
    expect(vi.mocked(pop).mock.calls[1]![0]).toBe(badgeOf("alpha"));
  });
});
