/**
 * Central JS motion tokens — the single source of truth for every Anime.js
 * duration / distance / scale used in the app. Values are kept in lockstep
 * with the `--motion-*` custom properties in src/styles/tokens.css (enforced
 * by motionTokens.test.ts). Call sites must reference these tokens instead of
 * local magic numbers. See doc/FRONTEND_MOTION_SYSTEM.md.
 */

export const MOTION_DURATION = {
  instant: 0,
  fast: 80,
  normal: 140,
  slow: 200,
} as const;

/** Per-element delay step for staggered entrances (low tens of ms). */
export const MOTION_STAGGER_STEP = 35;

/** Movement magnitudes in px — deliberately small, pixel-quantized feel. */
export const MOTION_DISTANCE = {
  xs: 2,
  sm: 4,
  md: 8,
} as const;

export const MOTION_SCALE = {
  /** Micro pop for checkbox / badge / icon feedback. */
  pop: 1.04,
  /** "Picked up" lift for dashboard drags. */
  lift: 1.01,
  /** Post-drop / resize-commit settle dip. */
  settle: 0.985,
  /** Dialog window entrance scale. */
  dialog: 0.96,
  /** Widget / face swap entrance scale. */
  entrance: 0.98,
} as const;
