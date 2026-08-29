import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { getSetting, putSetting, type AppInfo } from "../shared/api";
import { EmptyState } from "../shared/ui/EmptyState";
import { LoadingState } from "../shared/ui/LoadingState";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { StatusMessage } from "../shared/ui/StatusMessage";
import { appAccent, appIconName } from "../shared/ui/appIcons";
import { enabledAppModules, resolveWidgets, type ResolvedWidget } from "./routes";

const LAYOUT_KEY = "dashboard.widgets";
const widgetKey = (widget: ResolvedWidget) => `${widget.appId}:${widget.widget.id}`;

/**
 * Dashboard is a pure widget container: widgets come from enabled frontend
 * app modules; the visible set is persisted in core.settings under
 * "dashboard.widgets" (default: every available widget).
 */
export function Dashboard({ apps }: { apps: AppInfo[] }) {
  const modules = enabledAppModules(apps);
  const available = resolveWidgets(modules);

  const [layout, setLayout] = useState<string[] | null | "loading">("loading");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getSetting<string[]>(LAYOUT_KEY)
      .then((value) => {
        if (active) setLayout(Array.isArray(value) ? value : null);
      })
      .catch(() => {
        if (active) setLayout(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const persistLayout = useCallback(async (keys: string[] | null, availableKeys: string[]) => {
    setSaveError(null);
    const value = keys ?? availableKeys;
    try {
      await putSetting(LAYOUT_KEY, value);
      setLayout(value);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  if (layout === "loading") {
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-header__title">Dashboard</h1>
          <p className="page-header__subtitle">System overview</p>
        </header>
        <LoadingState label="Loading widgets…" />
      </div>
    );
  }

  const availableKeys = available.map(widgetKey);
  const visibleKeys = (layout ?? availableKeys).filter((key) => availableKeys.includes(key));
  const visible = available.filter((widget) => visibleKeys.includes(widgetKey(widget)));
  const hiddenCount = availableKeys.length - visibleKeys.length;

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">Dashboard</h1>
        <p className="page-header__subtitle">System overview</p>
      </header>
      {saveError && (
        <StatusMessage tone="error">
          <p>Layout save failed: {saveError}</p>
        </StatusMessage>
      )}
      {visible.length === 0 ? (
        <EmptyState
          icon="apps"
          title="No widgets available"
          description="Enable apps in the App Center to populate the dashboard."
          action={
            <Link to="/apps" className="px-button px-button--primary px-button--md">
              Open App Center
            </Link>
          }
        />
      ) : (
        <div className="dashboard-grid">
          {visible.map((resolved) => (
            <ErrorBoundary
              key={widgetKey(resolved)}
              fallback={
                <PixelWindow
                  title={resolved.widget.title}
                  icon="warning"
                  accent="danger"
                  data-widget-key={widgetKey(resolved)}
                >
                  <p className="dashboard-widget-error">Widget failed to render.</p>
                </PixelWindow>
              }
            >
              <PixelWindow
                title={resolved.widget.title}
                icon={appIconName(resolved.appId)}
                accent={appAccent(resolved.appId)}
                data-widget-key={widgetKey(resolved)}
              >
                {resolved.widget.render()}
              </PixelWindow>
            </ErrorBoundary>
          ))}
        </div>
      )}
      {hiddenCount > 0 ? (
        <p className="dashboard-hidden">
          <span>{hiddenCount} widget(s) hidden.</span>
          <PixelButton
            variant="ghost"
            size="sm"
            onClick={() => void persistLayout(null, availableKeys)}
          >
            Restore default layout
          </PixelButton>
        </p>
      ) : null}
    </div>
  );
}
