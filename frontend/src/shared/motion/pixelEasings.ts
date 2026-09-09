/**
 * Quantized pixel easings. Movement snaps between discrete positions instead
 * of interpolating smoothly — the pixel-GUI feedback style (design guide §29).
 * Expressed as native CSS `steps()` timing functions so Anime.js passes them
 * straight through to the Web Animations API; in WAAPI the effect-level easing
 * applies to each keyframe interval, giving hard jumps between positions.
 */

export const PIXEL_EASE = {
  /** Two-position snap — the house style for state changes. */
  snap2: "steps(2, end)",
  /** Three-position snap — entrances with one intermediate frame. */
  snap3: "steps(3, end)",
  /** Four-position snap — settle feedback with two intermediate frames. */
  snap4: "steps(4, end)",
  /** Linear — opacity-only fades and progress fill smoothing. */
  linear: "linear",
} as const;

export type PixelEase = (typeof PIXEL_EASE)[keyof typeof PIXEL_EASE];
