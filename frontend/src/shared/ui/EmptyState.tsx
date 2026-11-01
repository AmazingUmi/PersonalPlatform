import type { ReactNode } from "react";
import { PixelIcon, type IconName } from "./PixelIcon";

interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  /** Help trigger kept on the title row, outside the title text. */
  help?: ReactNode;
  action?: ReactNode;
}

/** Unified empty state (guide §26): icon + title + short explanation + action. */
export function EmptyState({ icon = "apps", title, description, help, action }: EmptyStateProps) {
  return (
    <div className="px-empty">
      <span className="px-empty__icon">
        <PixelIcon name={icon} size={32} />
      </span>
      <p className="px-empty__title">
        {help ? <span className="px-inline-help"><span>{title}</span>{help}</span> : title}
      </p>
      {description ? <p className="px-empty__desc">{description}</p> : null}
      {action ? <div className="px-empty__action">{action}</div> : null}
    </div>
  );
}
