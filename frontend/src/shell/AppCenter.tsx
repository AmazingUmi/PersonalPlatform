import { useState } from "react";
import { setAppEnabled, type AppInfo, type AppStatus } from "../shared/api";
import { PixelBadge, type BadgeTone } from "../shared/ui/PixelBadge";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { StatusMessage } from "../shared/ui/StatusMessage";
import { appIconName } from "../shared/ui/appIcons";

const STATUS_TONES: Record<AppStatus, BadgeTone> = {
  enabled: "success",
  disabled: "neutral",
  error: "danger",
  installed: "info",
};

/** App library (guide §20): responsive card grid generated from the app list. */
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
      <header className="page-header">
        <h1 className="page-header__title">App Center</h1>
        <p className="page-header__subtitle">Install, enable and disable platform apps</p>
      </header>
      {error && (
        <StatusMessage tone="error">
          <p>{error}</p>
        </StatusMessage>
      )}
      <ul className="app-grid">
        {apps.map((app) => (
          <li key={app.id} className="app-card" data-app={app.id}>
            <div className="app-card__head">
              <span className="app-card__icon" aria-hidden="true">
                <PixelIcon name={appIconName(app.id)} size={24} />
              </span>
              <div className="app-card__meta">
                <h2 className="app-card__name">{app.name}</h2>
                <span className="app-card__version">v{app.version}</span>
              </div>
            </div>
            {app.description ? <p className="app-card__desc">{app.description}</p> : null}
            {app.errorMessage ? (
              <p className="app-card__error">
                <PixelIcon name="warning" />
                {app.errorMessage}
              </p>
            ) : null}
            <div className="app-card__foot">
              <PixelBadge tone={STATUS_TONES[app.status]}>{app.status}</PixelBadge>
              <PixelButton
                size="sm"
                variant={app.status === "enabled" ? "secondary" : "primary"}
                disabled={busy === app.id || app.status === "error" || app.status === "installed"}
                onClick={() => void toggle(app)}
              >
                {busy === app.id ? "Working…" : app.status === "enabled" ? "Disable" : "Enable"}
              </PixelButton>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
