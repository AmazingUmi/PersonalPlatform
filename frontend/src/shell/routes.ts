import type { ReactNode } from "react";
import { frontendAppModules } from "../generated/apps";
import type { AppInfo } from "../shared/api";
import type { FrontendAppModule, WidgetDefinition } from "../shared/appTypes";

/** Compile-time modules intersected with the enabled apps reported by Core. */
export function enabledAppModules(apps: AppInfo[]): FrontendAppModule[] {
  const enabledIds = new Set(apps.filter((app) => app.status === "enabled").map((app) => app.id));
  return Object.values(frontendAppModules).filter((mod) => enabledIds.has(mod.id));
}

export interface ResolvedRoute {
  path: string;
  element: ReactNode;
  appId: string;
}

/** Combine the manifest route (e.g. /assets) with module route paths. */
export function resolveRoutes(modules: FrontendAppModule[], apps: AppInfo[]): ResolvedRoute[] {
  const byId = new Map(apps.map((app) => [app.id, app]));
  const out: ResolvedRoute[] = [];
  for (const mod of modules) {
    const app = byId.get(mod.id);
    if (!app) continue;
    const base = app.route.replace(/\/+$/, "");
    for (const route of mod.routes) {
      const suffix = route.path === "" ? "" : route.path.startsWith("/") ? route.path : `/${route.path}`;
      out.push({ path: `${base}${suffix}`, element: route.element, appId: mod.id });
    }
  }
  return out;
}

export interface ResolvedWidget {
  appId: string;
  widget: WidgetDefinition;
}

export function resolveWidgets(modules: FrontendAppModule[]): ResolvedWidget[] {
  return modules.flatMap((mod) => (mod.widgets ?? []).map((widget) => ({ appId: mod.id, widget })));
}
