import { NavLink } from "react-router-dom";
import type { AppInfo } from "../shared/api";
import { resolvePresentation, type PresentationOverrides } from "../shared/presentation";
import { appIconName } from "../shared/ui/appIcons";
import { PixelIcon } from "../shared/ui/PixelIcon";

const CORE_ITEMS = [
  { to: "/", end: true, label: "Dashboard", icon: "dashboard" },
  { to: "/apps", end: false, label: "App Center", icon: "apps" },
  { to: "/settings", end: false, label: "Settings", icon: "settings" },
] as const;

/**
 * Left application dock (guide §10): CORE entries are static, APPS entries
 * are generated from the enabled app list reported by core. Names and accents
 * come from the resolved presentation (FP-6).
 */
export function AppDock({ apps, presentation }: { apps: AppInfo[]; presentation?: PresentationOverrides }) {
  return (
    <nav className="dock" aria-label="App navigation">
      <section className="dock__section">
        <span className="dock__label">Core</span>
        <ul className="dock__list">
          {CORE_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className="dock__item" aria-label={item.label}>
                <PixelIcon name={item.icon} />
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
            return (
              <li key={app.id}>
                <NavLink
                  to={app.route}
                  className="dock__item"
                  aria-label={resolved.displayName}
                  title={resolved.displayName}
                >
                  <PixelIcon name={appIconName(app.id)} />
                  <span className="dock__item-label">{resolved.displayName}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </section>
    </nav>
  );
}
