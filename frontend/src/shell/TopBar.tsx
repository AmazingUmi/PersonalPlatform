import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { AppInfo } from "../shared/api";
import type { AppStatusChip } from "../shared/appTypes";
import { useAppDisplayName } from "../shared/PresentationContext";
import { PixelBadge } from "../shared/ui/PixelBadge";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { useAppStatuses } from "./AppStatusContext";

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

/** 24h wall clock "22:34" — the OS status-bar convention. */
export function formatWallClock(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Minute-precision clock: ticks every second but only re-renders when the
 * printed label actually changes (one paint per minute). */
function useWallClock(): string {
  const [label, setLabel] = useState(() => formatWallClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => {
      const next = formatWallClock(new Date());
      setLabel((prev) => (prev === next ? prev : next));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return label;
}

/**
 * System top bar (guide §9): logo + brand + current page + live OS status —
 * wall clock, per-app status chips (from the app-status providers) and the
 * enabled-app count. All values are real; nothing is decorative filler.
 */
export function TopBar({ apps }: { apps: AppInfo[] }) {
  const { pathname } = useLocation();
  const enabled = apps.filter((app) => app.status === "enabled");
  const statuses = useAppStatuses();
  const clock = useWallClock();
  const chipApps = enabled.filter((app) => (statuses.get(app.id) ?? []).length > 0);

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
        {chipApps.flatMap((app) =>
          (statuses.get(app.id) ?? []).map((chip) => (
            <TopBarChip key={`${app.id}:${chip.id}`} app={app} chip={chip} />
          )),
        )}
        <PixelBadge
          tone={enabled.length > 0 ? "success" : "neutral"}
          className="topbar__apps-count"
          title="Enabled apps"
        >
          {enabled.length} apps active
        </PixelBadge>
        <span className="topbar__clock" title="Local time">
          {clock}
        </span>
      </span>
    </header>
  );
}

/** One readable status chip: "TASKS 4" / "FOCUS ●". */
function TopBarChip({ app, chip }: { app: AppInfo; chip: AppStatusChip }) {
  const displayName = useAppDisplayName(app);
  return (
    <PixelBadge
      tone={chip.tone === "neutral" ? "info" : chip.tone}
      title={chip.title}
      className="topbar__status-chip"
    >
      {displayName.toUpperCase()} {chip.label}
    </PixelBadge>
  );
}
