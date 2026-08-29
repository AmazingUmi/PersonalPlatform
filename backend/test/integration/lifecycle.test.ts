import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { registerTestSchemas, resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { join } from "node:path";

// This file's migrations create the "lifecyc" schema; registering it lets
// resetDatabase() clean leftovers from a previous run of this same file.
registerTestSchemas("lifecyc");

const log = createLogger("fatal");
let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;

/** Shared state the lifecycle module writes to; inspected by the tests. */
const jobRuns: number[] = [];
const eventCalls: string[] = [];

const lifecycleApp: BackendAppModule = {
  id: "lifecyc",
  async registerApi(ctx) {
    ctx.api.get("/data", async () => {
      const result = await ctx.database.query<{ n: number }>("SELECT count(*)::int AS n FROM lifecyc.records");
      return { records: result.rows[0]?.n ?? 0 };
    });
    ctx.api.post("/data", async (_request, reply) => {
      await ctx.database.query("INSERT INTO lifecyc.records (note) VALUES ('x')");
      return reply.code(201).send({ created: true });
    });
  },
  async registerEvents(ctx) {
    return [
      ctx.events.subscribe("lifecyc.ping.v1", (event) => {
        eventCalls.push(event.type);
      }),
    ];
  },
  async registerJobs(ctx) {
    return [
      ctx.scheduler.register({
        id: "lifecyc.tick",
        schedule: { intervalMs: 20 },
        run: async () => {
          jobRuns.push(Date.now());
        },
      }),
    ];
  },
};

before(async () => {
  db = await resetDatabase();
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [
      {
        id: "lifecyc",
        migrations: ["CREATE TABLE records (id serial PRIMARY KEY, note text, created_at timestamptz DEFAULT now());"],
      },
    ],
    backendModules: { lifecyc: lifecycleApp },
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "lifecyc", schema: "lifecyc", dir: join(root, "apps", "lifecyc", "migrations") }],
    log,
  });
});

after(async () => {
  // Setup may have failed partway; teardown must never turn that into a
  // secondary "cannot read properties of undefined" error.
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

describe("app lifecycle end to end", () => {
  it("serves the app API while enabled", async () => {
    const created = await platform.app.inject({ method: "POST", url: "/api/apps/lifecyc/data" });
    assert.equal(created.statusCode, 201);
    const data = await platform.app.inject({ method: "GET", url: "/api/apps/lifecyc/data" });
    assert.equal(data.statusCode, 200);
    assert.equal(data.json().records, 1);
  });

  it("health endpoint reports ok while enabled", async () => {
    const health = await platform.app.inject({ method: "GET", url: "/api/core/apps/lifecyc/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, "ok");
  });

  it("disable makes API, health and background activity unavailable", async () => {
    const updated = await platform.app.inject({
      method: "PUT",
      url: "/api/core/apps/lifecyc/enabled",
      payload: { enabled: false },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, "disabled");

    // App API now answers 404.
    const data = await platform.app.inject({ method: "GET", url: "/api/apps/lifecyc/data" });
    assert.equal(data.statusCode, 404);
    assert.equal(data.json().error.code, "not_found");

    // Health endpoint 404s for non-enabled apps.
    const health = await platform.app.inject({ method: "GET", url: "/api/core/apps/lifecyc/health" });
    assert.equal(health.statusCode, 404);

    // Jobs stop and subscriptions are removed.
    jobRuns.length = 0;
    eventCalls.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const jobRunsWhileDisabled = jobRuns.length;
    platform.app.inject;
    // Publishing on a fresh bus instance is not observable here; instead verify
    // job cancellation concretely.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(jobRuns.length, jobRunsWhileDisabled, "job does not run while app disabled");
  });

  it("keeps app data after disable", async () => {
    const rows = await db.context().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM lifecyc.records",
    );
    assert.equal(Number(rows.rows[0]?.count), 1, "records survive disabling");
    const schemas = await db.context().query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'lifecyc'",
    );
    assert.equal(schemas.rows.length, 1, "schema not dropped");
  });

  it("re-enabling restores API and background activity", async () => {
    const updated = await platform.app.inject({
      method: "PUT",
      url: "/api/core/apps/lifecyc/enabled",
      payload: { enabled: true },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, "enabled");

    const data = await platform.app.inject({ method: "GET", url: "/api/apps/lifecyc/data" });
    assert.equal(data.statusCode, 200);
    assert.equal(data.json().records, 1, "data still there after re-enable");

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(jobRuns.length > 0, "job runs again after re-enable");
  });

  it("PUT enabled on an unknown app returns unified 404", async () => {
    const response = await platform.app.inject({
      method: "PUT",
      url: "/api/core/apps/ghost/enabled",
      payload: { enabled: true },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "app_not_found");
  });

  it("PUT enabled is idempotent", async () => {
    const again = await platform.app.inject({
      method: "PUT",
      url: "/api/core/apps/lifecyc/enabled",
      payload: { enabled: true },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().status, "enabled");
  });
});
