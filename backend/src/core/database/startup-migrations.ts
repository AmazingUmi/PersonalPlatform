import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logging/index.js";
import { scanApps } from "../app-registry/scanner.js";
import { runMigrations, type MigrationTarget } from "./migrate.js";

export function coreMigrationTarget(root: string): MigrationTarget {
  return { scope: "core", schema: "core", dir: join(root, "migrations", "core") };
}

/** Migration target for one valid installed app, or null if it ships no migrations. */
export function singleAppMigrationTarget(manifestsDir: string, appId: string): MigrationTarget | null {
  const app = scanApps(manifestsDir).find(
    (candidate) => candidate.id === appId && candidate.manifest !== null && candidate.errors.length === 0,
  );
  if (!app) return null;
  const dir = join(manifestsDir, app.directory, "migrations");
  if (!existsSync(dir)) return null;
  return { scope: appId, schema: appId, dir };
}

/**
 * App migration targets for every VALID INSTALLED app that ships a migrations
 * dir. Migrations follow installation, not the enabled flag: a disabled app
 * keeps its schema upgraded (data preserved, no rollback) so a runtime enable
 * can never activate against an outdated schema.
 */
export async function appMigrationTargets(manifestsDir: string): Promise<MigrationTarget[]> {
  const scanned = scanApps(manifestsDir).filter((app) => app.manifest !== null && app.errors.length === 0);

  const targets: MigrationTarget[] = [];
  for (const app of scanned) {
    const manifest = app.manifest!;
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
  manifestsDir: string;
  log?: Logger;
}): Promise<string[]> {
  const targets = await appMigrationTargets(options.manifestsDir);
  await runMigrations({ databaseUrl: options.databaseUrl, targets, log: options.log });
  return targets.map((target) => target.scope);
}
