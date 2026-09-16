/**
 * Core auth API (AUTH-1): server-side session login/logout/me plus the
 * minimal admin user-management surface. The session token travels only in
 * an HttpOnly cookie (SameSite=Lax; Secure in production) — the response
 * body never contains it.
 */
import type { FastifyInstance } from "fastify";
import { AppError } from "../api/errors.js";
import type { Database } from "../database/index.js";
import { createRequireAdmin, createRequireAuth } from "./guard.js";
import { LoginRateLimiter } from "./ratelimit.js";
import {
  createUser,
  InvalidUsernameError,
  listUsers,
  login,
  logout,
  UsernameTakenError,
  WeakPasswordError,
} from "./service.js";
import { MIN_PASSWORD_LENGTH } from "./passwords.js";
import { SESSION_COOKIE_NAME } from "./sessions.js";

export interface AuthRouteDeps {
  database: Database | null;
  /**
   * Secure cookie flag (AUTH-H1-02) — resolved from SESSION_COOKIE_SECURE /
   * PLATFORM_ENVIRONMENT / yaml, never from request headers, so plain-HTTP
   * development works and production HTTPS cannot silently downgrade.
   */
  sessionCookieSecure: boolean;
  now?: () => Date;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const requireAuth = createRequireAuth({ database: deps.database, now: deps.now });
  const requireAdmin = createRequireAdmin({ database: deps.database, now: deps.now });
  const limiter = new LoginRateLimiter();
  const now = (): Date => deps.now?.() ?? new Date();


  app.post<{ Body: { username: string; password: string } }>(
    "/api/core/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 1, maxLength: 64 },
            password: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!deps.database) {
        throw new AppError(503, "database_unavailable", "database is not available");
      }
      const key = `${request.body.username}|${request.ip}`;
      const at = now();
      limiter.prune(at);
      if (limiter.isBlocked(key, at)) {
        throw new AppError(429, "too_many_attempts", "too many failed login attempts; retry later");
      }
      const result = await login(deps.database.context(), request.body, at);
      if (!result) {
        limiter.recordFailure(key, at);
        throw new AppError(401, "invalid_credentials", "invalid username or password");
      }
      limiter.reset(key);
      reply.setCookie(SESSION_COOKIE_NAME, result.token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: deps.sessionCookieSecure,
        expires: result.expiresAt,
      });
      return { user: result.user };
    },
  );

  // Idempotent logout (AUTH-H1-04): NO auth guard. An expired or bogus
  // session must still end with a cleared cookie and 204 — otherwise a client
  // whose session already lapsed can never log out of it. The session delete
  // is best-effort; the response never reveals whether the token was valid.
  app.post("/api/core/auth/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (token && deps.database) {
      await logout(deps.database.context(), token).catch((error: unknown) => {
        request.log.error({ err: error }, "logout session delete failed (cookie still cleared)");
      });
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/core/auth/me", { onRequest: [requireAuth] }, async (request) => request.user!);

  // ---- admin user management (minimal real-multi-user surface) -------------
  // Regular accounts only; admins exist solely via bootstrap.

  app.get("/api/core/auth/users", { onRequest: [requireAdmin] }, async () => {
    if (!deps.database) throw new AppError(503, "database_unavailable", "database is not available");
    return { items: await listUsers(deps.database.context()) };
  });

  app.post<{ Body: { username: string; password: string; displayName?: string | null } }>(
    "/api/core/auth/users",
    {
      onRequest: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 3, maxLength: 32 },
            password: { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: 256 },
            displayName: { type: ["string", "null"], maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!deps.database) throw new AppError(503, "database_unavailable", "database is not available");
      try {
        const user = await createUser(deps.database.context(), request.body);
        return reply.code(201).send({ user });
      } catch (error) {
        if (error instanceof InvalidUsernameError) {
          throw new AppError(400, "invalid_username", error.message);
        }
        if (error instanceof WeakPasswordError) {
          throw new AppError(400, "weak_password", error.message);
        }
        if (error instanceof UsernameTakenError) {
          throw new AppError(422, "username_taken", error.message);
        }
        throw error;
      }
    },
  );
}
