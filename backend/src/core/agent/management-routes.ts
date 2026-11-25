import type { FastifyInstance, onRequestHookHandler, preValidationHookHandler } from "fastify";
import { AppError, sendError } from "../api/errors.js";
import { agentDatastoreError } from "./errors.js";
import type { AgentIdentityService } from "./identity.js";

const base = "/api/core/agents";
const windowMs = 60_000;
const maxBuckets = 4096;

type ManagementService = Pick<AgentIdentityService, "list" | "create" | "rotateToken" | "revokeAgent"
  | "createPairing" | "previewPairing" | "approvePairing" | "narrowGrant" | "revokeGrant" | "audit">;
type CreateBody = Parameters<ManagementService["create"]>[1];
type PairingBody = Parameters<ManagementService["createPairing"]>[2];
type ApprovalBody = Parameters<ManagementService["approvePairing"]>[2] & { code: string };
type GrantPatch = Parameters<ManagementService["narrowGrant"]>[2];
type AuditQuery = NonNullable<Parameters<ManagementService["audit"]>[1]>;

const uuid = { type: "string", format: "uuid" };
const scopes = { type: "array", items: { type: "string", enum: ["read", "write", "delete"] }, minItems: 1, maxItems: 3, uniqueItems: true };
const allowedApps = {
  type: "array", items: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 64 }, maxItems: 100, uniqueItems: true,
};
const expiresAt = { anyOf: [{ type: "string", format: "date-time", maxLength: 64 }, { type: "null" }] };
const code = { type: "string", minLength: 1, maxLength: 256 };
const grantProperties = { scopes, allowedApps, expiresAt };

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", additionalProperties: false, properties, required };
}

const agentParams = schema({ agentId: uuid }, ["agentId"]);
const grantParams = schema({ grantId: uuid }, ["grantId"]);

interface Bucket {
  count: number;
  resetAt: number;
}

class PairingRateLimit {
  private readonly buckets = new Map<string, Bucket>();
  private nextPrune = 0;

  consume(keys: ReadonlyArray<readonly [string, number]>, now: number): number | undefined {
    if (now >= this.nextPrune) {
      this.nextPrune = now + windowMs;
      for (const [key, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(key);
      }
    }
    let retryAt = now;
    let newBuckets = 0;
    for (const [key, limit] of keys) {
      const bucket = this.buckets.get(key);
      if (!bucket) newBuckets += 1;
      else if (bucket.resetAt > now && bucket.count >= limit) retryAt = Math.max(retryAt, bucket.resetAt);
    }
    if (this.buckets.size + newBuckets > maxBuckets) retryAt = Math.max(retryAt, this.nextPrune);
    if (retryAt > now) return Math.ceil((retryAt - now) / 1000);
    for (const [key] of keys) {
      const bucket = this.buckets.get(key);
      if (bucket && bucket.resetAt > now) bucket.count += 1;
      else this.buckets.set(key, { count: 1, resetAt: now + windowMs });
    }
  }
}

const publicMessages: Record<string, string> = {
  unauthorized: "Authentication required.",
  not_found: "Agent or grant not found.",
  validation_error: "Check the submitted Agent settings.",
  pairing_unavailable: "This pairing code is unavailable. Request a new code.",
  grant_already_active: "This Agent already has an active grant for your account.",
  grant_expansion: "An existing grant can only be narrowed.",
  agent_revoked: "This Agent has been revoked.",
  database_unavailable: "The Agent service is unavailable.",
};

export function registerAgentManagement(
  app: FastifyInstance,
  service: ManagementService | null,
  requireAuth: onRequestHookHandler,
): void {
  const management = () => {
    if (!service) throw new AppError(503, "database_unavailable", "The Agent service is unavailable.");
    return service;
  };

  void app.register(async (router) => {
    const limiter = new PairingRateLimit();
    router.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "private, no-store");
    });
    router.addHook("onRequest", requireAuth);
    router.setErrorHandler((error, request, reply) => {
      const retryable = agentDatastoreError(error);
      if (retryable) {
        sendError(reply, retryable.statusCode, retryable.code, retryable.message, request.id);
        return;
      }
      if (error instanceof AppError) {
        const publicMessage = publicMessages[error.code];
        if (publicMessage) {
          sendError(reply, error.statusCode, error.code, publicMessage, request.id);
          return;
        }
      }
      const status = error != null && typeof error === "object" && "statusCode" in error
        && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode : 500;
      if (status >= 400 && status < 500) {
        const invalid = status === 400 || status === 422;
        sendError(reply, status, invalid ? "validation_error" : "request_rejected",
          invalid ? publicMessages.validation_error! : "The Agent request was rejected.", request.id);
        return;
      }
      // Keep database diagnostics, invalid request bodies and all secrets out of the log.
      request.log.error({ requestId: request.id, status }, "agent management request failed");
      sendError(reply, status, "internal_error", "The Agent request could not be completed.", request.id);
    });

