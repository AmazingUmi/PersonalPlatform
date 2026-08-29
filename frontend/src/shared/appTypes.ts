import type { ReactNode } from "react";

/**
 * Frontend app module contract (doc §4.3). The shell intersects these
 * compile-time modules with the enabled state from /api/core/apps.
 */

export interface AppRoute {
  /** Route path relative to the app root, "" meaning the app index. */
  path: string;
  label: string;
  element: ReactNode;
}

export interface WidgetDefinition {
  /** Matches a widget id declared in apps/<app_id>/app.yaml. */
  id: string;
  title: string;
  /** Deep link for dashboard card clicks; falls back to the app root route. */
  href?: string;
  /** Rendered inside the dashboard grid with its own error boundary. */
  render: () => ReactNode;
}

export interface FrontendAppModule {
  id: string;
  routes: AppRoute[];
  widgets?: WidgetDefinition[];
}
