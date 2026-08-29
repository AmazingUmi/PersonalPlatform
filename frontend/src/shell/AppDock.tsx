import { NavLink } from "react-router-dom";
import type { AppInfo } from "../shared/api";
import { appIconName } from "../shared/ui/appIcons";
import { PixelIcon } from "../shared/ui/PixelIcon";

const CORE_ITEMS = [
  { to: "/", end: true, label: "Dashboard", icon: "dashboard" },
  { to: "/apps", end: false, label: "App Center", icon: "apps" },
  { to: "/settings", end: false, label: "Settings", icon: "settings" },
] as const;

/**
 * Left application dock (guide §10): CORE entries are static, APPS entries
 * are generated from the enabled app list reported by core.
 */
export function AppDock({ apps }: { apps: AppInfo[] }) {
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
          {apps.map((app) => (
            <li key={app.id}>
              <NavLink
                to={app.route}
                className="dock__item"
                aria-label={app.name}
                title={app.name}
              >
                <PixelIcon name={appIconName(app.id)} />
                <span className="dock__item-label">{app.name}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </section>
    </nav>
  );
}
