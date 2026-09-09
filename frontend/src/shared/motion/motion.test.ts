import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const animateMock = vi.hoisted(() => vi.fn(() => ({ revert: vi.fn() })));
vi.mock("animejs/waapi", () => ({
  waapi: { animate: animateMock },
}));

import { waapi } from "animejs/waapi";
import { MOTION_DISTANCE, MOTION_DURATION, MOTION_SCALE, MOTION_STAGGER_STEP } from "./motionTokens";
import { PIXEL_EASE } from "./pixelEasings";
import { prefersReducedMotion } from "./reducedMotion";
import { runMotion } from "./runMotion";
import type { MotionScopeHandle } from "./useAnimeScope";
import { pageEnter, listStagger, faceEnter, windowEnter } from "./pixelEntrance";
import { pop, blink, shake, dropSnap, pickUp, resizeSnap, tick } from "./pixelFeedback";

const realMatchMedia = window.matchMedia;

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: matches && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** Element carrying the minimum WAAPI capability runMotion requires. */
function motionElement(): HTMLElement {
  const node = document.createElement("div");
  node.animate = vi.fn() as unknown as typeof node.animate;
  return node;
}

beforeEach(() => {
  animateMock.mockClear();
});

afterEach(() => {
  // Some existing suites rely on matchMedia being absent in jsdom.
  window.matchMedia = realMatchMedia;
});

describe("motion tokens stay in lockstep with tokens.css", () => {
  it("mirrors every --motion-* custom property", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
    const token = (name: string) => {
      const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
      expect(match, `--${name} should exist in tokens.css`).toBeTruthy();
      return match![1].trim();
    };
    expect(token("motion-instant")).toBe(`${MOTION_DURATION.instant}ms`);
    expect(token("motion-fast")).toBe(`${MOTION_DURATION.fast}ms`);
    expect(token("motion-normal")).toBe(`${MOTION_DURATION.normal}ms`);
    expect(token("motion-slow")).toBe(`${MOTION_DURATION.slow}ms`);
    expect(token("motion-stagger")).toBe(`${MOTION_STAGGER_STEP}ms`);
    expect(token("motion-distance-xs")).toBe(`${MOTION_DISTANCE.xs}px`);
    expect(token("motion-distance-sm")).toBe(`${MOTION_DISTANCE.sm}px`);
    expect(token("motion-distance-md")).toBe(`${MOTION_DISTANCE.md}px`);
  });
});

describe("prefersReducedMotion", () => {
  it("defaults to no preference without matchMedia", () => {
    // @ts-expect-error deliberately absent, like several Dashboard test branches
    delete window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("reflects the media query result", () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("runMotion gating", () => {
  it("skips null targets", () => {
    runMotion(null, { opacity: [0, 1] });
    expect(waapi.animate).not.toHaveBeenCalled();
  });

  it("skips under reduced motion and leaves the element untouched", () => {
    stubMatchMedia(true);
    const el = motionElement();
    runMotion(el, { opacity: [0, 1] });
    expect(waapi.animate).not.toHaveBeenCalled();
    expect(el.style.cssText).toBe("");
  });

  it("skips when the Web Animations API is missing (jsdom default)", () => {
    const el = document.createElement("div");
    expect("animate" in el).toBe(false);
    expect(runMotion(el, { opacity: [0, 1] })).toBeNull();
    expect(waapi.animate).not.toHaveBeenCalled();
  });

  it("creates the animation and returns it when supported", () => {
    const el = motionElement();
    const result = runMotion(el, { opacity: [0, 1], duration: MOTION_DURATION.fast });
    expect(waapi.animate).toHaveBeenCalledWith(el, { opacity: [0, 1], duration: MOTION_DURATION.fast });
    expect(result).toBe(animateMock.mock.results[0]?.value);
  });

  it("routes creation through the provided scope", () => {
    const el = motionElement();
    const run = vi.fn((cb: () => unknown) => cb());
    const scope = { run: run as unknown as MotionScopeHandle["run"], revert: vi.fn() };
    runMotion(el, { opacity: [0, 1] }, scope);
    expect(run).toHaveBeenCalled();
    expect(waapi.animate).toHaveBeenCalled();
  });

  it("never throws when the engine rejects the params", () => {
    const el = motionElement();
    animateMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => runMotion(el, { opacity: [0, 1] })).not.toThrow();
  });
});

describe("entrance presets", () => {
  it("pageEnter animates from the offset to the natural state", () => {
    pageEnter(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({
        opacity: [0, 1],
        translateY: [MOTION_DISTANCE.sm, 0],
        duration: MOTION_DURATION.normal,
        ease: PIXEL_EASE.snap3,
      }),
    );
  });

  it("windowEnter starts at the dialog scale", () => {
    windowEnter(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ scale: [MOTION_SCALE.dialog, 1] }),
    );
  });

  it("faceEnter uses the fast entrance scale", () => {
    faceEnter(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ scale: [MOTION_SCALE.entrance, 1], duration: MOTION_DURATION.fast }),
    );
  });

  it("listStagger delays each element by a multiple of the stagger step", () => {
    const nodes = [motionElement(), motionElement(), motionElement()];
    listStagger(nodes);
    expect(waapi.animate).toHaveBeenCalledTimes(3);
    nodes.forEach((_, index) => {
      expect(animateMock).toHaveBeenNthCalledWith(
        index + 1,
        nodes[index],
        expect.objectContaining({ delay: index * MOTION_STAGGER_STEP }),
      );
    });
  });

  it("listStagger tolerates empty and null lists", () => {
    listStagger([]);
    listStagger(null);
    expect(waapi.animate).not.toHaveBeenCalled();
  });
});

describe("feedback presets", () => {
  it("pop pulses the scale and returns to 1", () => {
    pop(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ scale: [1, MOTION_SCALE.pop, 1], duration: MOTION_DURATION.fast }),
    );
  });

  it("blink ends back at full opacity", () => {
    blink(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ opacity: [1, 0.35, 1] }),
    );
  });

  it("shake uses the quantized pixel keyframes and ends at rest", () => {
    shake(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ translateX: [0, -3, 3, -2, 2, 0], duration: MOTION_DURATION.normal }),
    );
  });

  it("dropSnap settles lift → dip → rest", () => {
    dropSnap(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ scale: [MOTION_SCALE.lift, MOTION_SCALE.settle, 1] }),
    );
  });

  it("pickUp, resizeSnap and tick animate only their own property", () => {
    pickUp(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ scale: [1, MOTION_SCALE.lift] }),
    );
    resizeSnap(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ scale: [1, MOTION_SCALE.settle, 1] }),
    );
    tick(motionElement());
    expect(waapi.animate).toHaveBeenLastCalledWith(
      expect.any(Element),
      expect.objectContaining({ translateY: [MOTION_DISTANCE.xs, 0], opacity: [0.4, 1] }),
    );
  });

  it("all presets no-op under reduced motion", () => {
    stubMatchMedia(true);
    const node = motionElement();
    pop(node);
    blink(node);
    shake(node);
    dropSnap(node);
    pickUp(node);
    resizeSnap(node);
    tick(node);
    pageEnter(node);
    listStagger([node]);
    expect(waapi.animate).not.toHaveBeenCalled();
  });
});
