import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MobileNav } from "./MobileNav";
import type { AppInfo } from "../shared/api";

const noCapabilities = { database: false, storage: false, scheduler: false, events: false };

const apps: AppInfo[] = [
  {
    id: "tasks",
    name: "Tasks",
    version: "1.0.0",
    description: "Tasks",
    status: "enabled",
    enabled: true,
    defaultEnabled: true,
    route: "/tasks",
    capabilities: noCapabilities,
    widgets: [],
    hasBackend: false,
    hasFrontend: true,
  },
];

const realMatchMedia = window.matchMedia;

function renderMobileNav() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<MobileNav apps={apps} />} />
        <Route path="/other" element={<div>other page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const panel = () => screen.getByRole("dialog", { name: "More apps" });
const moreButton = () => screen.getByRole("button", { name: "More" });
const backdrop = () => screen.getByRole("button", { name: "Close menu" });

/** jsdom runs no CSS animations; dispatch the exit completion by hand.
 * jsdom has no AnimationEvent constructor, so animationName rides as an own
 * property on a plain Event. act() flushes the unmount it triggers. */
function finishExit(node: Element = panel()) {
  act(() => {
    node.dispatchEvent(animationEndEvent("mobile-nav-panel-out"));
  });
}

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

describe("MobileNav launcher panel", () => {
  it("opens the panel from the More button and closes it via animationend", () => {
    renderMobileNav();
    fireEvent.click(moreButton());
    expect(panel()).toBeInTheDocument();

    fireEvent.click(backdrop());
    // Closing phase: still mounted, but marked inert.
    expect(panel()).toHaveClass("mobile-nav__panel--closing");
    expect(backdrop()).toHaveClass("mobile-nav__backdrop--closing");

    finishExit();
    expect(screen.queryByRole("dialog", { name: "More apps" })).not.toBeInTheDocument();
  });

  it("ignores animationend events from other targets and animation names", () => {
    renderMobileNav();
    fireEvent.click(moreButton());
    fireEvent.click(backdrop());
    expect(panel()).toHaveClass("mobile-nav__panel--closing");

    // A child animation bubbling up with a different name must not unmount.
    act(() => {
      panel().firstChild!.dispatchEvent(animationEndEvent("other-animation"));
    });
    expect(panel()).toBeInTheDocument();
    // The panel's own animation with a different name is ignored too.
    finishExitWithName(panel(), "mobile-nav-backdrop-out");
    expect(panel()).toBeInTheDocument();
    finishExit();
    expect(screen.queryByRole("dialog", { name: "More apps" })).not.toBeInTheDocument();
  });

  it("Escape unmounts instantly without waiting for the exit animation", () => {
    renderMobileNav();
    fireEvent.click(moreButton());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "More apps" })).not.toBeInTheDocument();
  });

  it("Escape during the closing phase also finishes immediately", () => {
    renderMobileNav();
    fireEvent.click(moreButton());
    fireEvent.click(backdrop());
    expect(panel()).toHaveClass("mobile-nav__panel--closing");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "More apps" })).not.toBeInTheDocument();
  });

  it("re-opening during the closing phase cancels the pending close", () => {
    renderMobileNav();
    fireEvent.click(moreButton());
    fireEvent.click(backdrop());
    expect(panel()).toHaveClass("mobile-nav__panel--closing");

    fireEvent.click(moreButton());
    expect(panel()).not.toHaveClass("mobile-nav__panel--closing");

    // The panel is interactive again: Escape still closes instantly.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "More apps" })).not.toBeInTheDocument();
  });

  it("route changes unmount the panel even mid-close", () => {
    renderMobileNav();
    fireEvent.click(moreButton());
    fireEvent.click(backdrop());
    expect(panel()).toHaveClass("mobile-nav__panel--closing");
    fireEvent.click(screen.getByRole("link", { name: /settings/i }));
    expect(screen.queryByRole("dialog", { name: "More apps" })).not.toBeInTheDocument();
  });

  it("closes without the closing phase under reduced motion", () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })) as unknown as typeof window.matchMedia;
    renderMobileNav();
    fireEvent.click(moreButton());
    fireEvent.click(backdrop());
    expect(screen.queryByRole("dialog", { name: "More apps" })).not.toBeInTheDocument();
  });

  it("keeps aria-expanded in sync through the open → closing → unmount cycle", () => {
    renderMobileNav();
    fireEvent.click(moreButton());
    expect(moreButton()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(backdrop());
    // Still visually closing, but semantically already closed.
    expect(moreButton()).toHaveAttribute("aria-expanded", "false");
  });
});

function animationEndEvent(animationName: string): AnimationEvent {
  const event = new Event("animationend", { bubbles: true }) as AnimationEvent;
  (event as AnimationEvent & { animationName: string }).animationName = animationName;
  return event;
}

function finishExitWithName(node: Element, animationName: string) {
  act(() => {
    node.dispatchEvent(animationEndEvent(animationName));
  });
}
