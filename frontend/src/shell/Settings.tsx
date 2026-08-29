import { Link } from "react-router-dom";
import type { AppInfo } from "../shared/api";
import { PixelWindow } from "../shared/ui/PixelWindow";
import pkg from "../../package.json";

/**
 * System settings panel (guide §25). Shows only real platform facts —
 * settings themselves live in config/platform.yaml and core.settings.
 */
export function Settings({ apps = [] }: { apps?: AppInfo[] }) {
  const enabled = apps.filter((app) => app.status === "enabled").length;

  return (
    <div className="page page--detail" data-app="settings">
      <header className="page-header">
        <h1 className="page-header__title">Settings</h1>
        <p className="page-header__subtitle">System configuration</p>
      </header>

      <PixelWindow title="System" icon="settings">
        <dl className="px-deflist">
          <div>
            <dt>Platform</dt>
            <dd>PersonalPlatform</dd>
          </div>
          <div>
            <dt>Frontend</dt>
            <dd>v{pkg.version}</dd>
          </div>
          <div>
            <dt>Apps</dt>
            <dd>
              {apps.length} installed · {enabled} enabled
            </dd>
          </div>
          <div>
            <dt>Theme</dt>
            <dd>Light (Pixel)</dd>
          </div>
        </dl>
        <p className="settings-hint">
          Manage installed apps in the <Link to="/apps">App Center</Link>.
        </p>
      </PixelWindow>

      <PixelWindow title="Configuration" icon="file">
        <p className="settings-text">
          Platform settings are stored in <code>config/platform.yaml</code> and{" "}
          <code>core.settings</code>. Secrets always come from environment variables.
        </p>
      </PixelWindow>
    </div>
  );
}
