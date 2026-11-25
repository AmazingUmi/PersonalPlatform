import type { FastifyInstance, onRequestHookHandler } from "fastify";
import { AppError } from "../api/errors.js";
import type { TrashService } from "./service.js";

interface TrashQuery {
  appId?: string;
  limit?: number;
  offset?: number;
}

export function registerTrashRoutes(api: FastifyInstance, service: TrashService | null, requireAuth: onRequestHookHandler): void {
  const trash = () => {
    if (!service) throw new AppError(503, "database_unavailable", "database is not available");
    return service;
  };

  api.get<{ Querystring: TrashQuery }>("/api/core/trash", {
    onRequest: requireAuth,
    schema: {
      querystring: {
        type: "object", additionalProperties: false,
        properties: {
          appId: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 100 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          offset: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
        },
      },
    },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return trash().list(request, request.query);
  });

  api.post<{ Params: { id: string } }>("/api/core/trash/:id/restore", { onRequest: requireAuth }, async request => {
    return trash().restore(request, request.params.id);
  });

  api.delete<{ Params: { id: string } }>("/api/core/trash/:id", { onRequest: requireAuth }, async (request, reply) => {
    await trash().purge(request, request.params.id);
    return reply.code(204).send();
  });

  api.delete("/api/core/trash", { onRequest: requireAuth }, async (request, reply) => {
    await trash().empty(request);
    return reply.code(204).send();
  });
}
