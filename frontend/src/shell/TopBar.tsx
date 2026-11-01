import { appName } from "../shared/localizedMetadata";
import type { Language } from "../shared/i18n";
import { useI18n } from "../shared/i18n";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { AppInfo, AuthUser } from "../shared/api";
import type { AppStatusChip } from "../shared/appTypes";
import { useAppDisplayName } from "../shared/PresentationContext";
import { PixelBadge } from "../shared/ui/PixelBadge";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { useAppStatuses } from "./AppStatusContext";

/** Resolve the page title shown in the top bar from the current route. */
export function pageTitle(pathname: string, apps: AppInfo[], language: Language = "en"): string {
  if (pathname === "/") return language === "zh" ? "仪表盘" : "Dashboard";
  if (pathname.startsWith("/apps")) return language === "zh" ? "应用中心" : "App Center";
  if (pathname.startsWith("/settings")) return language === "zh" ? "设置" : "Settings";
  const match = apps.find(
    (app) => pathname === app.route || pathname.startsWith(`${app.route}/`),
  );
  return match ? appName(match.id, match.name, language) : language === "zh" ? "页面不存在" : "Not Found";
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
export function TopBar({
  apps,
  user = null,
  onLogout,
}: {
  apps: AppInfo[];
  /** Current session user (AUTH-5); null hides the account chip. */
  user?: AuthUser | null;
  onLogout?: () => void;
}) {
  const { t, language } = useI18n();
  const { pathname } = useLocation();
  const enabled = apps.filter((app) => app.status === "enabled");
  const statuses = useAppStatuses();
  const clock = useWallClock();
  const chipApps = enabled.filter((app) => (statuses.get(app.id) ?? []).length > 0);

  return (
    <header className="topbar">
      <Link to="/" className="topbar__brand" aria-label={t("Personal Platform home", "个人平台首页")}>
        <PixelIcon name="logo" size={24} className="topbar__logo" />
        <span className="topbar__brand-text">Personal Platform</span>
      </Link>
      <span className="topbar__title" aria-hidden="true">
        ▸ {pageTitle(pathname, apps, language)}
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
          title={t("Enabled apps", "已启用应用")}
        >
          {enabled.length} {t("apps active", "个应用运行中")} </PixelBadge>
        <span className="topbar__clock" title={t("Local time", "本地时间")}>
          {clock}
        </span>
        {user ? (
          <span className="topbar__account">
            <span className="topbar__user" title={t(`Signed in as ${user.username} (${user.role})`, `当前账号：${user.username}（${user.role === "admin" ? "管理员" : "用户"}）`)}>
              <span className="topbar__user-sigil" aria-hidden="true">
                ▚
              </span>{" "}
              {user.displayName ?? user.username}
              {user.role === "admin" ? (
                <span className="topbar__user-role" aria-label={t("administrator role", "管理员角色")}>
                  ★
                </span>
              ) : null}
            </span>
            <button
              type="button"
              className="topbar__logout"
              onClick={onLogout}
              aria-label={t("Log out", "退出登录")}
              title={t("Log out", "退出登录")}
            >{t("LOGOUT", "退出")} </button>
          </span>
        ) : null}
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
