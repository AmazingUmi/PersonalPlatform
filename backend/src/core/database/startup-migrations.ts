import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logging/index.js";
import { scanApps } from "../app-registry/scanner.js";
import type { Database } from "./index.js";
import { runMigrations, type MigrationTarget } from "./migrate.js";

export function coreMigrationTarget(root: string): MigrationTarget {
  return { scope: "core", schema: "core", dir: join(root, "migrations", "core") };
}

/**
 * App migration targets for every ENABLED app that ships a migrations dir.
 * Disabled apps keep their data untouched: no migration, no rollback.
 */
export async function appMigrationTargets(
  root: string,
  manifestsDir: string,
  database: Database,
  configEnabled: Record<string, boolean>,
): Promise<MigrationTarget[]> {
  const scanned = scanApps(manifestsDir).filter((app) => app.manifest !== null && app.errors.length === 0);
  const { rows } = await database
    .context()
    .query<{ id: string; enabled: boolean }>("SELECT id, enabled FROM core.apps");
  const persisted = new Map(rows.map((row: { id: string; enabled: boolean }) => [row.id, row.enabled]));

  const targets: MigrationTarget[] = [];
  for (const app of scanned) {
    const manifest = app.manifest!;
    const enabled = persisted.has(manifest.id)
      ? persisted.get(manifest.id)!
      : (configEnabled[manifest.id] ?? manifest.default_enabled);
    if (!enabled) continue;
    const dir = join(manifestsDir, app.directory, "migrations");
    if (!existsSync(dir)) continue;
    targets.push({ scope: manifest.id, schema: manifest.id, dir });
  }
  // Stable order: app id ascending (doc §5.3).
  return targets.sort((a, b) => a.scope.localeCompare(b.scope));
}

export async function runCoreMigrations(options: {
  databaseUrl: string;
  root: string;
  log?: Logger;
}): Promise<void> {
  await runMigrations({
    databaseUrl: options.databaseUrl,
    targets: [coreMigrationTarget(options.root)],
    log: options.log,
  });
}

export async function runAppMigrations(options: {
  databaseUrl: string;
  root: string;
  manifestsDir: string;
  database: Database;
  configEnabled?: Record<string, boolean>;
  log?: Logger;
}): Promise<string[]> {
  const targets = await appMigrationTargets(
    options.root,
    options.manifestsDir,
    options.database,
    options.configEnabled ?? {},
  );
  await runMigrations({ databaseUrl: options.databaseUrl, targets, log: options.log });
  return targets.map((target) => target.scope);
}
