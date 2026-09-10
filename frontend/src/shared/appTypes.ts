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

/** Discrete information-density level a widget renders at. */
export type WidgetDensity = "compact" | "normal" | "expanded";

/** Size (grid units) a placement must reach to qualify for a density level. */
export interface WidgetDensityThreshold {
  minW?: number;
  minH?: number;
}

/**
 * Layout-facing widget contract (Dashboard Free Layout V2 + Phase 10). All
 * values are logical grid units. The Dashboard owns final layout authority:
 * the widget only declares its usable ranges, defaults and density
 * thresholds — never absolute positions.
 */
export interface WidgetLayoutSpec {
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  defaultW?: number;
  defaultH?: number;
  density?: {
    normal?: WidgetDensityThreshold;
    expanded?: WidgetDensityThreshold;
  };
}

/**
 * Layout facts handed to a widget's render: the concrete size it occupies
 * plus the resolved density. Surfaces without grid geometry (mobile flow)
 * pass the widget defaults with density "normal". Widgets must derive their
 * information density from this context — never from the viewport.
 */
export interface WidgetRenderContext {
  layout: {
    widthUnits: number;
    heightUnits: number;
    widthPx: number;
    heightPx: number;
    density: WidgetDensity;
  };
}

export interface WidgetDefinition {
  /** Matches a widget id declared in apps/<app_id>/app.yaml. */
  id: string;
  title: string;
  /** Deep link for dashboard card clicks; falls back to the app root route. */
  href?: string;
  /** Optional layout constraints/density thresholds (grid units). */
  layout?: WidgetLayoutSpec;
  /**
   * Rendered inside the dashboard grid with its own error boundary. The
   * context argument is optional so pre-Phase-10 widgets keep working
   * (missing layout declaration ⇒ platform defaults, density "normal").
   */
  render: (context?: WidgetRenderContext) => ReactNode;
}

/**
 * One live status fact an app wants the shell chrome (dock badge, top-bar
 * chip) to display. Purely informational: the shell renders label/tone
 * generically and never interprets app semantics.
 */
export interface AppStatusChip {
  /** Stable id within the app (e.g. "today") — dedupe/keys only. */
  id: string;
  /** Compact text: a count ("4"), a dot ("●"), never a sentence. */
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  /** Accessible explanation for hover/AT (e.g. "3 tasks due today"). */
  title?: string;
}

/**
 * Optional app → shell status feed. `load` is called on shell refresh
 * triggers (mount, route change, window focus, 60s visible interval);
 * `subscribe` lets an app push updates (e.g. its BroadcastChannel).
 * Failures hide the app's chips — status is decorative, never an error
 * surface.
 *
 * Policy: chips are for TIME-SENSITIVE signals a user might act on soon —
 * due counts, live sessions, the next alarm. Slowly drifting aggregates
 * (inventory totals, note counts, all-time scores) do not qualify; an app
 * whose only numbers are aggregates should not register a provider at all.
 */
export interface AppStatusProvider {
  load: () => Promise<AppStatusChip[]>;
  subscribe?: (onChange: () => void) => () => void;
}

export interface FrontendAppModule {
  id: string;
  routes: AppRoute[];
  widgets?: WidgetDefinition[];
  status?: AppStatusProvider;
}
