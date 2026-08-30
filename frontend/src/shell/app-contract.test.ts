/**
 * Frontend-side app contract test (Phase 6 / D5, two-track validation).
 *
 * The frontend module table cannot be loaded under tsx (mini_game imports an
 * svg asset), so the frontend half of the contract is enforced here, where the
 * vite/vitest pipeline resolves those imports (proven by mini_game/index.test.tsx):
 *   - every frontendAppModules entry has a manifest at apps/<id>/app.yaml
 *   - module.id === manifest.id
 *   - module widget ids exactly equal the manifest widget ids (no drift either way)
 *   - every valid manifest that ships a frontend module is present in the table
 *
 * The backend half (module presence + id equality against backendAppModules)
 * lives in scripts/verify-apps.ts (tsx).
 *
 * Repo-root derivation: this file sits at <root>/frontend/src/shell/, so the
 * root is three dirname() hops up from import.meta.url (shell -> src ->
 * frontend -> root). A file-relative path is used instead of process.cwd()
 * because vitest's cwd is frontend/ — the file-relative form stays correct no
 * matter where vitest is invoked from.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { frontendAppModules } from "../generated/apps";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Manifest {
  id: string;
  widgetIds: string[];
}

type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; error: string };

/** Reads apps/<appId>/app.yaml and extracts the fields this test asserts on. */
function loadManifest(appId: string): ManifestResult {
  const manifestPath = join(repoRoot, "apps", appId, "app.yaml");
  if (!existsSync(manifestPath)) {
    return { ok: false, error: `frontendAppModules["${appId}"] has no manifest at apps/${appId}/app.yaml` };
  }
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, error: `apps/${appId}/app.yaml: YAML parse failed: ${String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: `apps/${appId}/app.yaml: manifest must be a mapping` };
  }
  const { id, widgets } = parsed as { id?: unknown; widgets?: unknown };
  if (typeof id !== "string") {
    return { ok: false, error: `apps/${appId}/app.yaml: manifest id must be a string` };
  }
  const widgetList = widgets ?? [];
  if (
    !Array.isArray(widgetList) ||
    widgetList.some((w) => typeof (w as { id?: unknown })?.id !== "string")
  ) {
    return { ok: false, error: `apps/${appId}/app.yaml: widgets must be a list of { id, name }` };
  }
  return {
    ok: true,
    manifest: { id, widgetIds: (widgetList as Array<{ id: string }>).map((w) => w.id) },
  };
}

/** Mirrors generate-apps-registry.ts hasFrontend detection. */
function hasFrontendModule(appId: string): boolean {
  return (
    existsSync(join(repoRoot, "frontend", "src", "apps", appId, "index.tsx")) ||
    existsSync(join(repoRoot, "frontend", "src", "apps", appId, "index.ts"))
  );
}

describe("frontend app contract (manifest <-> frontendAppModules)", () => {
  const moduleIds = Object.keys(frontendAppModules).sort();

  it("every module entry has a valid manifest whose id matches module.id", () => {
    const problems: string[] = [];
    for (const key of moduleIds) {
      const result = loadManifest(key);
      if (!result.ok) {
        problems.push(result.error);
        continue;
      }
      const mod = frontendAppModules[key]!;
      if (mod.id !== result.manifest.id) {
        problems.push(
          `frontendAppModules["${key}"].id is "${mod.id}" but apps/${key}/app.yaml declares "${result.manifest.id}"`,
        );
      }
    }
    expect(problems.join("\n"), "frontend module ids must match their manifests").toBe("");
  });

  it("module widget ids exactly equal the manifest widget ids", () => {
    for (const key of moduleIds) {
      const result = loadManifest(key);
      if (!result.ok) continue; // already reported by the test above
      const manifestIds = [...result.manifest.widgetIds].sort();
      const mod = frontendAppModules[key]!;
      const moduleWidgetIds = (mod.widgets ?? []).map((w) => w.id).sort();
      const missing = manifestIds.filter((id) => !moduleWidgetIds.includes(id));
      const unknown = moduleWidgetIds.filter((id) => !manifestIds.includes(id));
      const details = [
        `module [${moduleWidgetIds.join(", ")}] vs manifest [${manifestIds.join(", ")}]`,
        missing.length > 0 ? `missing in module: ${missing.join(", ")}` : "",
        unknown.length > 0 ? `unknown to manifest: ${unknown.join(", ")}` : "",
        missing.length === 0 && unknown.length === 0 ? "duplicate widget ids on one side" : "",
      ]
        .filter(Boolean)
        .join("; ");
      expect(
        moduleWidgetIds,
        `frontendAppModules["${key}"].widgets must match apps/${key}/app.yaml (${details})`,
      ).toEqual(manifestIds);
    }
  });

  it("every valid manifest that ships a frontend module is present in the table", () => {
    const appsDir = join(repoRoot, "apps");
    const diskIds = readdirSync(appsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(appsDir, name, "app.yaml")))
      // Manifest validity itself is owned by generate:apps; here a manifest we
      // cannot even parse is skipped so the failure surfaces with generate:apps'
      // own diagnostics rather than a confusing diff.
      .flatMap((name) => {
        const result = loadManifest(name);
        return result.ok ? [result.manifest.id] : [];
      })
      .filter((id) => hasFrontendModule(id))
      .sort();
    expect(
      moduleIds,
      `frontendAppModules keys vs manifests with a frontend module on disk [${diskIds.join(", ")}]`,
    ).toEqual(diskIds);
  });
});
