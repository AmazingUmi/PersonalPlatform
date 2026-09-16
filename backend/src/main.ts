import { join } from "node:path";
import { createPlatform } from "./core/platform.js";
import { createLogger } from "./core/logging/index.js";
import { loadConfig, findRepoRoot } from "./core/config/index.js";
import { Database } from "./core/database/index.js";
import { runCoreMigrations, runAppMigrations, singleAppMigrationTarget } from "./core/database/startup-migrations.js";
import { runMigrations } from "./core/database/migrate.js";
import { ensureBootstrapAdmin } from "./core/auth/service.js";
import { migrateLegacyAppStorage } from "./core/storage/legacy-move.js";
import { backendAppModules, frontendAppIds } from "./generated/apps.js";

const root = findRepoRoot();
const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://personal_platform:change-me-for-local-development@localhost:5432/personal_platform";

const log = createLogger(process.env.LOG_LEVEL?.toLowerCase() ?? "info");
const config = loadConfig();
const appsDir = join(root, config.apps.manifests_directory);

const database = new Database(databaseUrl, log);

async function main(): Promise<void> {
  try {
    await database.connect();
    log.info("database connection verified");
  } catch (error) {
    log.fatal(error, "database connection failed; backend will not start");
    await database.close().catch(() => undefined);
    process.exit(1);
  }

  // Core migration must succeed before the registry can read core.apps.
  try {
    await runCoreMigrations({ databaseUrl, root, log });
  } catch (error) {
    log.fatal(error, "core migration failed; backend will not start");
    await database.close().catch(() => undefined);
    process.exit(1);
  }

  // Bootstrap the admin account (AUTH-1): activates the seeded placeholder
  // when BOOTSTRAP_ADMIN_USERNAME/PASSWORD are provided; idempotent and never
  // resets an already-activated password. Must run BEFORE app migrations so
  // legacy data backfills to the operator's (stable-id) account.
  try {
    const outcome = await ensureBootstrapAdmin(database.context(), {
      username: process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || undefined,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      log,
    });
    if (outcome.action !== "noop") log.info({ username: outcome.username, action: outcome.action }, "bootstrap admin account ready");
  } catch (error) {
    log.fatal(error, "bootstrap admin failed; backend will not start");
    await database.close().catch(() => undefined);
    process.exit(1);
  }

  // One-time legacy storage relocation (AUTH-4): move pre-multi-user files
  // from storage/apps/<appId> into the bootstrap owner's user-scoped root
  // BEFORE the platform activates — the assets boot reconcile must never see
  // legacy-path files as missing. Failure is fatal (worklist amendment 1);
  // the routine is idempotent, so a crash midway safely re-runs.
  try {
    await migrateLegacyAppStorage({
      database,
      storageRoot: join(root, config.storage.root),
      log,
    });
  } catch (error) {
    log.fatal(error, "legacy storage migration failed; backend will not start");
    await database.close().catch(() => undefined);
    process.exit(1);
  }

  const platform = await createPlatform({
    config,
    root,
    log,
    database,
    backendModules: backendAppModules,
    frontendAppIds,
    // App migrations follow every valid INSTALLED app (enabled or disabled),
    // after the registry persisted the scan results (inside createPlatform)
    // and before apps activate. Runtime enables re-run pending migrations for
    // that app so activation never sees an outdated schema.
    migrateApp: async (appId) => {
      const target = singleAppMigrationTarget(appsDir, appId);
      if (!target) return;
      await runMigrations({ databaseUrl, targets: [target], log });
    },
    beforeActivation: async () => {
      try {
        const scopes = await runAppMigrations({ databaseUrl, manifestsDir: appsDir, log });
        if (scopes.length > 0) log.info({ scopes }, "app migrations applied");
      } catch (error) {
        log.fatal(error, "app migration failed; backend will not start");
        process.exit(1);
      }
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    // Order: stop taking traffic -> stop jobs/subscriptions -> close database.
    try {
      await platform.stop();
      await database.close();
    } catch (error) {
      log.error({ error }, "error during shutdown");
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await platform.app.listen({ host, port });
    log.info({ host, port }, "personal-platform backend started");
  } catch (error) {
    log.fatal(error, "listen failed");
    await platform.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    process.exit(1);
  }
}

main().catch((error) => {
  log.fatal(error, "backend startup failed");
  process.exit(1);
});
