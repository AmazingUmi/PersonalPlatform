/**
 * Auth guards (AUTH-1). One resolution per request: the guard resolves the
 * cookie token against core.sessions and decorates `request.user`; handlers
 * and ctx.auth read the decoration without touching cookies or the session
 * store. Failure responses use the platform error envelope.
 *
 * Failure semantics (AUTH-H1-01): a missing cookie, unknown/expired session
 * or disabled account is an authentication failure (401). A datastore error
 * is an availability failure (503) — it must never masquerade as "no
 * session", or a transient database outage would look like a logged-out
 * user. Internal error details stay in the server log only.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../api/errors.js";
import type { Database } from "../database/index.js";
import { resolveSession, type AuthUserView } from "./service.js";
import { SESSION_COOKIE_NAME } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved identity (set by the auth guard; absent when unauthenticated). */
    user?: AuthUserView;
  }
}

export interface AuthGuardDeps {
  database: Database | null;
  now?: () => Date;
}

class DatastoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super("session resolution failed", { cause });
    this.name = "DatastoreUnavailableError";
  }
}

async function resolveRequestUser(
  request: FastifyRequest,
  deps: AuthGuardDeps,
): Promise<AuthUserView | null> {
  if (!deps.database) return null;
  const token = request.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return null;
  try {
    return await resolveSession(deps.database.context(), token, deps.now?.() ?? new Date());
  } catch (error) {
    throw new DatastoreUnavailableError(error);
  }
}

/** Shared 401/503 decision: datastore errors are availability, not identity. */
async function resolveOrReject(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AuthGuardDeps,
): Promise<AuthUserView | null | undefined> {
  if (!deps.database) {
    sendError(reply, 503, "database_unavailable", "database is not available", request.id);
    return undefined;
  }
  let user: AuthUserView | null;
  try {
    user = await resolveRequestUser(request, deps);
  } catch (error) {
    request.log.error({ err: error }, "auth datastore failure during session resolution");
    sendError(reply, 503, "database_unavailable", "database is not available", request.id);
    return undefined;
  }
  return user;
}

/** `onRequest` hook: reject unauthenticated requests with 401. */
export function createRequireAuth(deps: AuthGuardDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = await resolveOrReject(request, reply, deps);
    if (user === undefined) return;
    if (!user) {
      sendError(reply, 401, "unauthorized", "authentication required", request.id);
      return;
    }
    request.user = user;
  };
}

/** `onRequest` hook: authenticated AND admin (403 for authenticated non-admins). */
export function createRequireAdmin(deps: AuthGuardDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = await resolveOrReject(request, reply, deps);
    if (user === undefined) return;
    if (!user) {
      sendError(reply, 401, "unauthorized", "authentication required", request.id);
      return;
    }
    if (user.role !== "admin") {
      sendError(reply, 403, "forbidden", "administrator role required", request.id);
      return;
    }
    request.user = user;
  };
}
