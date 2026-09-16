/**
 * Auth guards (AUTH-1). One resolution per request: the guard resolves the
 * cookie token against core.sessions and decorates `request.user`; handlers
 * and ctx.auth read the decoration without touching cookies or the session
 * store. Failure responses use the platform error envelope.
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

async function resolveRequestUser(
  request: FastifyRequest,
  deps: AuthGuardDeps,
): Promise<AuthUserView | null> {
  if (!deps.database) return null;
  const token = request.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return null;
  return resolveSession(deps.database.context(), token, deps.now?.() ?? new Date());
}

/** `onRequest` hook: reject unauthenticated requests with 401. */
export function createRequireAuth(deps: AuthGuardDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.database) {
      sendError(reply, 503, "database_unavailable", "database is not available", request.id);
      return;
    }
    const user = await resolveRequestUser(request, deps).catch(() => null);
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
    if (!deps.database) {
      sendError(reply, 503, "database_unavailable", "database is not available", request.id);
      return;
    }
    const user = await resolveRequestUser(request, deps).catch(() => null);
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
