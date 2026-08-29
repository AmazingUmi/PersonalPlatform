import type { ReactNode } from "react";
import { PixelIcon, type IconName } from "./PixelIcon";

export type StatusTone = "error" | "success" | "warning" | "info";

const STATUS_ICONS: Record<StatusTone, IconName> = {
  error: "warning",
  success: "check",
  warning: "warning",
  info: "info",
};

interface StatusMessageProps {
  tone?: StatusTone;
  className?: string;
  children: ReactNode;
}

/** Inline status feedback with icon + text (guide §32: errors carry both). */
export function StatusMessage({ tone = "info", className = "", children }: StatusMessageProps) {
  return (
    <div
      className={`px-status px-status--${tone}${className ? ` ${className}` : ""}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <PixelIcon name={STATUS_ICONS[tone]} className="px-status__icon" />
      <div className="px-status__body">{children}</div>
    </div>
  );
}
