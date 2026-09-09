import type { AppStatusChip } from "../appTypes";

/**
 * Visual-only status chip for shell navigation rows (dock, mobile nav).
 * Always aria-hidden: the surrounding link's accessible name stays the app
 * name, so a count appearing/disappearing never changes what screen readers
 * announce. The top bar renders its own readable chips via PixelBadge.
 */
export function StatusChip({ chip, className = "" }: { chip: AppStatusChip; className?: string }) {
  return (
    <span className={`status-chip status-chip--${chip.tone}${className ? ` ${className}` : ""}`} title={chip.title}>
      {chip.label}
    </span>
  );
}
