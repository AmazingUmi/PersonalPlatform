import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import { withFixturePlatform } from "../helpers/platform.js";
import { resetDatabase } from "../helpers/db.js";

const log = createLogger("fatal");

/** Minimal app module used to verify the /api/apps/<id> prefix and guards. */
function testAppModule(id: string, extra: Partial<BackendAppModule> = {}): BackendAppModule {
  return {
    id,
    async registerApi(ctx) {
      ctx.api.get("/ping", async () => ({ app: id, pong: true }));
    },
    ...extra,
  };
}

let db: Database;

before(async () => {
  db = await resetDatabase();
});

after(async () => {
  // resetDatabase() may have failed; teardown must stay safe.
  if (db) await db.close();
});

describe("core api", () => {
  it("GET /api/core/apps returns the unified items shape", async () => {
    await withFixturePlatform(
      { database: db, manifests: [{ id: "listed" }], backendModules: { listed: testAppModule("listed") } },
      async (platform) => {
        const response = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
        assert.equal(response.statusCode, 200);
        const body = response.json() as { items: Array<{ id: string; status: string }> };
        const listed = body.items.find((item) => item.id === "listed");
        assert.ok(listed, "fixture app is listed");
        assert.equal(listed.status, "enabled");
      },
    );
  });

  it("returns unified 404 for unknown api routes", async () => {
    await withFixturePlatform({ database: db, manifests: [] }, async (platform) => {
      const response = await platform.app.inject({ method: "GET", url: "/api/core/nope" });
      assert.equal(response.statusCode, 404);
      const body = response.json() as { error: { code: string; requestId: string } };
      assert.equal(body.error.code, "not_found");
      assert.ok(body.error.requestId);
    });
  });

  it("validates PUT /api/core/apps/:id/enabled body", async () => {
    await withFixturePlatform({ database: db, manifests: [{ id: "validated" }] }, async (platform) => {
      const response = await platform.app.inject({
        method: "PUT",
        url: "/api/core/apps/validated/enabled",
        payload: { enabled: "yes" },
      });
      assert.equal(response.statusCode, 400);
      const body = response.json() as { error: { code: string } };
      assert.equal(body.error.code, "validation_error");
    });
  });
});

describe("readiness and liveness", () => {
  it("readiness returns 503 when the database is unavailable", async () => {
    await withFixturePlatform({ database: db, manifests: [] }, async (platform) => {
      const live = await platform.app.inject({ method: "GET", url: "/api/core/health/live" });
      assert.equal(live.statusCode, 200);

      const ready = await platform.app.inject({ method: "GET", url: "/api/core/health/ready" });
      assert.equal(ready.statusCode, 200);
      assert.equal(ready.json().status, "ok");
    });
  });

  it("readiness reports 503 with a broken database connection", async () => {
    const broken = new Database(
      "postgresql://nobody:nopass@127.0.0.1:1/nowhere",
      log,
    );
    await withFixturePlatform({ manifests: [], database: broken }, async (platform) => {
      const live = await platform.app.inject({ method: "GET", url: "/api/core/health/live" });
      assert.equal(live.statusCode, 200, "liveness never depends on the database");

      const ready = await platform.app.inject({ method: "GET", url: "/api/core/health/ready" });
      assert.equal(ready.statusCode, 503);
      const body = ready.json() as { status: string; checks: Record<string, { status: string }> };
      assert.equal(body.status, "error");
      assert.equal(body.checks.database?.status, "error");
    });
    await broken.close();
  });
});

describe("app isolation", () => {
  it("a broken app does not take down core or other apps", async () => {
    const brokenModule: BackendAppModule = {
      id: "exploding",
      async registerApi() {
        throw new Error("registerApi exploded");
      },
    };
    await withFixturePlatform(
      {
        manifests: [{ id: "exploding" }, { id: "healthy" }],
        backendModules: {
          exploding: brokenModule,
          healthy: testAppModule("healthy"),
        },
      },
      async (platform) => {
        const apps = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
        assert.equal(apps.statusCode, 200, "core API still serves");

        const exploding = (apps.json() as { items: Array<{ id: string; status: string; errorMessage?: string }> })
          .items.find((item) => item.id === "exploding");
        assert.equal(exploding?.status, "error");
        assert.match(exploding?.errorMessage ?? "", /registerApi/);

        const healthy = await platform.app.inject({ method: "GET", url: "/api/apps/healthy/ping" });
        assert.equal(healthy.statusCode, 200);
        assert.equal(healthy.json().app, "healthy");
      },
    );
  });
});
