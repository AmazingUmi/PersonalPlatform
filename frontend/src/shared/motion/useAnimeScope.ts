import { useEffect, useRef, type RefObject } from "react";
import { createScope, type Scope } from "animejs/scope";

/** An animation object we can tear down (Anime.js WAAPIAnimation shape). */
interface RevertibleAnimation {
  revert?: () => void;
  cancel?: () => void;
}

export interface MotionScopeHandle {
  /**
   * Runs `cb` inside the Anime.js scope so the animations it creates are
   * tracked and reverted together. Returns the callback's value, or undefined
   * when the handle is disposed or the scope engine is unavailable.
   */
  run<T>(cb: () => T): T | undefined;
  /** Reverts every animation created through this handle. Idempotent. */
  revert(): void;
}

/**
 * React-safe Anime.js scope bound to `root`, following the official React
 * pattern (createScope inside useEffect, scope.revert() in cleanup). StrictMode
 * double-mounts are safe: the first scope is fully reverted before the second
 * one is created, so repeated mount/unmount never accumulates animations.
 *
 * Every JS-driven animation in the app should be created through this handle
 * (or a preset receiving it) so unmount always tears motion down.
 */
export function useAnimeScope(root: RefObject<HTMLElement | null>): RefObject<MotionScopeHandle | null> {
  const handleRef = useRef<MotionScopeHandle | null>(null);

  useEffect(() => {
    const created: RevertibleAnimation[] = [];
    let disposed = false;
    let scope: Scope | null = null;
    try {
      scope = createScope({ root });
    } catch {
      // Engines where scope creation fails (e.g. exotic test DOMs) simply
      // stay static — motion is presentation-only.
      scope = null;
    }

    const handle: MotionScopeHandle = {
      run<T>(cb: () => T): T | undefined {
        if (disposed) return undefined;
        try {
          const result = scope ? scope.execute(cb) : cb();
          const animation = result as RevertibleAnimation | null | undefined;
          if (animation && (typeof animation.revert === "function" || typeof animation.cancel === "function")) {
            created.push(animation);
          }
          return result;
        } catch {
          return undefined;
        }
      },
      revert() {
        if (disposed) return;
        disposed = true;
        try {
          scope?.revert();
        } catch {
          // Cleanup must never throw during unmount.
        }
        for (const animation of created.splice(0)) {
          try {
            if (typeof animation.revert === "function") animation.revert();
            else animation.cancel?.();
          } catch {
            // Best-effort teardown.
          }
        }
      },
    };

    handleRef.current = handle;
    return () => {
      handle.revert();
      handleRef.current = null;
    };
  }, [root]);

  return handleRef;
}
