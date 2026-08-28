import type { FastifyInstance } from "fastify";
import type { Database } from "../database/index.js";
import type { AppRecord } from "../app-registry/types.js";

export interface CoreApiHandlers {
  getApps(): AppRecord[];
  setAppEnabled(id: string, enabled: boolean): Promise<AppRecord>;
  getAppHealth(id: string): Promise<{ statusCode: number; body: unknown }>;
  getSetting(key: string): Promise<{ key: string; value: unknown } | null>;
  putSetting(key: string, value: unknown): Promise<{ key: string; value: unknown }>;
}

export function registerCoreRoutes(
  app: FastifyInstance,
  deps: {
    database: Database | null;
    handlers: CoreApiHandlers;
    platform: { name: string; environment: string };
  },
): void {
  app.get("/api/core/health/live", async () => ({
    status: "ok",
    service: "personal-platform-backend",
  }));

  app.get("/api/core/platform", async () => ({
    name: deps.platform.name,
    environment: deps.platform.environment,
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

  app.get("/api/core/apps", async () => ({
    items: deps.handlers.getApps(),
  }));

  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/core/apps/:id/enabled",
    {
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

  app.get<{ Params: { id: string } }>("/api/core/apps/:id/health", async (request, reply) => {
    const result = await deps.handlers.getAppHealth(request.params.id);
    return reply.code(result.statusCode).send(result.body);
  });

  // Platform settings store (dashboard layout etc.). Values are arbitrary JSON.
  const settingsSchema = {
    params: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string", pattern: "^[a-z0-9_.-]+$" } },
    },
  };

  app.get<{ Params: { key: string } }>("/api/core/settings/:key", { schema: settingsSchema }, async (request, reply) => {
    const setting = await deps.handlers.getSetting(request.params.key);
    if (setting === null) return reply.code(404).send({ error: { code: "setting_not_found", message: "Setting not found", requestId: request.id } });
    return setting;
  });

  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    "/api/core/settings/:key",
    {
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
