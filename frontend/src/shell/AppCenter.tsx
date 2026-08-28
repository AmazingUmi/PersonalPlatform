import { useState } from "react";
import { setAppEnabled, type AppInfo } from "../shared/api";

export function AppCenter({ apps, onChanged }: { apps: AppInfo[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(app: AppInfo) {
    setBusy(app.id);
    setError(null);
    try {
      await setAppEnabled(app.id, app.status !== "enabled");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <h1>App Center</h1>
      {error && <p className="error-text">{error}</p>}
      <ul className="app-list">
        {apps.map((app) => (
          <li key={app.id} className="app-row">
            <div className="app-row__info">
              <strong>{app.name}</strong>
              <span className={`app-status app-status--${app.status}`}>{app.status}</span>
              <span className="muted">v{app.version}</span>
              {app.errorMessage && <span className="error-text">{app.errorMessage}</span>}
            </div>
            <button
              type="button"
              disabled={busy === app.id || app.status === "error" || app.status === "installed"}
              onClick={() => void toggle(app)}
            >
              {app.status === "enabled" ? "Disable" : "Enable"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
