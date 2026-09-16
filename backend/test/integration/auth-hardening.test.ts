import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Platform } from "../../src/core/platform.js";
import { resetDatabase } from "../helpers/db.js";
import type { Database } from "../../src/core/database/index.js";
import {
  createTestUser,
  ensureTestAdmin,
  loginCookie,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  withFixturePlatform,
} from "../helpers/platform.js";

/**
 * AUTH-H1 integration coverage:
 * - H1-02: the session cookie's Secure flag follows the documented precedence
 *   (SESSION_COOKIE_SECURE env > PLATFORM_ENVIRONMENT env > yaml environment);
 * - H1-03: X-Forwarded-For is honored only under an explicit TRUST_PROXY
 *   configuration, and the login limiter keys on the resolved client IP.
 *
 * Env vars are set around platform construction (createPlatform resolves both
 * flags from process.env at wiring time) and always restored.
 */

interface ErrorBody {
  error: { code: string; message: string };
}

let db: Database;

/** Fixture app exposing request.ip so proxy resolution is observable. */
const echoModule = {
  id: "echo",
  async registerApi(ctx: import("../../src/core/app-registry/types.js").AppContext): Promise<void> {
    ctx.api.get("/ip", async (request) => ({ ip: request.ip }));
  },
};

function firstSetCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"];
  return (Array.isArray(setCookie) ? setCookie[0] : (setCookie as string | undefined)) ?? "";
}

/** Set env vars for the duration of fn; undefined deletes. Restores after. */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function loginOn(
  platform: Platform,
  username = TEST_ADMIN_USERNAME,
  password = TEST_ADMIN_PASSWORD,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; cookieHeader: string }> {
  const response = await platform.app.inject({
    method: "POST",
    url: "/api/core/auth/login",
    payload: { username, password },
    headers,
  });
  return { statusCode: response.statusCode, cookieHeader: firstSetCookie(response) };
}

before(async () => {
  db = await resetDatabase();
  await ensureTestAdmin(db);
});

after(async () => {
  await db.close();
});

describe("session cookie Secure flag (AUTH-H1-02)", () => {
  it("development default: Set-Cookie carries no Secure attribute", async () => {
    await withEnv({ PLATFORM_ENVIRONMENT: undefined, SESSION_COOKIE_SECURE: undefined }, async () => {
      await withFixturePlatform({ manifests: [], database: db }, async (platform) => {
        const { statusCode, cookieHeader } = await loginOn(platform);
        assert.equal(statusCode, 200);
        assert.match(cookieHeader, /pp_session=/);
        assert.doesNotMatch(cookieHeader, /Secure/i);
      });
    });
  });

  it("PLATFORM_ENVIRONMENT=production: Set-Cookie contains Secure", async () => {
    await withEnv({ PLATFORM_ENVIRONMENT: "production", SESSION_COOKIE_SECURE: undefined }, async () => {
      await withFixturePlatform({ manifests: [], database: db }, async (platform) => {
        const { statusCode, cookieHeader } = await loginOn(platform);
        assert.equal(statusCode, 200);
        assert.match(cookieHeader, /pp_session=/);
        assert.match(cookieHeader, /Secure/i);
        assert.match(cookieHeader, /HttpOnly/i);
        assert.match(cookieHeader, /SameSite=Lax/i);
      });
    });
  });

  it("SESSION_COOKIE_SECURE=true forces Secure even in development", async () => {
    await withEnv({ PLATFORM_ENVIRONMENT: "development", SESSION_COOKIE_SECURE: "true" }, async () => {
      await withFixturePlatform({ manifests: [], database: db }, async (platform) => {
        const { statusCode, cookieHeader } = await loginOn(platform);
        assert.equal(statusCode, 200);
        assert.match(cookieHeader, /Secure/i);
      });
    });
  });

  it("SESSION_COOKIE_SECURE=false explicitly withholds Secure in production", async () => {
    await withEnv({ PLATFORM_ENVIRONMENT: "production", SESSION_COOKIE_SECURE: "false" }, async () => {
      await withFixturePlatform({ manifests: [], database: db }, async (platform) => {
        const { statusCode, cookieHeader } = await loginOn(platform);
        assert.equal(statusCode, 200);
        assert.doesNotMatch(cookieHeader, /Secure/i);
      });
    });
  });

  it("GET /api/core/platform reports the EFFECTIVE environment (env override applied)", async () => {
    await withEnv({ PLATFORM_ENVIRONMENT: "production" }, async () => {
      await withFixturePlatform({ manifests: [], database: db }, async (platform) => {
        const response = await platform.app.inject({ method: "GET", url: "/api/core/platform" });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json<{ environment: string }>().environment, "production");
      });
    });
  });
});

