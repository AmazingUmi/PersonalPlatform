import type { HTMLAttributes } from "react";
import type { PixelAccent } from "./PixelWindow";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

interface PixelBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Platform accent (same palette as PixelWindow). When set it renders as a
   * `data-accent` attribute so the badge is painted with that accent's
   * light-fill + darkened-text pair. `tone` remains the fallback dimension —
   * its class is always emitted, and `[data-accent]` rules outrank the tone
   * class by selector specificity, so an accent wins the color while the tone
   * still communicates status when color is unavailable. Omit it to keep the
   * plain tone styling (no `data-accent` attribute is rendered). */
  accent?: PixelAccent;
}

/** Rectangular pixel status badge (guide §16). Text keeps its tone class so
 * status is readable without relying on color alone. */
export function PixelBadge({ tone = "neutral", accent, className = "", ...rest }: PixelBadgeProps) {
  return (
    <span
      className={`px-badge px-badge--${tone}${className ? ` ${className}` : ""}`}
      data-accent={accent}
      {...rest}
    />
  );
}
