/**
 * Migration CLI (doc §5.3):
 *   npm run migration:up
 *   npm run migration:status
 *   npm run migration:create -- --scope assets --name add_items
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../core/logging/index.js";
import { findRepoRoot, loadConfig } from "../core/config/index.js";
import { appliedMigrations, runMigrations, type MigrationTarget } from "../core/database/migrate.js";
import { appMigrationTargets, coreMigrationTarget } from "../core/database/startup-migrations.js";
import { scanApps } from "../core/app-registry/scanner.js";

const log = createLogger(process.env.LOG_LEVEL?.toLowerCase() ?? "warn");
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://personal_platform:change-me-for-local-development@localhost:5432/personal_platform";

function usage(): never {
  console.log(`Usage:
  npm run migration:up                                  Run core + installed app migrations
  npm run migration:status                              List scopes and applied migrations
  npm run migration:create -- --scope <core|app_id> --name <name>   Create a SQL migration stub
`);
  process.exit(1);
}

async function targetsForStatus(root: string, appsDir: string): Promise<MigrationTarget[]> {
  // Status lists every scope that ships migrations, enabled or not.
  const targets: MigrationTarget[] = [coreMigrationTarget(root)];
  for (const app of scanApps(appsDir)) {
    if (!app.manifest) continue;
    const dir = join(appsDir, app.directory, "migrations");
    if (existsSync(dir)) targets.push({ scope: app.manifest.id, schema: app.manifest.id, dir });
  }
  return targets;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = findRepoRoot();
  const config = loadConfig();
  const appsDir = join(root, config.apps.manifests_directory);

  if (command === "create") {
    const scope = argValue(args, "--scope") ?? usage();
    const name = argValue(args, "--name");
    if (!name || !/^[a-z0-9_]+$/.test(name)) {
      console.error("--name is required and must use lowercase letters, digits and underscores");
      process.exit(1);
    }
    const dir =
      scope === "core"
        ? join(root, "migrations", "core")
        : (() => {
            const appDir = join(appsDir, scope, "migrations");
            if (!existsSync(appDir)) {
              console.error(`unknown scope "${scope}": no migrations directory at ${appDir}`);
              process.exit(1);
            }
            return appDir;
          })();
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const file = join(dir, `${timestamp}-${name}.sql`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `-- migration: ${name} (scope: ${scope})\n-- Write forward-only SQL below.\n`);
    console.log(`created ${file}`);
    return;
  }

  if (command === "status") {
    const targets = await targetsForStatus(root, appsDir);
    for (const target of targets) {
      let applied: string[] = [];
      try {
        applied = await appliedMigrations(databaseUrl, target.schema);
      } catch {
        applied = [];
      }
      console.log(`[${target.scope}] schema=${target.schema} dir=${target.dir}`);
      if (applied.length === 0) {
        console.log("  (no migrations applied)");
      } else {
        for (const name of applied) console.log(`  ✓ ${name}`);
      }
    }
    return;
  }

  if (command === "up") {
    try {
      await runMigrations({ databaseUrl, targets: [coreMigrationTarget(root)], log });
      const appTargets = await appMigrationTargets(appsDir);
      if (appTargets.length > 0) {
        await runMigrations({ databaseUrl, targets: appTargets, log });
      }
      console.log(
        `migrations up to date (scopes: ${[coreMigrationTarget(root), ...appTargets].map((t) => t.scope).join(", ")})`,
      );
    } finally {
      // nothing to close; migrations use their own short-lived clients
    }
    return;
  }

  usage();
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
