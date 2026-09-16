import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform, createTestUser, ensureTestAdmin, loginCookie, TEST_ADMIN_PASSWORD, TEST_ADMIN_USERNAME } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { ensureBootstrapAdmin, login as serviceLogin } from "../../src/core/auth/service.js";
import { hashSessionToken } from "../../src/core/auth/sessions.js";

/**
 * AUTH-1 integration coverage: login/logout/me lifecycle, cookie semantics,
 * session expiry/invalidity, the global auth guard on app + core APIs (and
 * its ordering behind the lifecycle guard), the admin surface (role guards +
 * user management), bootstrap idempotence, rate limiting, and fresh-install
 * placeholder semantics.
 */

interface UserView {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

let db: Database;
let platform: Platform;
let cleanup: () => void;
let adminId: string;

/** Fixture app with one real route so guard behavior is observable. */
const alphaModule = {
  id: "alpha",
  async registerApi(ctx: import("../../src/core/app-registry/types.js").AppContext): Promise<void> {
    ctx.api.get("/ping", async () => ({ ok: true, appId: ctx.appId }));
  },
};

async function inject(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, cookie?: string) {
  const response = await platform.app.inject({
    method,
    url,
    payload,
    headers: cookie === undefined ? undefined : { cookie },
  });
  return response;
}

function firstSetCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"];
  return (Array.isArray(setCookie) ? setCookie[0] : (setCookie as string | undefined)) ?? "";
}

