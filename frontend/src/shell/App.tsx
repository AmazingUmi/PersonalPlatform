import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { fetchApps, type AppInfo } from "../shared/api";
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
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchApps()
      .then((items) => {
        if (!cancelled) {
          setApps(items);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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

  return (
    <BrowserRouter>
      <div className="shell">
        <a className="skip-link" href="#shell-content">
          Skip to content
        </a>
        <TopBar apps={apps} />
        <div className="shell__workspace">
          <AppDock apps={enabled} />
          <main className="shell__content" id="shell-content" tabIndex={-1}>
            <Routes>
              <Route path="/" element={<Dashboard apps={apps} />} />
              <Route
                path="/apps"
                element={<AppCenter apps={apps} onChanged={() => setRefreshKey((key) => key + 1)} />}
              />
              <Route path="/settings" element={<Settings apps={apps} />} />
              {routes.map((route) => (
                <Route key={route.path} path={route.path} element={route.element} />
              ))}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
        <MobileNav apps={enabled} />
      </div>
    </BrowserRouter>
  );
}
