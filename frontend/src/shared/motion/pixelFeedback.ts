import { MOTION_DISTANCE, MOTION_DURATION, MOTION_SCALE } from "./motionTokens";
import { PIXEL_EASE } from "./pixelEasings";
import { runMotion, type MotionScope, type MotionTarget } from "./runMotion";

/**
 * Interaction feedback presets — short one-shot pulses tied to events (state
 * flips, drops, ticks). They never gate business state and always end at the
 * element's natural state, so skipping them (reduced motion / no WAAPI)
 * changes nothing functionally.
 */

/** Checkbox / badge / icon confirmation pop. */
export function pop(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      scale: [1, MOTION_SCALE.pop, 1],
      duration: MOTION_DURATION.fast,
      ease: PIXEL_EASE.snap4,
    },
    scope,
  );
}

/** Hard accent blink — icon/status flash on enable, save, sync. */
export function blink(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      opacity: [1, 0.35, 1],
      duration: MOTION_DURATION.fast,
      ease: PIXEL_EASE.snap4,
    },
    scope,
  );
}

/** Invalid-action shake (rejected drop / resize). Runs on inner wrappers
 * only — never on nodes whose transform is owned by dnd-kit. */
export function shake(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      translateX: [0, -3, 3, -2, 2, 0],
      duration: MOTION_DURATION.normal,
      ease: PIXEL_EASE.snap7,
    },
    scope,
  );
}

/** Dashboard card picked up: micro lift. */
export function pickUp(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      scale: [1, MOTION_SCALE.lift],
      duration: MOTION_DURATION.fast,
      ease: PIXEL_EASE.snap4,
    },
    scope,
  );
}

/** Valid drop settle: lift → compact dip → rest ("click" of a pixel GUI). */
export function dropSnap(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      scale: [MOTION_SCALE.lift, MOTION_SCALE.settle, 1],
      duration: MOTION_DURATION.normal,
      ease: PIXEL_EASE.snap7,
    },
    scope,
  );
}

/** Resize commit snap — slightly deeper dip than a drop. */
export function resizeSnap(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      scale: [1, MOTION_SCALE.settle, 1],
      duration: MOTION_DURATION.fast,
      ease: PIXEL_EASE.snap4,
    },
    scope,
  );
}

/** Short vertical tick for changing digits (clock). Runs per value change. */
export function tick(target: MotionTarget, scope?: MotionScope): void {
  runMotion(
    target,
    {
      translateY: [MOTION_DISTANCE.xs, 0],
      opacity: [0.4, 1],
      duration: MOTION_DURATION.fast,
      ease: PIXEL_EASE.snap4,
    },
    scope,
  );
}
