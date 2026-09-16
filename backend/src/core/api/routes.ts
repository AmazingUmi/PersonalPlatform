import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../database/index.js";
import type { AppRecord } from "../app-registry/types.js";

export interface CoreApiHandlers {
  getApps(): AppRecord[];
  setAppEnabled(id: string, enabled: boolean): Promise<AppRecord>;
  getAppHealth(id: string): Promise<{ statusCode: number; body: unknown }>;
  getSetting(key: string): Promise<{ key: string; value: unknown } | null>;
  putSetting(key: string, value: unknown): Promise<{ key: string; value: unknown }>;
}

export type CoreRouteHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerCoreRoutes(
  app: FastifyInstance,
  deps: {
    database: Database | null;
    handlers: CoreApiHandlers;
    platform: { name: string; environment: string };
    time: { timezone(): string };
    /** Auth guards (AUTH-1). Public routes: health/*, platform, time, auth/login. */
    requireAuth: CoreRouteHook;
    requireAdmin: CoreRouteHook;
  },
): void {
  app.get("/api/core/health/live", async () => ({
    status: "ok",
    service: "personal-platform-backend",
  }));

  app.get("/api/core/platform", async () => ({
    platformApiVersion: 1,
    name: deps.platform.name,
    environment: deps.platform.environment,
    timezone: deps.time.timezone(),
  }));

  // Platform time semantics (FP-10): clients and apps read "today" from the
  // same source instead of guessing server vs. user timezone.
  app.get("/api/core/time", async () => ({
    timezone: deps.time.timezone(),
    now: new Date().toISOString(),
  }));

  app.get("/api/core/health/ready", async (request, reply) => {
    const databaseOk = deps.database ? await deps.database.ping() : false;
    if (!databaseOk) {
      return reply.code(503).send({
        status: "error",
        checks: { database: { status: "error", message: "database unavailable" } },
      });
    }
    return {
      status: "ok",
      checks: { database: { status: "ok" } },
    };
  });

  // The app list feeds the shell for every logged-in user (navigation,
  // App Center, dashboard); enabling apps and editing platform settings is
  // the deployment operator's surface (admin).
  app.get("/api/core/apps", { onRequest: [deps.requireAuth] }, async () => ({
    items: deps.handlers.getApps(),
  }));

  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/core/apps/:id/enabled",
    {
      onRequest: [deps.requireAdmin],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
      },
    },
    async (request) => {
      const record = await deps.handlers.setAppEnabled(request.params.id, request.body.enabled);
      return record;
    },
  );

  app.get<{ Params: { id: string } }>("/api/core/apps/:id/health", { onRequest: [deps.requireAuth] }, async (request, reply) => {
    const result = await deps.handlers.getAppHealth(request.params.id);
    return reply.code(result.statusCode).send(result.body);
  });

  // Platform settings store (dashboard layout etc.). Values are arbitrary JSON.
  // Reads are authenticated (the shell reads layout/presentation for every
  // user); writes are the operator's surface — settings stay platform-level
  // by design this phase (worklist AD-4 / spec §16).
  const settingsSchema = {
    params: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string", pattern: "^[a-z0-9_.-]+$" } },
    },
  };

  app.get<{ Params: { key: string } }>("/api/core/settings/:key", { onRequest: [deps.requireAuth], schema: settingsSchema }, async (request, reply) => {
    const setting = await deps.handlers.getSetting(request.params.key);
    if (setting === null) return reply.code(404).send({ error: { code: "setting_not_found", message: "Setting not found", requestId: request.id } });
    return setting;
  });

  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    "/api/core/settings/:key",
    {
      onRequest: [deps.requireAdmin],
      schema: {
        ...settingsSchema,
        body: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: {} },
        },
      },
    },
    async (request) => {
      return deps.handlers.putSetting(request.params.key, request.body.value);
    },
  );
}
