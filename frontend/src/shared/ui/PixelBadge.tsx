import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

interface PixelBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/** Rectangular pixel status badge (guide §16). Text keeps its tone class so
 * status is readable without relying on color alone. */
export function PixelBadge({ tone = "neutral", className = "", ...rest }: PixelBadgeProps) {
  return (
    <span
      className={`px-badge px-badge--${tone}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}