before(async () => {
  db = await resetDatabase();
  adminId = await ensureTestAdmin(db);
  const fixture = await buildFixturePlatform({
    manifests: [{ id: "alpha" }],
    backendModules: { alpha: alphaModule },
    database: db,
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
});

after(async () => {
  await platform.stop().catch(() => undefined);
  cleanup();
  await db.close();
});

describe("login", () => {
  it("rejects a wrong password with 401 invalid_credentials", async () => {
    const response = await inject("POST", "/api/core/auth/login", {
      username: TEST_ADMIN_USERNAME,
      password: "definitely-wrong",
    });
    assert.equal(response.statusCode, 401);
    const body = response.json<ErrorBody>();
    assert.equal(body.error.code, "invalid_credentials");
  });

  it("returns the identical envelope for an unknown username (no enumeration)", async () => {
    const response = await inject("POST", "/api/core/auth/login", {
      username: "no-such-user",
      password: "whatever-pass",
    });
    assert.equal(response.statusCode, 401);
    const body = response.json<ErrorBody>();
    assert.equal(body.error.code, "invalid_credentials");
    assert.equal(body.error.message, "invalid username or password");
  });

  it("logs in the bootstrap admin and sets an HttpOnly session cookie", async () => {
    const response = await inject("POST", "/api/core/auth/login", {
      username: TEST_ADMIN_USERNAME,
      password: TEST_ADMIN_PASSWORD,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{ user: UserView }>();
    assert.equal(body.user.username, TEST_ADMIN_USERNAME);
    assert.equal(body.user.role, "admin");
    assert.equal(body.user.id, adminId);
    assert.deepEqual(Object.keys(body), ["user"]); // no token in the body

    const cookieHeader = firstSetCookie(response);
    assert.match(cookieHeader, /pp_session=/);
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Lax/i);
    assert.match(cookieHeader, /Path=\//);
    // Development environment must NOT set Secure (plain-HTTP dev flow).
    assert.doesNotMatch(cookieHeader, /Secure/i);
  });

  it("rejects malformed bodies", async () => {
    const response = await inject("POST", "/api/core/auth/login", { username: "admin" });
    assert.equal(response.statusCode, 400);
  });
});

describe("me", () => {
  it("returns the authenticated user for a valid cookie", async () => {
    const cookie = await loginCookie(platform);
    const response = await inject("GET", "/api/core/auth/me", undefined, cookie);
    assert.equal(response.statusCode, 200);
    const body = response.json<UserView>();
    assert.equal(body.username, TEST_ADMIN_USERNAME);
    assert.equal(body.role, "admin");
  });

  it("rejects requests without a cookie", async () => {
    const response = await inject("GET", "/api/core/auth/me");
    assert.equal(response.statusCode, 401);
    assert.equal(response.json<ErrorBody>().error.code, "unauthorized");
  });

  it("rejects an unknown session token", async () => {
    const response = await inject("GET", "/api/core/auth/me", undefined, "pp_session=forged-token");
    assert.equal(response.statusCode, 401);
  });

  it("rejects an expired session", async () => {
    const cookie = await loginCookie(platform);
    const token = cookie.split("=")[1]!;
    await db
      .context()
      .query("UPDATE core.sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [
        hashSessionToken(token),
      ]);
    const response = await inject("GET", "/api/core/auth/me", undefined, cookie);
    assert.equal(response.statusCode, 401);
  });

  it("rejects a session whose account was disabled", async () => {
    await createTestUser(db, "dave", "dave-password-12");
    const cookie = await loginCookie(platform, "dave", "dave-password-12");
    await db.context().query("UPDATE core.users SET status = 'disabled' WHERE username = 'dave'");
    const response = await inject("GET", "/api/core/auth/me", undefined, cookie);
    assert.equal(response.statusCode, 401);
    await db.context().query("UPDATE core.users SET status = 'active' WHERE username = 'dave'");
  });
});

describe("logout", () => {
  it("invalidates the session immediately and clears the cookie", async () => {
    const cookie = await loginCookie(platform);
    const response = await inject("POST", "/api/core/auth/logout", undefined, cookie);
    assert.equal(response.statusCode, 204);
    assert.match(firstSetCookie(response), /pp_session=;/);
    const after = await inject("GET", "/api/core/auth/me", undefined, cookie);
    assert.equal(after.statusCode, 401);
  });

  it("requires authentication", async () => {
    const response = await inject("POST", "/api/core/auth/logout");
    assert.equal(response.statusCode, 401);
  });
});

describe("global auth guard", () => {
  it("answers 401 for unauthenticated calls to an enabled app's routes", async () => {
    const response = await inject("GET", "/api/apps/alpha/ping");
    assert.equal(response.statusCode, 401);
    assert.equal(response.json<ErrorBody>().error.code, "unauthorized");
  });

  it("serves the same route for an authenticated session", async () => {
    const cookie = await loginCookie(platform);
    const response = await inject("GET", "/api/apps/alpha/ping", undefined, cookie);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, appId: "alpha" });
  });

  it("keeps the lifecycle guard first: disabled apps stay 404 even unauthenticated", async () => {
    await platform.setAppEnabled("alpha", false);
    const unauth = await inject("GET", "/api/apps/alpha/ping");
    assert.equal(unauth.statusCode, 404);
    assert.equal(unauth.json<ErrorBody>().error.code, "not_found");
    const authed = await inject("GET", "/api/apps/alpha/ping", undefined, await loginCookie(platform));
    assert.equal(authed.statusCode, 404);
    await platform.setAppEnabled("alpha", true);
  });

  it("keeps health/platform/time endpoints public", async () => {
    for (const url of ["/api/core/health/live", "/api/core/health/ready", "/api/core/platform", "/api/core/time"]) {
      const response = await inject("GET", url);
      assert.equal(response.statusCode, 200, url);
    }
  });

  it("guards core APIs: 401 unauthenticated, 403 non-admin on the operator surface", async () => {
    await createTestUser(db, "alice", "alice-password-1");
    const aliceCookie = await loginCookie(platform, "alice", "alice-password-1");
    const adminCookie = await loginCookie(platform);

    const unauth = await inject("GET", "/api/core/apps");
    assert.equal(unauth.statusCode, 401);

    // Shell surface: every authenticated user reads the app list.
    assert.equal((await inject("GET", "/api/core/apps", undefined, aliceCookie)).statusCode, 200);

    // Operator surface: admin only.
    const enable = await inject("PUT", "/api/core/apps/alpha/enabled", { enabled: true }, aliceCookie);
    assert.equal(enable.statusCode, 403);
    assert.equal(enable.json<ErrorBody>().error.code, "forbidden");

    const settingPut = await inject("PUT", "/api/core/settings/some.key", { value: 1 }, aliceCookie);
    assert.equal(settingPut.statusCode, 403);
    assert.equal((await inject("PUT", "/api/core/settings/some.key", { value: 1 })).statusCode, 401);
    assert.equal((await inject("GET", "/api/core/settings/some.key")).statusCode, 401);

    // Admin passes.
    assert.equal(
      (await inject("PUT", "/api/core/apps/alpha/enabled", { enabled: true }, adminCookie)).statusCode,
      200,
    );
    assert.equal((await inject("GET", "/api/core/apps/alpha/health", undefined, adminCookie)).statusCode, 200);
  });
});

describe("admin user management", () => {
  it("creates a user the new user can log in with", async () => {
    const adminCookie = await loginCookie(platform);
    const created = await inject(
      "POST",
      "/api/core/auth/users",
      { username: "bob", password: "bob-password-12", displayName: "Bob" },
      adminCookie,
    );
    assert.equal(created.statusCode, 201);
    const bob = created.json<{ user: UserView }>().user;
    assert.equal(bob.username, "bob");
    assert.equal(bob.role, "user");

    const login = await inject("POST", "/api/core/auth/login", { username: "bob", password: "bob-password-12" });
    assert.equal(login.statusCode, 200);
  });

  it("rejects duplicates, bad usernames and weak passwords", async () => {
    const adminCookie = await loginCookie(platform);
    const duplicate = await inject(
      "POST",
      "/api/core/auth/users",
      { username: "bob", password: "bob-password-12" },
      adminCookie,
    );
    assert.equal(duplicate.statusCode, 422);
    assert.equal(duplicate.json<ErrorBody>().error.code, "username_taken");

    const badName = await inject(
      "POST",
      "/api/core/auth/users",
      { username: "Bad Name!", password: "bob-password-12" },
      adminCookie,
    );
    assert.equal(badName.statusCode, 400);
    assert.equal(badName.json<ErrorBody>().error.code, "invalid_username");

    const weak = await inject(
      "POST",
      "/api/core/auth/users",
      { username: "carol", password: "short" },
      adminCookie,
    );
    // The JSON Schema (minLength 8) rejects before the app-level check.
    assert.equal(weak.statusCode, 400);
    assert.equal(weak.json<ErrorBody>().error.code, "validation_error");
  });

  it("is admin-only", async () => {
    const aliceCookie = await loginCookie(platform, "alice", "alice-password-1");
    assert.equal((await inject("GET", "/api/core/auth/users", undefined, aliceCookie)).statusCode, 403);
    assert.equal((await inject("GET", "/api/core/auth/users")).statusCode, 401);
  });

  it("lists user accounts", async () => {
    const adminCookie = await loginCookie(platform);
    const response = await inject("GET", "/api/core/auth/users", undefined, adminCookie);
    assert.equal(response.statusCode, 200);
    const usernames = response.json<{ items: Array<{ username: string }> }>().items.map((u) => u.username);
    assert.ok(usernames.includes("admin"));
    assert.ok(usernames.includes("bob"));
  });
});

describe("bootstrap idempotence", () => {
  it("never resets an activated password", async () => {
    const outcome = await ensureBootstrapAdmin(db.context(), {
      username: TEST_ADMIN_USERNAME,
      password: "different-password-1",
    });
    assert.equal(outcome.action, "noop");
    assert.equal(outcome.reason, "already-active");
    const stillValid = await inject("POST", "/api/core/auth/login", {
      username: TEST_ADMIN_USERNAME,
      password: TEST_ADMIN_PASSWORD,
    });
    assert.equal(stillValid.statusCode, 200);
  });

  it("repurposes a pending placeholder in place (stable id) when the requested name differs", async () => {
    const { rows } = await db
      .context()
      .query<{ id: string }>("SELECT id FROM core.users WHERE username = $1", [TEST_ADMIN_USERNAME]);
    const originalId = rows[0]!.id;
    await db
      .context()
      .query("UPDATE core.users SET password_hash = '!bootstrap-pending' WHERE id = $1", [originalId]);

    const renamed = await ensureBootstrapAdmin(db.context(), {
      username: "operator",
      password: "operator-password-1",
    });
    assert.equal(renamed.action, "activated");

    const { rows: after } = await db
      .context()
      .query<{ id: string; username: string }>("SELECT id, username FROM core.users WHERE id = $1", [originalId]);
    assert.equal(after[0]!.username, "operator"); // same row renamed, id stable
    const operatorLogin = await inject("POST", "/api/core/auth/login", {
      username: "operator",
      password: "operator-password-1",
    });
    assert.equal(operatorLogin.statusCode, 200);
  });
});

describe("login rate limiting", () => {
  it("blocks after repeated failures from the same source", async () => {
    const username = "rate-admin";
    const password = "rate-admin-pass-1";
    const outcome = await ensureBootstrapAdmin(db.context(), { username, password });
    assert.equal(outcome.action, "created"); // platform already bootstrapped

    const attempt = (passwordAttempt: string) =>
      inject("POST", "/api/core/auth/login", { username, password: passwordAttempt });

    for (let i = 0; i < 10; i += 1) {
      assert.equal((await attempt("wrong-password")).statusCode, 401);
    }
    const blocked = await attempt("wrong-password");
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json<ErrorBody>().error.code, "too_many_attempts");
    // Even the CORRECT password is refused while the window holds.
    assert.equal((await attempt(password)).statusCode, 429);
  });
});

