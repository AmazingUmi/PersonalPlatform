import { Link, useLocation } from "react-router-dom";
import type { AppInfo } from "../shared/api";
import { PixelBadge } from "../shared/ui/PixelBadge";
import { PixelIcon } from "../shared/ui/PixelIcon";

/** Resolve the page title shown in the top bar from the current route. */
export function pageTitle(pathname: string, apps: AppInfo[]): string {
  if (pathname === "/") return "Dashboard";
  if (pathname.startsWith("/apps")) return "App Center";
  if (pathname.startsWith("/settings")) return "Settings";
  const match = apps.find(
    (app) => pathname === app.route || pathname.startsWith(`${app.route}/`),
  );
  return match ? match.name : "Not Found";
}

/** System top bar (guide §9): logo + brand + current page + core status. */
export function TopBar({ apps }: { apps: AppInfo[] }) {
  const { pathname } = useLocation();
  const enabled = apps.filter((app) => app.status === "enabled").length;

  return (
    <header className="topbar">
      <Link to="/" className="topbar__brand" aria-label="Personal Platform home">
        <PixelIcon name="logo" size={24} className="topbar__logo" />
        <span className="topbar__brand-text">Personal Platform</span>
      </Link>
      <span className="topbar__title" aria-hidden="true">
        ▸ {pageTitle(pathname, apps)}
      </span>
      <span className="topbar__status">
        <PixelBadge tone={enabled > 0 ? "success" : "neutral"}>
          {enabled} apps active
        </PixelBadge>
      </span>
    </header>
  );
}
