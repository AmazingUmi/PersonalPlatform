import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { getSetting, putSetting, type AppInfo } from "../shared/api";
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
        <h1>Dashboard</h1>
        <p className="muted">Loading widgets…</p>
      </div>
    );
  }

  const availableKeys = available.map(widgetKey);
  const visibleKeys = (layout ?? availableKeys).filter((key) => availableKeys.includes(key));
  const visible = available.filter((widget) => visibleKeys.includes(widgetKey(widget)));
  const hiddenCount = availableKeys.length - visibleKeys.length;

  return (
    <div className="page">
      <h1>Dashboard</h1>
      {saveError && (
        <p className="error-text" role="alert">
          Layout save failed: {saveError}
        </p>
      )}
      {visible.length === 0 ? (
        <p className="muted">No widgets available. Enable apps in the App Center to populate the dashboard.</p>
      ) : (
        <div className="dashboard-grid">
          {visible.map((resolved) => (
            <ErrorBoundary
              key={widgetKey(resolved)}
              fallback={
                <section className="widget-card widget-card--error">
                  <h2 className="widget-card__title">{resolved.widget.title}</h2>
                  <p className="widget-card__body">Widget failed to render.</p>
                </section>
              }
            >
              <section className="widget-card" data-widget-key={widgetKey(resolved)}>
                <h2 className="widget-card__title">{resolved.widget.title}</h2>
                <div className="widget-card__body">{resolved.widget.render()}</div>
              </section>
            </ErrorBoundary>
          ))}
        </div>
      )}
      {hiddenCount > 0 ? (
        <p>
          {hiddenCount} widget(s) hidden.{" "}
          <button type="button" className="link-button" onClick={() => void persistLayout(null, availableKeys)}>
            Restore default layout
          </button>
        </p>
      ) : null}
    </div>
  );
}
