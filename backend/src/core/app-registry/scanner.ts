import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { semanticErrors, validateManifest } from "./manifest.js";
import type { AppManifest } from "./types.js";

export interface ScannedApp {
  /** Best-effort id (directory name when the manifest cannot be parsed). */
  id: string;
  directory: string;
  manifest: AppManifest | null;
  errors: string[];
}

/**
 * Discover `app.yaml` files under the manifests directory. Directories starting
 * with `_` (e.g. the app template) are ignored.
 */
export function scanApps(manifestsDir: string): ScannedApp[] {
  const entries = readdirSync(manifestsDir, { withFileTypes: true });
  const results: ScannedApp[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const manifestPath = join(manifestsDir, entry.name, "app.yaml");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf8");
      const parsed = parse(raw) as unknown;
      const result = validateManifest(parsed);
      if (!result.ok) {
        const fallbackId =
          typeof parsed === "object" && parsed !== null && "id" in parsed
            ? String((parsed as Record<string, unknown>)["id"])
            : entry.name;
        results.push({ id: fallbackId, directory: entry.name, manifest: null, errors: result.errors });
        continue;
      }
      const errors = semanticErrors(result.manifest);
      results.push({
        id: result.manifest.id,
        directory: entry.name,
        manifest: result.manifest,
        errors,
      });
    } catch (error) {
      results.push({
        id: entry.name,
        directory: entry.name,
        manifest: null,
        errors: [`failed to read manifest: ${String(error)}`],
      });
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/** Report duplicate app ids across scanned apps. */
export function duplicateIds(apps: ScannedApp[]): string[] {
  const seen = new Map<string, number>();
  for (const app of apps) seen.set(app.id, (seen.get(app.id) ?? 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}
