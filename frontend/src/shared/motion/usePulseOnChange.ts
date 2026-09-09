import { useEffect, useRef, type RefObject } from "react";
import { pop } from "./pixelFeedback";

/**
 * Pops the referenced element (motion system `pop` preset — quantized
 * scale pulse, skipped under reduced motion / without WAAPI) whenever the
 * watched value changes. For slow-changing numbers (task counters, high
 * scores) — never per-second timer digits, which would turn into noise.
 * The pulse is presentation-only: the DOM value is already updated by React
 * when the effect runs.
 */
export function usePulseOnChange<V, E extends HTMLElement = HTMLElement>(value: V): RefObject<E | null> {
  const ref = useRef<E | null>(null);
  const previous = useRef<V>(value);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    if (ref.current) pop(ref.current);
  }, [value]);
  return ref;
}
