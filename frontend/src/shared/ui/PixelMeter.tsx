import type { PixelAccent } from "./PixelWindow";

const DEFAULT_SEGMENTS = 10;

/**
 * Segmented pixel meter (guide §18 low-density visualization): the literal
 * `██████░░░░` pattern as discrete blocks — filled segments carry the accent,
 * empty ones stay paper. Discrete segments (not a smooth % width) keep the
 * reading quantized like everything else in the pixel language. Purely
 * presentational: the accessible value travels in the aria-label supplied
 * by the caller ("3 of 8 done"), so color is never the only channel.
 */
export function PixelMeter({
  value,
  max,
  label,
  accent = "primary",
  segments = DEFAULT_SEGMENTS,
  className = "",
}: {
  value: number;
  max: number;
  /** Full accessible summary, e.g. "3 of 8 tasks done". */
  label: string;
  accent?: PixelAccent;
  segments?: number;
  className?: string;
}) {
  const safeMax = Math.max(1, max);
  const filled = Math.max(0, Math.min(segments, Math.round((value / safeMax) * segments)));
  return (
    <span
      className={`px-meter${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
      data-accent={accent}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span key={index} className={index < filled ? "px-meter__seg px-meter__seg--on" : "px-meter__seg"} />
      ))}
    </span>
  );
}
