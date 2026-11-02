import type { FastifyInstance } from "fastify";
import type { Database } from "../database/index.js";
import type { CoreRouteHook } from "../api/routes.js";
import { AppError } from "../api/errors.js";
import { exportSnapshot, importSnapshot, previewSnapshot, MAX_SNAPSHOT_BYTES } from "./snapshot.js";
import { WebdavBackups, checkScope, type BackupScope, type WebdavInput, type BackupMode, type WebdavTestInput } from "./webdav.js";
import type { ContinuousSync } from "./sync-service.js";

const scopeSchema = { type: "string", enum: ["own", "all"] };

export function registerDataManagementRoutes(app: FastifyInstance, deps: {
  database: Database | null; storageRoot: string; installedApps: () => string[];
  requireAuth: CoreRouteHook; backups: WebdavBackups | null; sync?: ContinuousSync | null;
}): void {
  const hooks = { onRequest: [deps.requireAuth] };
  const database = () => {
    if (!deps.database) throw new AppError(503, "database_unavailable", "Database is not available.");
    return deps.database;
  };
  const backups = () => {
    if (!deps.backups) throw new AppError(503, "database_unavailable", "Database is not available.");
    return deps.backups;
  };
  const sync = () => {
    if (!deps.sync) throw new AppError(503, "database_unavailable", "Database is not available.");
    return deps.sync;
  };
  const token = (request: { cookies?: Record<string, string | undefined> }) => request.cookies?.pp_session ?? "";
  app.get<{ Querystring: { scope?: BackupScope } }>("/api/core/data/export", {
    ...hooks, schema: { querystring: { type: "object", additionalProperties: false, properties: { scope: scopeSchema } } },
  }, async (request, reply) => {
    const scope = request.query.scope ?? "own";
    checkScope(request.user!, scope);
    const snapshot = await exportSnapshot({ database: database(), storageRoot: deps.storageRoot, actor: request.user!, scope, installedApps: deps.installedApps() });
    return reply.header("cache-control", "no-store").header("content-disposition", `attachment; filename="personal-platform-${scope}.json"`).type("application/json").send(snapshot);
  });
  for (const [action, handler] of [["preview", previewSnapshot], ["import", importSnapshot]] as const) {
    app.post<{ Body: { scope: BackupScope; snapshot: unknown } }>(`/api/core/data/${action}`, {
      ...hooks, bodyLimit: MAX_SNAPSHOT_BYTES + 1024,
      schema: { body: { type: "object", required: ["scope", "snapshot"], additionalProperties: false, properties: { scope: scopeSchema, snapshot: { type: "object" } } } },
    }, async request => {
      checkScope(request.user!, request.body.scope);
      return handler({ database: database(), storageRoot: deps.storageRoot, actor: request.user!, scope: request.body.scope, snapshot: request.body.snapshot, installedApps: deps.installedApps() });
    });
  }
  app.get("/api/core/data/webdav", hooks, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return backups().config(request.user!);
  });
  app.put<{ Body: WebdavInput }>("/api/core/data/webdav", {
    ...hooks, schema: { body: { type: "object", required: ["endpoint", "username", "scope", "intervalHours"], additionalProperties: false,
      properties: { endpoint: { type: "string", minLength: 1, maxLength: 2048 }, username: { type: "string", minLength: 1, maxLength: 512 }, password: { type: "string", minLength: 1, maxLength: 4096 }, scope: scopeSchema, intervalHours: { type: "integer", enum: [0,1,6,12,24,168] } } } },
  }, request => backups().save(request.user!, request.body));
  app.delete("/api/core/data/webdav", hooks, async (request, reply) => {
    await backups().remove(request.user!); return reply.code(204).send();
  });
  app.post<{ Body: Partial<WebdavTestInput> }>("/api/core/data/webdav/test", {
    ...hooks, schema: { body: { type: "object", additionalProperties: true, properties: {
      endpoint: { type: "string", minLength: 1, maxLength: 2048 },
      username: { type: "string", minLength: 1, maxLength: 512 },
      password: { type: "string", minLength: 1, maxLength: 4096 },
    } } },
  }, request => backups().test(request.user!, request.body));
  app.post<{Body: {mode?: BackupMode}}>("/api/core/data/webdav/backup", {
    ...hooks, schema: { body: { type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: ["incremental", "full"] } } } },
  }, request => backups().run(request.user!, false, request.body.mode ?? "incremental"));
  app.get("/api/core/data/webdav/history", hooks, request => backups().history(request.user!));
  app.get<{ Params: { id: string } }>("/api/core/data/webdav/files/:id", {
    ...hooks, schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } },
  }, async (request, reply) => {
    const file = await backups().download(request.user!, request.params.id);
    return reply.header("cache-control", "no-store").header("content-disposition", `attachment; filename="${file.filename}"`).type("application/json").send(file.data);
  });
  app.get("/api/core/data/sync", hooks, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return sync().status(request.user!.id);
  });
  app.post<{ Body: { action?: string; pairingCode?: string } }>("/api/core/data/sync", {
    ...hooks, schema: { body: { type: "object", required: ["action"], additionalProperties: true, properties: {
      action: { type: "string", enum: ["create", "join"] }, pairingCode: { type: "string", minLength: 8, maxLength: 512 },
    } } },
  }, async request => {
    if (request.body.action === "create") {
      const extra = Object.keys(request.body).filter(key => key !== "action");
      if (extra.length || request.body.pairingCode !== undefined) throw new AppError(400, "validation_error", "Create does not take a pairing code.");
      return sync().create(request.user!.id, token(request));
    }
    if (!request.body.pairingCode) throw new AppError(422, "invalid_pairing_code", "Enter the pairing code from the account that created this sync identity.");
    return sync().join(request.user!.id, token(request), request.body.pairingCode);
  });
  app.put<{ Body: { enabled?: boolean; intervalSeconds?: number } }>("/api/core/data/sync", {
    ...hooks, schema: { body: { type: "object", additionalProperties: false, properties: {
      enabled: { type: "boolean" }, intervalSeconds: { type: "integer", enum: [0, 60, 120] },
    } } },
  }, request => sync().configure(request.user!.id, token(request), request.body));
  app.delete("/api/core/data/sync", hooks, async (request, reply) => {
    await sync().unlink(request.user!.id, token(request)); return reply.code(204).send();
  });
  app.post("/api/core/data/sync/reveal", hooks, request => sync().reveal(request.user!.id, token(request)));
  app.post("/api/core/data/sync/cycle", hooks, request => sync().cycle(request.user!.id, token(request)));
  app.get("/api/core/data/sync/conflicts", hooks, request => sync().conflicts(request.user!.id));
  app.post<{ Params: { id: string }; Body: { choice?: string } }>("/api/core/data/sync/conflicts/:id", {
    ...hooks, schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      body: { type: "object", required: ["choice"], additionalProperties: false, properties: { choice: { type: "string", enum: ["keep-local", "keep-remote"] } } },
    },
  }, request => sync().resolve(request.user!.id, token(request), request.params.id, request.body.choice as "keep-local" | "keep-remote"));
}
