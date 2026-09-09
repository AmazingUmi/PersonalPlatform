import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { AppInfo } from "../shared/api";
import { resolvePresentation, type PresentationOverrides } from "../shared/presentation";
import { prefersReducedMotion } from "../shared/motion/reducedMotion";
import { appIconName } from "../shared/ui/appIcons";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { StatusChip } from "../shared/ui/StatusChip";
import { useAppStatuses } from "./AppStatusContext";

/** Keyframe name of the panel exit animation (see shell.css). */
const PANEL_EXIT_ANIMATION = "mobile-nav-panel-out";

/**
 * Mobile bottom navigation (guide §10): Dashboard | Apps | More. Enabled apps
 * and Settings live behind the "More" launcher so 320px screens never try to
 * fit every app into the bar. Names follow the resolved presentation (FP-6).
 *
 * The launcher panel plays a short exit animation before unmounting. The
 * animation is presentation-only: Escape and route changes unmount instantly,
 * the closing phase is pointer-inert from the first frame, and a missed
 * animationend self-heals on the next open/close/route change. The exit
 * listener is a native listener (not a React synthetic handler) so its
 * behavior is identical across browsers and test DOMs.
 */
export function MobileNav({ apps, presentation }: { apps: AppInfo[]; presentation?: PresentationOverrides }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const statuses = useAppStatuses();

  useEffect(() => {
    setOpen(false);
    setClosing(false);
  }, [location]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setClosing(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Exit completion: only the panel's own exit keyframe finishes the close.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !closing) return;
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.target !== panel) return;
      if (event.animationName !== PANEL_EXIT_ANIMATION) return;
      setOpen(false);
      setClosing(false);
    };
    panel.addEventListener("animationend", onAnimationEnd);
    return () => panel.removeEventListener("animationend", onAnimationEnd);
  }, [closing]);

  /** Animated close path: keep the panel mounted (inert) until animationend. */
  const requestClose = useCallback(() => {
    if (!open) return;
    if (prefersReducedMotion()) {
      setOpen(false);
      return;
    }
    setClosing(true);
  }, [open]);

  const toggleLauncher = () => {
    if (closing) {
      // Re-opening mid-exit cancels the pending close.
      setClosing(false);
      return;
    }
    if (open) {
      requestClose();
      return;
    }
    setOpen(true);
  };

  return (
    <>
      {open || closing ? (
        <>
          <button
            type="button"
            className={`mobile-nav__backdrop${closing ? " mobile-nav__backdrop--closing" : ""}`}
            aria-label="Close menu"
            onClick={requestClose}
            tabIndex={closing ? -1 : undefined}
          />
          <div
            ref={panelRef}
            className={`mobile-nav__panel${closing ? " mobile-nav__panel--closing" : ""}`}
            role="dialog"
            aria-label="More apps"
            id="mobile-menu"
          >
            <ul className="mobile-nav__panel-list">
              <li>
                <NavLink to="/settings" className="mobile-nav__panel-link">
                  <PixelIcon name="settings" />
                  Settings
                </NavLink>
              </li>
              {apps.map((app) => {
                const resolved = resolvePresentation(app, presentation ?? {});
                const chips = statuses.get(app.id) ?? [];
                return (
                  <li key={app.id}>
                    <NavLink
                      to={app.route}
                      className="mobile-nav__panel-link"
                      aria-label={resolved.displayName}
                    >
                      <PixelIcon name={appIconName(app.id)} />
                      {resolved.displayName}
                      {chips.length > 0 ? (
                        <span className="mobile-nav__panel-status" aria-hidden="true">
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
          aria-expanded={open && !closing}
          aria-controls="mobile-menu"
          aria-haspopup="dialog"
          onClick={toggleLauncher}
        >
          <PixelIcon name="menu" />
          <span className="mobile-nav__item-label">More</span>
        </button>
      </nav>
    </>
  );
}
