import type { HTMLAttributes, ReactNode } from "react";
import { PixelIcon, type IconName } from "./PixelIcon";

export type PixelAccent =
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "mint"
  | "yellow"
  | "violet"
  | "coral";

interface PixelWindowProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  icon?: IconName;
  accent?: PixelAccent;
  headingLevel?: 1 | 2 | 3;
  actions?: ReactNode;
  children: ReactNode;
}

/** Retro utility window (guide §12): bordered header bar + body + hard shadow.
 * The header icon inherits the app accent unless an explicit accent is set. */
export function PixelWindow({
  title,
  icon,
  accent,
  headingLevel = 2,
  actions,
  children,
  className = "",
  ...rest
}: PixelWindowProps) {
  const Heading = `h${headingLevel}` as "h1" | "h2" | "h3";
  return (
    <section
      className={`px-window${accent ? ` px-window--${accent}` : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      <header className="px-window__header">
        {icon ? <PixelIcon name={icon} /> : null}
        <Heading className="px-window__title">{title}</Heading>
        {actions ? <div className="px-window__actions">{actions}</div> : null}
      </header>
      <div className="px-window__body">{children}</div>
    </section>
  );
}
