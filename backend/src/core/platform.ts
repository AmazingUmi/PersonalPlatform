import { join } from "node:path";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { AppError, notFoundHandler, errorHandler } from "./api/errors.js";
import { registerCoreRoutes } from "./api/routes.js";
import type { PlatformConfig } from "./config/index.js";
import type { Database } from "./database/index.js";
import { EventBus } from "./events/index.js";
import type { Logger } from "./logging/index.js";
import { Scheduler } from "./scheduler/index.js";
import { createAppContext } from "./app-registry/context.js";
import { AppRegistry } from "./app-registry/registry.js";
import type { AppContext, AppHealth, AppRecord, BackendAppModule } from "./app-registry/types.js";

export interface Platform {
  app: FastifyInstance;
  getApps(): AppRecord[];
  getApp(id: string): AppRecord | undefined;
  setAppEnabled(id: string, enabled: boolean): Promise<AppRecord>;
  getAppHealth(id: string): Promise<{ statusCode: number; body: unknown }>;
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
}

export async function createPlatform(deps: PlatformDeps): Promise<Platform> {
  const { config, root, log, database, backendModules } = deps;
  const storageRoot = join(root, config.storage.root);

  const eventBus = new EventBus(log);
  const scheduler = new Scheduler(log);
  const registry = new AppRegistry({
    manifestsDir: join(root, config.apps.manifests_directory),
    database,
    configEnabled: config.apps.enabled,
    backendModules,
    frontendAppIds: deps.frontendAppIds ?? [],
    log,
  });
  await registry.init();

  const contexts = new Map<string, AppContext>();
  const eventSubscriptions = new Map<string, Array<() => void>>();
  const jobHandles = new Map<string, Array<{ stop(): void }>>();

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
      });
      contexts.set(appId, ctx);
      instance.addHook("onRequest", lifecycleGuard(registry, appId));
      try {
        await mod.registerApi(ctx);
      } catch (error) {
        log.error({ error, appId }, "app registerApi failed");
        registry.markError(appId, `registerApi failed: ${(error as Error).message}`);
      }
    }, { prefix: `/api/apps/${appId}` });
  }

  registerCoreRoutes(app, {
    database,
    handlers: { getApps, setAppEnabled, getAppHealth, getSetting, putSetting },
    platform: { name: config.platform.name, environment: config.platform.environment },
  });

  // Force plugin bodies to run so every AppContext is populated before activation.
  await app.ready();

  async function activateApp(appId: string): Promise<void> {
    const mod = backendModules[appId];
    const ctx = contexts.get(appId);
    if (!mod || !ctx) return;

    try {
      const subs = mod.registerEvents ? await mod.registerEvents(ctx) : [];
      eventSubscriptions.set(appId, subs);
    } catch (error) {
      registry.markError(appId, `registerEvents failed: ${(error as Error).message}`);
      deactivateApp(appId);
      return;
    }

    try {
      const jobs = mod.registerJobs ? await mod.registerJobs(ctx) : [];
      jobHandles.set(appId, jobs);
    } catch (error) {
      registry.markError(appId, `registerJobs failed: ${(error as Error).message}`);
      deactivateApp(appId);
    }
  }

  function deactivateApp(appId: string): void {
    for (const unsub of eventSubscriptions.get(appId) ?? []) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    eventSubscriptions.delete(appId);
    for (const handle of jobHandles.get(appId) ?? []) {
      try {
        handle.stop();
      } catch {
        /* ignore */
      }
    }
    jobHandles.delete(appId);
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
    deactivateApp(id);
    if (record.status === "enabled") await activateApp(id);
    return record;
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
    await database
      .context()
      .query(
        `INSERT INTO core.settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
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
    for (const appId of contexts.keys()) deactivateApp(appId);
    scheduler.stopAll();
    eventBus.close();
  }

  return { app, getApps, getApp, setAppEnabled, getAppHealth, stop };
}
