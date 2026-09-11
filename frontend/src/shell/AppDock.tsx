import type { CSSProperties } from "react";
import { NavLink } from "react-router-dom";
import type { AppInfo } from "../shared/api";
import { resolvePresentation, type PresentationOverrides } from "../shared/presentation";
import { appIconName } from "../shared/ui/appIcons";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { StatusChip } from "../shared/ui/StatusChip";
import { useAppStatuses } from "./AppStatusContext";

const CORE_ITEMS = [
  { to: "/", end: true, label: "Dashboard", icon: "dashboard" },
  { to: "/apps", end: false, label: "App Center", icon: "apps" },
  { to: "/settings", end: false, label: "Settings", icon: "settings" },
] as const;

/** Resolve the dock's active-indicator/icon accent as a CSS variable value. */
function accentVar(accent: string | undefined): string {
  return `var(--px-${accent ?? "primary"})`;
}

/**
 * Left application dock (guide §10): CORE entries are static, APPS entries
 * are generated from the enabled app list reported by core. Names and accents
 * come from the resolved presentation (FP-6); live status chips (real counts
 * / running markers, hidden at zero) come from the app-status providers.
 */
export function AppDock({ apps, presentation }: { apps: AppInfo[]; presentation?: PresentationOverrides }) {
  const statuses = useAppStatuses();
  return (
    <nav className="dock" aria-label="App navigation">
      <section className="dock__section">
        <span className="dock__label">Core</span>
        <ul className="dock__list">
          {CORE_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className="dock__item" aria-label={item.label}>
                <span className="dock__item-icon" aria-hidden="true">
                  <PixelIcon name={item.icon} size={16} />
                </span>
                <span className="dock__item-label">{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </section>
      <section className="dock__section">
        <span className="dock__label">Apps</span>
        <ul className="dock__list">
          {apps.map((app) => {
            const resolved = resolvePresentation(app, presentation ?? {});
            const chips = statuses.get(app.id) ?? [];
            return (
              <li key={app.id}>
                <NavLink
                  to={app.route}
                  className="dock__item"
                  aria-label={resolved.displayName}
                  title={resolved.displayName}
                  style={{ "--app-accent": accentVar(resolved.accent) } as CSSProperties}
                >
                  <span className="dock__item-icon" aria-hidden="true">
                    <PixelIcon name={appIconName(app.id)} size={16} />
                  </span>
                  <span className="dock__item-label">{resolved.displayName}</span>
                  {chips.length > 0 ? (
                    <span className="dock__item-status" aria-hidden="true">
                      {chips.map((chip) => (
                        <StatusChip key={chip.id} chip={chip} />
                      ))}
                    </span>
                  ) : null}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </section>
    </nav>
  );
}
