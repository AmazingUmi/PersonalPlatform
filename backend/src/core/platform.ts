import { join } from "node:path";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { AppError, notFoundHandler, errorHandler } from "./api/errors.js";
import { registerCoreRoutes } from "./api/routes.js";
import type { PlatformConfig } from "./config/index.js";
import type { Database } from "./database/index.js";
import { EventBus } from "./events/index.js";
import type { Logger } from "./logging/index.js";
import { Scheduler } from "./scheduler/index.js";
import { isValidTimezone } from "./time/index.js";
import { createTimeService, type PlatformTimeService } from "./time/index.js";
import { createAppContext } from "./app-registry/context.js";
import { AppRegistry } from "./app-registry/registry.js";
import type { AppContext, AppHealth, AppRecord, BackendAppModule } from "./app-registry/types.js";

export const TIMEZONE_SETTING_KEY = "platform.timezone";

export interface Platform {
  app: FastifyInstance;
  getApps(): AppRecord[];
  getApp(id: string): AppRecord | undefined;
  setAppEnabled(id: string, enabled: boolean): Promise<AppRecord>;
  getAppHealth(id: string): Promise<{ statusCode: number; body: unknown }>;
  /** Effective platform timezone (FP-10). */
  timezone(): string;
  stop(): Promise<void>;
}

export interface PlatformDeps {
  config: PlatformConfig;
  root: string;
  log: Logger;
  database: Database | null;
  backendModules: Record<string, BackendAppModule>;
  frontendAppIds?: string[];
  /** Runs after registry init and route registration, before apps activate. */
  beforeActivation?: () => Promise<void>;
  /**
   * Applies pending migrations for one app. Called during runtime enable so
   * activation never runs against an outdated schema (FP-1.1).
   */
  migrateApp?: (appId: string) => Promise<void>;
}

