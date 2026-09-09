import { waapi } from "animejs/waapi";
import type { WAAPIAnimation } from "animejs/waapi";
import type { MotionScopeHandle } from "./useAnimeScope";
import { prefersReducedMotion } from "./reducedMotion";

/** Anything a preset may animate: an element, or null while refs settle. */
export type MotionTarget = Element | null | undefined;
/** Scope handle from useAnimeScope; presets without a scope still run, they
 * just rely on their own short lifetime for cleanup. */
export type MotionScope = MotionScopeHandle | null | undefined;

export type MotionParams = Parameters<typeof waapi.animate>[1];

/**
 * Single choke point for every JS-driven animation:
 * - skips under `prefers-reduced-motion` (elements are never left in an
 *   offset state — presets always animate *from* an offset *to* the natural
 *   state, so skipping is invisible);
 * - skips where the Web Animations API is missing (jsdom) instead of throwing;
 * - records the created animation on the component's scope when provided, so
 *   unmount reverts it;
 * - never lets an engine error escape into render/event code.
 *
 * Returns the WAAPIAnimation (for optional interruption), or null.
 */
export function runMotion(target: MotionTarget, params: MotionParams, scope: MotionScope = null): WAAPIAnimation | null {
  if (!target) return null;
  if (prefersReducedMotion()) return null;
  if (typeof (target as Element & { animate?: unknown }).animate !== "function") return null;
  const create = () => {
    try {
      // MotionTarget is a broad Element; Anime.js accepts DOM nodes here.
      return waapi.animate(target as Parameters<typeof waapi.animate>[0], params);
    } catch {
      return null;
    }
  };
  if (scope) return scope.run(create) ?? null;
  return create();
}
