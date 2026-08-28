import { describe, expect, it } from "vitest";
import type { AppInfo } from "../shared/api";
import type { FrontendAppModule } from "../shared/appTypes";
import { enabledAppModules, resolveRoutes, resolveWidgets } from "./routes";

function appInfo(id: string, status: AppInfo["status"] = "enabled", route = `/${id}`): AppInfo {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "",
    status,
    enabled: status === "enabled",
    defaultEnabled: true,
    route,
    capabilities: { database: true, storage: false, scheduler: false, events: false },
    widgets: [],
    hasBackend: true,
    hasFrontend: true,
  };
}

describe("resolveRoutes", () => {
  it("combines the manifest route with relative module paths", () => {
    const modules: FrontendAppModule[] = [
      {
        id: "assets",
        routes: [
          { path: "", label: "Assets", element: "list" },
          { path: "/items/:id", label: "Detail", element: "detail" },
        ],
      },
    ];
    const routes = resolveRoutes(modules, [appInfo("assets")]);
    expect(routes.map((r) => r.path)).toEqual(["/assets", "/assets/items/:id"]);
  });

  it("skips modules whose app is missing from the app list", () => {
    const modules: FrontendAppModule[] = [{ id: "assets", routes: [{ path: "", label: "A", element: "x" }] }];
    expect(resolveRoutes(modules, [])).toHaveLength(0);
  });
});

describe("resolveWidgets", () => {
  it("flattens widgets across modules", () => {
    const modules: FrontendAppModule[] = [
      { id: "assets", routes: [], widgets: [{ id: "summary", title: "Summary", render: () => null }] },
      { id: "tasks", routes: [], widgets: [{ id: "today", title: "Today", render: () => null }] },
    ];
    expect(resolveWidgets(modules)).toHaveLength(2);
  });
});

describe("enabledAppModules", () => {
  it("returns only modules whose app is enabled", () => {
    const modules = enabledAppModules([appInfo("assets"), appInfo("tasks", "disabled")]);
    expect(modules.map((m) => m.id)).toEqual(["assets"]);
  });
});
