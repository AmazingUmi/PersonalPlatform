import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { AppInfo } from "../shared/api";
import { resolvePresentation, type PresentationOverrides } from "../shared/presentation";
import { appIconName } from "../shared/ui/appIcons";
import { PixelIcon } from "../shared/ui/PixelIcon";

/**
 * Mobile bottom navigation (guide §10): Dashboard | Apps | More. Enabled apps
 * and Settings live behind the "More" launcher so 320px screens never try to
 * fit every app into the bar. Names follow the resolved presentation (FP-6).
 */
export function MobileNav({ apps, presentation }: { apps: AppInfo[]; presentation?: PresentationOverrides }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {open ? (
        <>
          <button
            type="button"
            className="mobile-nav__backdrop"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div className="mobile-nav__panel" role="dialog" aria-label="More apps" id="mobile-menu">
            <ul className="mobile-nav__panel-list">
              <li>
                <NavLink to="/settings" className="mobile-nav__panel-link">
                  <PixelIcon name="settings" />
                  Settings
                </NavLink>
              </li>
              {apps.map((app) => {
                const resolved = resolvePresentation(app, presentation ?? {});
                return (
                  <li key={app.id}>
                    <NavLink to={app.route} className="mobile-nav__panel-link">
                      <PixelIcon name={appIconName(app.id)} />
                      {resolved.displayName}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      ) : null}
      <nav className="mobile-nav" aria-label="Primary navigation">
        <NavLink to="/" end className="mobile-nav__item">
          <PixelIcon name="dashboard" />
          <span className="mobile-nav__item-label">Dashboard</span>
        </NavLink>
        <NavLink to="/apps" className="mobile-nav__item">
          <PixelIcon name="apps" />
          <span className="mobile-nav__item-label">Apps</span>
        </NavLink>
        <button
          type="button"
          className="mobile-nav__item"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
        >
          <PixelIcon name="menu" />
          <span className="mobile-nav__item-label">More</span>
        </button>
      </nav>
    </>
  );
}
