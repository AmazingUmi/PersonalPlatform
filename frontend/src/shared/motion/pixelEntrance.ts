import { MOTION_DISTANCE, MOTION_DURATION, MOTION_SCALE, MOTION_STAGGER_STEP } from "./motionTokens";
import { PIXEL_EASE } from "./pixelEasings";
import { runMotion, type MotionScope, type MotionTarget } from "./runMotion";

/**
 * Entrance presets. All of them animate *from* an offset *to* the element's
 * natural state, so a skipped animation (reduced motion, missing WAAPI) leaves
 * the element exactly as static CSS renders it. Invoke from useLayoutEffect at
 * the call site so the first painted frame already carries the animation.
 */

/** Route-page entrance: fade in and rise `distance-sm`. */
export function pageEnter(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      opacity: [0, 1],
      translateY: [MOTION_DISTANCE.sm, 0],
      duration: MOTION_DURATION.normal,
      ease: PIXEL_EASE.snap3,
    },
    scope,
  );
}

/** Container-level entrance with a light settle (shell panels, windows). */
export function windowEnter(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      opacity: [0, 1],
      translateY: [MOTION_DISTANCE.xs, 0],
      scale: [MOTION_SCALE.dialog, 1],
      duration: MOTION_DURATION.normal,
      ease: PIXEL_EASE.snap3,
    },
    scope,
  );
}

/** Widget / clock-face swap entrance — keeps the occupied box stable. */
export function faceEnter(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      opacity: [0, 1],
      scale: [MOTION_SCALE.entrance, 1],
      duration: MOTION_DURATION.fast,
      ease: PIXEL_EASE.snap2,
    },
    scope,
  );
}

export interface ListStaggerOptions {
  /** Override the per-element step (defaults to MOTION_STAGGER_STEP). */
  step?: number;
  /** Override the rise distance in px (defaults to MOTION_DISTANCE.sm). */
  distance?: number;
}

/**
 * Staggered entrance for a node list. Each element gets `index * step` delay;
 * delays are laid out up-front so a container of N items finishes within
 * `normal + N * step` ms. Elements missing WAAPI are simply skipped.
 */
export function listStagger(
  targets: ArrayLike<Element> | null | undefined,
  scope?: MotionScope,
  options?: ListStaggerOptions,
): void {
  if (!targets || targets.length === 0) return;
  const step = options?.step ?? MOTION_STAGGER_STEP;
  const distance = options?.distance ?? MOTION_DISTANCE.sm;
  for (let index = 0; index < targets.length; index += 1) {
    runMotion(
      targets[index],
      {
        opacity: [0, 1],
        translateY: [distance, 0],
        scale: [MOTION_SCALE.entrance, 1],
        duration: MOTION_DURATION.normal,
        delay: index * step,
        ease: PIXEL_EASE.snap3,
      },
      scope,
    );
  }
}
