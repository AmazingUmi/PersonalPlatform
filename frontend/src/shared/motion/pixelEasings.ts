/**
 * Quantized pixel easings. Movement snaps between discrete positions instead
 * of interpolating smoothly — the pixel-GUI feedback style (design guide §29).
 * Expressed as native CSS `steps()` timing functions so Anime.js passes them
 * straight through to the Web Animations API.
 *
 * The ladder keeps ONE intermediate frame every 20ms (~50fps) regardless of
 * duration: fast 80ms → 4 steps, normal 140ms → 7 steps, slow 200ms → 10.
 * Animations stay stepped (pixel feel) but dense enough to read as smooth.
 */

export const PIXEL_EASE = {
  /** 80ms / 4 frames — pairs with MOTION_DURATION.fast. */
  snap4: "steps(4, end)",
  /** 140ms / 7 frames — pairs with MOTION_DURATION.normal. */
  snap7: "steps(7, end)",
  /** 200ms / 10 frames — pairs with MOTION_DURATION.slow. */
  snap10: "steps(10, end)",
  /** Linear — opacity-only fades and progress fill smoothing. */
  linear: "linear",
} as const;

export type PixelEase = (typeof PIXEL_EASE)[keyof typeof PIXEL_EASE];
