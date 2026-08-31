import { useEffect, useState } from "react";

/**
 * Ticking "now" for clock faces. Seconds shown → one tick per second;
 * otherwise one tick per minute, aligned to the wall minute boundary so the
 * display never lags a visible fraction behind. Recomputes on visibility so a
 * tab resumed from sleep is immediately correct, and always cleans up its
 * timer on unmount or when the mode changes.
 */
export function useClockNow(withSeconds: boolean): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = (): void => setNow(new Date());
    tick();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const span = withSeconds ? 1_000 : 60_000;
      const delay = Math.max(30, span - (Date.now() % span));
      timer = setTimeout(() => {
        tick();
        schedule();
      }, delay);
    };
    schedule();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [withSeconds]);

  return now;
}