    function limitPairing(action: "preview" | "approve" | "generate"): preValidationHookHandler {
      return async (request, reply) => {
        const userId = request.user?.id;
        if (!userId) throw new AppError(401, "unauthorized", "Authentication required.");
        const keys: ReadonlyArray<readonly [string, number]> = action === "generate"
          ? [[`generate:owner:${userId}`, 10]]
          : [[`${action}:user:${userId}`, 20], [`${action}:ip:${request.ip}`, 60]];
        const retry = limiter.consume(keys, Date.now());
        if (retry !== undefined) {
          reply.header("Retry-After", String(retry));
          sendError(reply, 429, "agent_rate_limited", "Too many pairing requests. Try again shortly.", request.id);
        }
      };
    }

    router.get(base, async (request) => management().list(request));

    router.post<{ Body: CreateBody }>(base, {
      bodyLimit: 32_768,
      schema: { body: schema({
        ...grantProperties,
        name: { type: "string", minLength: 1, maxLength: 64 },
        description: { type: "string", maxLength: 5000 },
      }, ["name", "scopes", "allowedApps"]) },
    }, async (request, reply) => reply.code(201).send(await management().create(request, request.body)));

    router.post<{ Params: { agentId: string } }>(`${base}/:agentId/rotate-token`, {
      schema: { params: agentParams },
    }, async (request) => management().rotateToken(request, request.params.agentId));

    router.delete<{ Params: { agentId: string } }>(`${base}/:agentId`, {
      schema: { params: agentParams },
    }, async (request, reply) => {
      await management().revokeAgent(request, request.params.agentId);
      return reply.code(204).send();
    });

    router.post<{ Params: { agentId: string }; Body: PairingBody }>(`${base}/:agentId/pairing-codes`, {
      bodyLimit: 8192, preValidation: limitPairing("generate"),
      schema: { params: agentParams, body: schema({ scopes, allowedApps }, ["scopes", "allowedApps"]) },
    }, async (request, reply) => reply.code(201).send(await management().createPairing(request, request.params.agentId, request.body)));

    router.post<{ Body: { code: string } }>(`${base}/pairings/preview`, {
      bodyLimit: 4096, preValidation: limitPairing("preview"),
      schema: { body: schema({ code }, ["code"]) },
    }, async (request) => management().previewPairing(request, request.body.code));

    router.post<{ Body: ApprovalBody }>(`${base}/pairings/approve`, {
      bodyLimit: 8192, preValidation: limitPairing("approve"),
      schema: { body: schema({ ...grantProperties, code }, ["code", "scopes", "allowedApps"]) },
    }, async (request) => {
      const { code: pairingCode, ...grant } = request.body;
      return management().approvePairing(request, pairingCode, grant);
    });

    router.patch<{ Params: { grantId: string }; Body: GrantPatch }>(`${base}/grants/:grantId`, {
      bodyLimit: 8192,
      schema: { params: grantParams, body: { ...schema(grantProperties), minProperties: 1 } },
    }, async (request) => management().narrowGrant(request, request.params.grantId, request.body));

    router.delete<{ Params: { grantId: string } }>(`${base}/grants/:grantId`, {
      schema: { params: grantParams },
    }, async (request, reply) => {
      await management().revokeGrant(request, request.params.grantId);
      return reply.code(204).send();
    });

    router.get<{ Querystring: AuditQuery }>(`${base}/audit`, {
      schema: { querystring: schema({
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", minLength: 1, maxLength: 256 },
      }) },
    }, async (request) => management().audit(request, request.query));
  });
}