export async function createPlatform(deps: PlatformDeps): Promise<Platform> {
  const { config, root, log, database, backendModules } = deps;
  const storageRoot = join(root, config.storage.root);

  const eventBus = new EventBus(log);
  const scheduler = new Scheduler(log);
  const time = createTimeService({ defaultTimezone: config.platform.timezone ?? "UTC" });
  const registry = new AppRegistry({
    manifestsDir: join(root, config.apps.manifests_directory),
    database,
    configEnabled: config.apps.enabled,
    backendModules,
    frontendAppIds: deps.frontendAppIds ?? [],
    log,
  });
  await registry.init();

  // The persisted setting wins over the config default so the user's runtime
  // choice survives restarts (FP-10.1).
  if (database) {
    try {
      const result = await database
        .context()
        .query<{ value: unknown }>("SELECT value FROM core.settings WHERE key = $1", [
          TIMEZONE_SETTING_KEY,
        ]);
      const stored = result.rows[0]?.value;
      if (typeof stored === "string" && isValidTimezone(stored)) time.setTimezone(stored);
    } catch {
      // Fresh database or missing table: keep the config default.
    }
  }

  const contexts = new Map<string, AppContext>();

  const app: FastifyInstance = Fastify({
    loggerInstance: log as FastifyBaseLogger,
    requestIdHeader: "x-request-id",
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  /**
   * Unified route guard: only apps with status "enabled" serve traffic.
   * Disabled, installed and error apps all answer 404 so the API surface
   * never leaks internal app state (doc §4.4).
   */
  function lifecycleGuard(reg: AppRegistry, appId: string) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!reg.isEnabled(appId)) {
        reply
          .code(404)
          .send({ error: { code: "not_found", message: "Not Found", requestId: request.id } });
      }
    };
  }

  // Register API routes for every installed app with a compiled backend module.
  // A lifecycle guard makes disabled/error apps return 404/503 without unloading
  // Fastify's static routes.
  for (const record of registry.getApps()) {
    const mod = backendModules[record.id];
    if (!mod) continue;
    const appId = record.id;
    await app.register(async (instance) => {
      const ctx = createAppContext({
        appId,
        api: instance,
        log,
        database,
        storageRoot,
        events: eventBus,
        scheduler,
        time,
        capabilities: record.capabilities,
      });
      contexts.set(appId, ctx);
      instance.addHook("onRequest", lifecycleGuard(registry, appId));
      try {
        await mod.registerApi(ctx);
      } catch (error) {
        log.error({ error, appId }, "app registerApi failed");
        await registry.markError(appId, `registerApi failed: ${(error as Error).message}`);
      }
    }, { prefix: `/api/apps/${appId}` });
  }

  registerCoreRoutes(app, {
    database,
    handlers: { getApps, setAppEnabled, getAppHealth, getSetting, putSetting },
    platform: { name: config.platform.name, environment: config.platform.environment },
    time: { timezone: () => time.timezone() },
  });

  // Force plugin bodies to run so every AppContext is populated before activation.
  await app.ready();

  /**
   * Reclaim every runtime resource an app owns. Owner-tagged subscriptions and
   * jobs are removed even when the app's register*() threw halfway and never
   * returned its handles (FP-9.1) — deactivation must not depend on a
   * successful registration.
   */
  function releaseAppResources(appId: string): void {
    eventBus.unsubscribeByOwner(appId);
    scheduler.stopByOwner(appId);
  }

  async function activateApp(appId: string): Promise<void> {
    const mod = backendModules[appId];
    const ctx = contexts.get(appId);
    if (!mod || !ctx) return;

    // Clear leftovers from a previously failed activation of this app.
    releaseAppResources(appId);

    try {
      if (mod.registerEvents) await mod.registerEvents(ctx);
    } catch (error) {
      await registry.markError(appId, `registerEvents failed: ${(error as Error).message}`);
      releaseAppResources(appId);
      return;
    }

    try {
      if (mod.registerJobs) await mod.registerJobs(ctx);
    } catch (error) {
      await registry.markError(appId, `registerJobs failed: ${(error as Error).message}`);
      releaseAppResources(appId);
    }
  }

  if (deps.beforeActivation) {
    await deps.beforeActivation();
  }

  for (const record of registry.getApps()) {
    if (record.status === "enabled") await activateApp(record.id);
  }
  scheduler.start();

  function getApps(): AppRecord[] {
    return registry.getApps();
  }

  function getApp(id: string): AppRecord | undefined {
    return registry.get(id);
  }

  async function setAppEnabled(id: string, enabled: boolean): Promise<AppRecord> {
    const record = await registry.setEnabled(id, enabled);
    releaseAppResources(id);
    if (record.status === "enabled") {
      try {
        if (deps.migrateApp) await deps.migrateApp(id);
      } catch (error) {
        log.error({ error, appId: id }, "app migration during enable failed");
        await registry.markError(id, `migration failed: ${(error as Error).message}`);
      }
      if (registry.getStatus(id) === "enabled") await activateApp(id);
    }
    // Activation/migration may have flipped the record to error; always return
    // the registry's final current state so the API never reports a stale
    // "enabled" record after a failed enable (FP-1.2).
    return registry.get(id) ?? record;
  }

  async function getSetting(key: string): Promise<{ key: string; value: unknown } | null> {
    if (!database) throw new AppError(503, "database_unavailable", "database is not available");
    const result = await database
      .context()
      .query<{ value: unknown }>("SELECT value FROM core.settings WHERE key = $1", [key]);
    const row = result.rows[0];
    return row === undefined ? null : { key, value: row.value };
  }

  async function putSetting(key: string, value: unknown): Promise<{ key: string; value: unknown }> {
    if (!database) throw new AppError(503, "database_unavailable", "database is not available");
    // The platform timezone is validated and applied live (FP-10.1).
    if (key === TIMEZONE_SETTING_KEY) {
      if (typeof value !== "string" || !isValidTimezone(value)) {
        throw new AppError(
          422,
          "invalid_timezone",
          "value must be a valid IANA timezone name (e.g. Asia/Shanghai), not an offset like UTC+8",
        );
      }
    }
    await database
      .context()
      .query(
        `INSERT INTO core.settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    if (key === TIMEZONE_SETTING_KEY) time.setTimezone(value as string);
    return { key, value };
  }

  async function getAppHealth(
    id: string,
  ): Promise<{ statusCode: number; body: unknown }> {
    const record = registry.get(id);
    if (!record || record.status !== "enabled") {
      return {
        statusCode: 404,
        body: { error: { code: "not_found", message: "Not Found" } },
      };
    }
    const mod = backendModules[id];
    const ctx = contexts.get(id);
    let health: AppHealth = { status: "ok", checks: {} };
    if (mod?.healthcheck && ctx) {
      try {
        health = await mod.healthcheck(ctx);
      } catch (error) {
        return {
          statusCode: 503,
          body: {
            status: "error",
            checks: { healthcheck: { status: "error", message: (error as Error).message } },
          },
        };
      }
    }
    return { statusCode: health.status === "error" ? 503 : 200, body: health };
  }

  async function stop(): Promise<void> {
    await app.close();
    for (const record of registry.getApps()) releaseAppResources(record.id);
    scheduler.stopAll();
    eventBus.close();
  }

  return { app, getApps, getApp, setAppEnabled, getAppHealth, timezone: () => time.timezone(), stop };
}
