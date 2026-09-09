import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Absent-safe reduced-motion probe. Environments without matchMedia (jsdom
 * without a stub — several existing Dashboard test branches run that way
 * deliberately) report "no preference" instead of throwing. The CSS side is
 * covered separately by the global kill-switch in base.css; this guards every
 * JS-driven animation.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(QUERY);
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", callback);
    return () => mql.removeEventListener("change", callback);
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(callback);
    return () => mql.removeListener(callback);
  }
  return () => {};
}

/** Reactive variant for components that render motion-dependent UI. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