describe("fresh install placeholder semantics", () => {
  it("seeds one pending admin that cannot log in until bootstrap activates it", async () => {
    const scratch = new Database(TEST_DATABASE_URL);
    try {
      // Re-create the core schema from scratch inside the shared test DB.
      const ctx = scratch.context();
      await ctx.query("DROP SCHEMA IF EXISTS core CASCADE");
      await runMigrations({
        databaseUrl: TEST_DATABASE_URL,
        targets: [
          {
            scope: "core-fresh",
            schema: "core",
            dir: resolve(import.meta.dirname, "..", "..", "..", "migrations", "core"),
          },
        ],
      });

      const seeded = await ctx.query<{ count: string; hash: string }>(
        "SELECT count(*)::text AS count, min(password_hash) AS hash FROM core.users",
      );
      assert.equal(seeded.rows[0]!.count, "1");
      assert.ok(seeded.rows[0]!.hash.startsWith("!")); // pending, not an Argon2 hash

      // Placeholder cannot authenticate (fail-closed verify on a bad hash).
      assert.equal(await serviceLogin(ctx, { username: "admin", password: "anything" }, new Date()), null);

      // Bootstrap without a usable password stays pending.
      const noop = await ensureBootstrapAdmin(ctx, { username: "admin" });
      assert.equal(noop.action, "noop");
      assert.equal(noop.reason, "no-password");

      // With a password: activated in place, login works, id unchanged.
      const { rows: before } = await ctx.query<{ id: string }>("SELECT id FROM core.users");
      const activated = await ensureBootstrapAdmin(ctx, { username: "admin", password: "fresh-pass-123" });
      assert.equal(activated.action, "activated");
      const { rows: after } = await ctx.query<{ id: string }>("SELECT id FROM core.users");
      assert.equal(after[0]!.id, before[0]!.id);
      const session = await serviceLogin(ctx, { username: "admin", password: "fresh-pass-123" }, new Date());
      assert.ok(session !== null);
      assert.equal(session.user.role, "admin");
    } finally {
      await scratch.close().catch(() => undefined);
    }
  });
});
