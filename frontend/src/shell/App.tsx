import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { fetchApps, type AppInfo } from "../shared/api";
import { AppCenter } from "./AppCenter";
import { Dashboard } from "./Dashboard";
import { Nav } from "./Nav";
import { Settings } from "./Settings";
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
      <div className="shell">
        <header className="shell__header">
          <strong>Personal Platform</strong>
        </header>
        <main className="shell__main">
          {error ? <p className="error-text">Backend unavailable: {error}</p> : <p className="muted">Loading…</p>}
        </main>
      </div>
    );
  }

  const modules = enabledAppModules(apps);
  const routes = resolveRoutes(modules, apps);

  return (
    <BrowserRouter>
      <div className="shell">
        <Nav apps={apps.filter((app) => app.status === "enabled")} />
        <main className="shell__main">
          <Routes>
            <Route path="/" element={<Dashboard apps={apps} />} />
            <Route path="/apps" element={<AppCenter apps={apps} onChanged={() => setRefreshKey((k) => k + 1)} />} />
            <Route path="/settings" element={<Settings />} />
            {routes.map((route) => (
              <Route key={route.path} path={route.path} element={route.element} />
            ))}
            <Route path="*" element={<div className="page"><h1>Not Found</h1></div>} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
