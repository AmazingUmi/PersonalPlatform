import { Link, NavLink } from "react-router-dom";
import type { AppInfo } from "../shared/api";

export function Nav({ apps }: { apps: AppInfo[] }) {
  return (
    <header className="shell__header">
      <nav className="shell__nav">
        <Link to="/" className="shell__brand">
          Personal Platform
        </Link>
        <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-link nav-link--active" : "nav-link")}>
          Dashboard
        </NavLink>
        <NavLink to="/apps" className={({ isActive }) => (isActive ? "nav-link nav-link--active" : "nav-link")}>
          App Center
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => (isActive ? "nav-link nav-link--active" : "nav-link")}>
          Settings
        </NavLink>
        {apps.map((app) => (
          <NavLink
            key={app.id}
            to={app.route}
            className={({ isActive }) => (isActive ? "nav-link nav-link--active" : "nav-link")}
          >
            {app.name}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
