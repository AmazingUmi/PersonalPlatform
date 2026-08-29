import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { fetchApps, getSetting, type AppInfo } from "../shared/api";
import { PresentationProvider } from "../shared/PresentationContext";
import { normalizeOverrides, PRESENTATION_KEY, type PresentationOverrides } from "../shared/presentation";
import { LoadingState } from "../shared/ui/LoadingState";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { StatusMessage } from "../shared/ui/StatusMessage";
import { AppCenter } from "./AppCenter";
import { AppDock } from "./AppDock";
import { Dashboard } from "./Dashboard";
import { MobileNav } from "./MobileNav";
import { NotFound } from "./NotFound";
import { Settings } from "./Settings";
import { TopBar } from "./TopBar";
import { enabledAppModules, resolveRoutes } from "./routes";

export function App() {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  // Initial-load error (no data at all) gets the full boot error screen.
  const [error, setError] = useState<string | null>(null);
  // Refresh error keeps the stale data visible with a non-blocking banner
  // and a retry (FP-14.2) — never a silent fallback to old data.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [overrides, setOverrides] = useState<PresentationOverrides>({});
  const everLoaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    fetchApps()
      .then((items) => {
        if (cancelled) return;
        everLoaded.current = true;
        setApps(items);
        setError(null);
        setRefreshError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (everLoaded.current) setRefreshError(message);
        else setError(message);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Presentation overrides (apps.presentation in core.settings) travel with
  // the same refresh cycle so App Center edits reflect everywhere at once.
  useEffect(() => {
    let cancelled = false;
    getSetting(PRESENTATION_KEY)
      .then((value) => {
        if (!cancelled) setOverrides(normalizeOverrides(value));
      })
      .catch(() => {
        if (!cancelled) setOverrides({});
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!apps) {
    return (
      <div className="shell shell--boot">
        <header className="topbar">
          <span className="topbar__brand">
            <PixelIcon name="logo" size={24} className="topbar__logo" />
            <span className="topbar__brand-text">Personal Platform</span>
          </span>
        </header>
        <main className="shell__content">
          <div className="page page--boot">
            {error ? (
              <PixelWindow title="System Error" icon="warning" accent="danger">
                <StatusMessage tone="error">
                  <p>Backend unavailable: {error}</p>
                </StatusMessage>
                <PixelButton
                  variant="secondary"
                  size="sm"
                  onClick={() => setRefreshKey((key) => key + 1)}
                >
                  Retry
                </PixelButton>
              </PixelWindow>
            ) : (
              <PixelWindow title="Booting" icon="logo">
                <LoadingState label="Loading system…" />
              </PixelWindow>
            )}
          </div>
        </main>
      </div>
    );
  }

  const modules = enabledAppModules(apps);
  const routes = resolveRoutes(modules, apps);
  const enabled = apps.filter((app) => app.status === "enabled");
  const retryRefresh = () => setRefreshKey((key) => key + 1);

  return (
    <BrowserRouter>
      <PresentationProvider value={overrides}>
        <div className="shell">
          <a className="skip-link" href="#shell-content">
            Skip to content
          </a>
          <TopBar apps={apps} />
          <div className="shell__workspace">
            <AppDock apps={enabled} presentation={overrides} />
            <main className="shell__content" id="shell-content" tabIndex={-1} aria-busy={refreshing}>
              {refreshError ? (
                <StatusMessage tone="error">
                  <p>Refresh failed: {refreshError} — showing previously loaded data.</p>
                  <PixelButton variant="secondary" size="sm" onClick={retryRefresh}>
                    Retry
                  </PixelButton>
                </StatusMessage>
              ) : refreshing ? (
                <p className="muted" role="status">
                  Refreshing…
                </p>
              ) : null}
              <Routes>
                <Route path="/" element={<Dashboard apps={apps} presentation={overrides} />} />
                <Route
                  path="/apps"
                  element={
                    <AppCenter
                      apps={apps}
                      presentation={overrides}
                      onChanged={() => setRefreshKey((key) => key + 1)}
                    />
                  }
                />
                <Route path="/settings" element={<Settings apps={apps} />} />
                {routes.map((route) => (
                  <Route key={route.path} path={route.path} element={route.element} />
                ))}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </main>
          </div>
          <MobileNav apps={enabled} presentation={overrides} />
        </div>
      </PresentationProvider>
    </BrowserRouter>
  );
}