describe("trusted proxy resolution (AUTH-H1-03)", () => {
  it("default: X-Forwarded-For is ignored — request.ip stays the socket address", async () => {
    await withEnv({ TRUST_PROXY: undefined }, async () => {
      await withFixturePlatform(
        { manifests: [{ id: "echo" }], backendModules: { echo: echoModule }, database: db },
        async (platform) => {
          const cookie = await loginCookie(platform);
          const response = await platform.app.inject({
            method: "GET",
            url: "/api/apps/echo/ip",
            headers: { cookie, "x-forwarded-for": "9.9.9.9" },
          });
          assert.equal(response.statusCode, 200);
          // light-my-request peers connect from loopback.
          assert.equal(response.json<{ ip: string }>().ip, "127.0.0.1");
        },
      );
    });
  });

  it("TRUST_PROXY=loopback: request.ip resolves the forwarded client address", async () => {
    await withEnv({ TRUST_PROXY: "loopback" }, async () => {
      await withFixturePlatform(
        { manifests: [{ id: "echo" }], backendModules: { echo: echoModule }, database: db },
        async (platform) => {
          const cookie = await loginCookie(platform);
          const response = await platform.app.inject({
            method: "GET",
            url: "/api/apps/echo/ip",
            headers: { cookie, "x-forwarded-for": "9.9.9.9" },
          });
          assert.equal(response.statusCode, 200);
          assert.equal(response.json<{ ip: string }>().ip, "9.9.9.9");
        },
      );
    });
  });

  it("TRUST_PROXY off: forged X-Forwarded-For cannot split the limiter window", async () => {
    await withEnv({ TRUST_PROXY: undefined }, async () => {
      await createTestUser(db, "spoofy", "spoofy-password-1");
      await withFixturePlatform({ manifests: [], database: db }, async (platform) => {
        // Ten failures, each claiming a DIFFERENT forwarded client IP.
        for (let i = 1; i <= 10; i += 1) {
          const { statusCode } = await loginOn(platform, "spoofy", "wrong-password", {
            "x-forwarded-for": `10.0.0.${i}`,
          });
          assert.equal(statusCode, 401);
        }
        // The 11th attempt is blocked: every call shared the real socket IP.
        const blocked = await loginOn(platform, "spoofy", "spoofy-password-1", {
          "x-forwarded-for": "10.0.0.99",
        });
        assert.equal(blocked.statusCode, 429);
      });
    });
  });

  it("TRUST_PROXY=loopback: distinct forwarded client IPs get independent limiter windows", async () => {
    await withEnv({ TRUST_PROXY: "loopback" }, async () => {
      await createTestUser(db, "forwarded", "forwarded-password-1");
      await withFixturePlatform({ manifests: [], database: db }, async (platform) => {
        for (let i = 0; i < 10; i += 1) {
          const { statusCode } = await loginOn(platform, "forwarded", "wrong-password", {
            "x-forwarded-for": "9.9.9.9",
          });
          assert.equal(statusCode, 401);
        }
        // Blocked for 9.9.9.9 …
        const blocked = await loginOn(platform, "forwarded", "forwarded-password-1", {
          "x-forwarded-for": "9.9.9.9",
        });
        assert.equal(blocked.statusCode, 429);
        // … but a different client IP has its own window and still gets the
        // real verdict (correct password → 200).
        const other = await loginOn(platform, "forwarded", "forwarded-password-1", {
          "x-forwarded-for": "8.8.8.8",
        });
        assert.equal(other.statusCode, 200);
      });
    });
  });
});

// Envelope sanity for the 429 path (kept out of the tests above for clarity).
describe("limiter envelope", () => {
  it("returns the standard error envelope", async () => {
    await withEnv({ TRUST_PROXY: undefined }, async () => {
      await createTestUser(db, "envelope", "envelope-password-1");
      await withFixturePlatform({ manifests: [], database: db }, async (platform) => {
        for (let i = 0; i < 10; i += 1) {
          await loginOn(platform, "envelope", "wrong-password");
        }
        const blocked = await platform.app.inject({
          method: "POST",
          url: "/api/core/auth/login",
          payload: { username: "envelope", password: "wrong-password" },
        });
        assert.equal(blocked.statusCode, 429);
        const body = blocked.json<ErrorBody>();
        assert.equal(body.error.code, "too_many_attempts");
      });
    });
  });
});
