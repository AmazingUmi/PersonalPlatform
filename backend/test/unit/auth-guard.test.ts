import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../../src/core/database/index.js";
import { createRequireAdmin, createRequireAuth } from "../../src/core/auth/guard.js";
import { SESSION_COOKIE_NAME } from "../../src/core/auth/sessions.js";

/**
 * AUTH-H1-01 unit coverage: the auth guards must distinguish identity
 * failures (no cookie / unknown session → 401) from datastore failures
 * (query throws → 503 database_unavailable, generic message, no internals
 * leaked to the client). These are the exact guard factories platform.ts
 * wires into onRequest.
 */

type SessionBehavior = "admin" | "user" | "no-session" | "datastore-error";

function fakeDatabase(behavior: SessionBehavior): Database {
  return {
    context: () => ({
      query: async () => {
        if (behavior === "datastore-error") {
          throw new Error("simulated datastore failure: connection reset by peer");
        }
        const rows =
          behavior === "no-session"
            ? []
            : [
                {
                  id: "00000000-0000-0000-0000-000000000001",
                  username: behavior === "admin" ? "admin" : "alice",
                  display_name: null,
                  role: behavior,
                  status: "active",
                  expires_at: new Date(Date.now() + 60_000),
                  last_seen_at: null,
                },
              ];
        return { rows, rowCount: rows.length };
      },
    }),
  } as unknown as Database;
}

interface Captured {
  statusCode?: number;
  body?: { error?: { code?: string; message?: string; requestId?: string } };
}

function fakeRequest(withCookie: boolean): FastifyRequest {
  return {
    id: "req-unit-1",
    cookies: withCookie ? { [SESSION_COOKIE_NAME]: "some-session-token" } : {},
    log: { error: () => undefined },
  } as unknown as FastifyRequest;
}

function fakeReply(captured: Captured): FastifyReply {
  const reply = {
    code(statusCode: number) {
      captured.statusCode = statusCode;
      return {
        send(body: unknown) {
          captured.body = body as Captured["body"];
          return reply;
        },
      };
    },
  };
  return reply as unknown as FastifyReply;
}

function errorBody(captured: Captured): { code: string; message: string; requestId?: string } {
  assert.ok(captured.body?.error, "error envelope present");
  return captured.body.error as { code: string; message: string; requestId?: string };
}

describe("createRequireAuth (AUTH-H1-01)", () => {
  it("decorates request.user for a resolved session (200 path)", async () => {
    const guard = createRequireAuth({ database: fakeDatabase("admin") });
    const request = fakeRequest(true);
    const captured: Captured = {};
    await guard(request, fakeReply(captured));
    assert.equal(captured.statusCode, undefined); // reply not sent
    assert.equal(request.user?.username, "admin");
  });

  it("answers 401 for a session that does not exist", async () => {
    const guard = createRequireAuth({ database: fakeDatabase("no-session") });
    const captured: Captured = {};
    await guard(fakeRequest(true), fakeReply(captured));
    assert.equal(captured.statusCode, 401);
    assert.equal(errorBody(captured).code, "unauthorized");
  });

  it("answers 401 without touching the datastore when no cookie is present", async () => {
    const guard = createRequireAuth({ database: fakeDatabase("datastore-error") });
    const captured: Captured = {};
    await guard(fakeRequest(false), fakeReply(captured));
    assert.equal(captured.statusCode, 401);
    assert.equal(errorBody(captured).code, "unauthorized");
  });

  it("answers 503 database_unavailable when the session query throws — NOT 401", async () => {
    const guard = createRequireAuth({ database: fakeDatabase("datastore-error") });
    const request = fakeRequest(true);
    const captured: Captured = {};
    await guard(request, fakeReply(captured));
    assert.equal(captured.statusCode, 503);
    const error = errorBody(captured);
    assert.equal(error.code, "database_unavailable");
    assert.equal(error.message, "database is not available");
    assert.equal(error.requestId, "req-unit-1");
    // Internal diagnostics must not leak into the client envelope.
    assert.ok(!JSON.stringify(captured.body).includes("connection reset"));
    assert.equal(request.user, undefined);
  });

  it("answers 503 when no database is wired at all", async () => {
    const guard = createRequireAuth({ database: null });
    const captured: Captured = {};
    await guard(fakeRequest(true), fakeReply(captured));
    assert.equal(captured.statusCode, 503);
    assert.equal(errorBody(captured).code, "database_unavailable");
  });
});

describe("createRequireAdmin (AUTH-H1-01)", () => {
  it("passes an admin session and decorates request.user", async () => {
    const guard = createRequireAdmin({ database: fakeDatabase("admin") });
    const request = fakeRequest(true);
    const captured: Captured = {};
    await guard(request, fakeReply(captured));
    assert.equal(captured.statusCode, undefined);
    assert.equal(request.user?.role, "admin");
  });

  it("answers 403 for an authenticated non-admin (authorization, not availability)", async () => {
    const guard = createRequireAdmin({ database: fakeDatabase("user") });
    const captured: Captured = {};
    await guard(fakeRequest(true), fakeReply(captured));
    assert.equal(captured.statusCode, 403);
    assert.equal(errorBody(captured).code, "forbidden");
  });

  it("answers 401 for an unknown session", async () => {
    const guard = createRequireAdmin({ database: fakeDatabase("no-session") });
    const captured: Captured = {};
    await guard(fakeRequest(true), fakeReply(captured));
    assert.equal(captured.statusCode, 401);
  });

  it("answers 503 database_unavailable when the session query throws", async () => {
    const guard = createRequireAdmin({ database: fakeDatabase("datastore-error") });
    const captured: Captured = {};
    await guard(fakeRequest(true), fakeReply(captured));
    assert.equal(captured.statusCode, 503);
    assert.equal(errorBody(captured).code, "database_unavailable");
    assert.ok(!JSON.stringify(captured.body).includes("connection reset"));
  });
});
