import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { appMigrationTargets } from "../../src/core/database/startup-migrations.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform, prepareFixtureRoot } from "../helpers/platform.js";
import { registerTestSchemas, resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

// The migration-lifecycle suite below creates the "latecol" schema; registering
// it lets resetDatabase() clean leftovers from a previous run of this file.
registerTestSchemas("latecol");

const log = createLogger("fatal");

interface Fixture {
  platform: Platform;
  root: string;
  cleanup: () => void;
  db: Database;
}

/**
 * Builds a platform wired like main.ts: beforeActivation migrates every valid
 * installed app (enabled or not) and migrateApp applies pending migrations for
 * one app during runtime enable.
 */
async function runApp(
  db: Database,
  manifests: Parameters<typeof buildFixturePlatform>[0]["manifests"],
  backendModules: Record<string, BackendAppModule>,
): Promise<Fixture> {
  const owned = prepareFixtureRoot(manifests);
  const appsDir = join(owned.root, "apps");
  const fixture = await buildFixturePlatform({
    database: db,
    root: owned.root,
    manifests,
    backendModules,
    beforeActivation: async () => {
      await runMigrations({
        databaseUrl: TEST_DATABASE_URL,
        targets: await appMigrationTargets(appsDir),
        log,
      });
    },
    migrateApp: async (appId) => {
      const targets = await appMigrationTargets(appsDir);
      const target = targets.find((candidate) => candidate.scope === appId);
      if (target) await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [target], log });
    },
  });
  const baseCleanup = fixture.cleanup;
  return {
    platform: fixture.platform,
    root: fixture.root,
    cleanup: () => {
      baseCleanup();
      owned.cleanup();
    },
    db,
  };
}

const manifestYaml = (id: string, defaultEnabled: boolean) =>
  `manifest_version: 1
id: ${id}
name: ${id}
version: 0.1.0
description: test app ${id}
default_enabled: ${defaultEnabled}
frontend:
  route: /${id}
widgets: []
capabilities:
  database: true
`;

const RECORDS_MIGRATION =
  "CREATE TABLE records (id serial PRIMARY KEY, note text, created_at timestamptz DEFAULT now());";

describe("app migration lifecycle (FP-1.1)", () => {
  let fixture: Fixture;
  let db: Database;

  before(async () => {
    db = await resetDatabase();
    const mod: BackendAppModule = {
      id: "latecol",
      async registerApi(ctx) {
        // Depends on a column added by the SECOND migration, so this endpoint
        // only works once runtime-enable applied the pending migration.
        ctx.api.get("/data", async () => {
          const result = await ctx.database.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM latecol.records",
          );
          return { records: result.rows[0]?.n ?? 0 };
        });
      },
    };
    fixture = await runApp(
      db,
      [{ id: "latecol", yaml: manifestYaml("latecol", false), migrations: [RECORDS_MIGRATION] }],
      { latecol: mod },
    );
  });

  after(async () => {
    // Setup may have failed partway; teardown must never turn that into a
    // secondary "cannot read properties of undefined" error.
    if (fixture) {
      await fixture.platform.stop();
      fixture.cleanup();
    }
    if (db) await db.close();
  });

  it("applies migrations for a disabled installed app at startup", async () => {
    const columns = await db.context().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'latecol' AND table_name = 'records'`,
    );
    assert.ok(columns.rows.length > 0, "disabled app schema was migrated at startup");
  });

  it("keeps the business API unavailable while disabled", async () => {
    const data = await fixture.platform.app.inject({ method: "GET", url: "/api/apps/latecol/data" });
    assert.equal(data.statusCode, 404);
  });

  it("applies pending migrations during runtime enable — no restart required", async () => {
    // Ship a second migration AFTER startup, while the app is disabled.
    writeFileSync(
      join(fixture.root, "apps", "latecol", "migrations", "20260102000002-add-extra.sql"),
      "ALTER TABLE records ADD COLUMN extra text;",
    );

    const enabled = await fixture.platform.app.inject({
      method: "PUT",
      url: "/api/core/apps/latecol/enabled",
      payload: { enabled: true },
    });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.json().status, "enabled");

    const columns = await db.context().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'latecol' AND table_name = 'records'`,
    );
    assert.ok(
      columns.rows.some((row) => row.column_name === "extra"),
      "pending migration applied during runtime enable",
    );

    const data = await fixture.platform.app.inject({ method: "GET", url: "/api/apps/latecol/data" });
    assert.equal(data.statusCode, 200);
  });
});

describe("activation failure state consistency (FP-1.2)", () => {
  let fixture: Fixture;
  let db: Database;
  let eventsShouldFail = true;

  before(async () => {
    db = await resetDatabase();

    const flakyEvents: BackendAppModule = {
      id: "flaky",
      async registerApi(ctx) {
        ctx.api.get("/ping", async () => ({ pong: true }));
      },
      async registerEvents() {
        if (eventsShouldFail) throw new Error("event wiring exploded");
        return [];
      },
    };

    const brokenJobs: BackendAppModule = {
      id: "jobsapp",
      async registerApi(ctx) {
        ctx.api.get("/ping", async () => ({ pong: true }));
      },
      async registerJobs() {
        throw new Error("job wiring exploded");
      },
    };

    fixture = await runApp(
      db,
      [
        { id: "flaky", yaml: manifestYaml("flaky", true) },
        { id: "jobsapp", yaml: manifestYaml("jobsapp", true) },
      ],
      { flaky: flakyEvents, jobsapp: brokenJobs },
    );
  });

  after(async () => {
    // Setup may have failed partway; teardown must never turn that into a
    // secondary "cannot read properties of undefined" error.
    if (fixture) {
      await fixture.platform.stop();
      fixture.cleanup();
    }
    if (db) await db.close();
  });

  async function readAppRow(id: string): Promise<{ enabled: boolean; status: string; error_message: string | null }> {
    const { rows } = await db
      .context()
      .query<{ enabled: boolean; status: string; error_message: string | null }>(
        "SELECT enabled, status, error_message FROM core.apps WHERE id = $1",
        [id],
      );
    return rows[0]!;
  }

  it("registerEvents failure: API reports error with enabled=true (intent preserved)", async () => {
    const list = await fixture.platform.app.inject({ method: "GET", url: "/api/core/apps" });
    const flaky = list.json().items.find((item: { id: string }) => item.id === "flaky");
    assert.equal(flaky.status, "error");
    assert.equal(flaky.enabled, true, "user intent stays enabled=true on activation failure");
    assert.match(flaky.errorMessage, /registerEvents failed/);

    const row = await readAppRow("flaky");
    assert.equal(row.enabled, true, "core.apps.enabled consistent with API");
    assert.equal(row.status, "error", "core.apps.status consistent with API");

    const api = await fixture.platform.app.inject({ method: "GET", url: "/api/apps/flaky/ping" });
    assert.equal(api.statusCode, 404, "error apps do not serve traffic");
  });

  it("registerJobs failure: same consistent error state", async () => {
    const list = await fixture.platform.app.inject({ method: "GET", url: "/api/core/apps" });
    const jobsapp = list.json().items.find((item: { id: string }) => item.id === "jobsapp");
    assert.equal(jobsapp.status, "error");
    assert.equal(jobsapp.enabled, true);
    assert.match(jobsapp.errorMessage, /registerJobs failed/);

    const row = await readAppRow("jobsapp");
    assert.equal(row.enabled, true);
    assert.equal(row.status, "error");
  });

  it("disable after error clears the error state", async () => {
    const updated = await fixture.platform.app.inject({
      method: "PUT",
      url: "/api/core/apps/flaky/enabled",
      payload: { enabled: false },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, "disabled");
    assert.equal(updated.json().enabled, false);
    assert.equal(updated.json().errorMessage, undefined);

    const row = await readAppRow("flaky");
    assert.equal(row.enabled, false);
    assert.equal(row.status, "disabled");
    assert.equal(row.error_message, null);
  });

  it("re-enable after a recoverable error succeeds", async () => {
    eventsShouldFail = false;
    const updated = await fixture.platform.app.inject({
      method: "PUT",
      url: "/api/core/apps/flaky/enabled",
      payload: { enabled: true },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, "enabled");
    assert.equal(updated.json().errorMessage, undefined);

    const api = await fixture.platform.app.inject({ method: "GET", url: "/api/apps/flaky/ping" });
    assert.equal(api.statusCode, 200);

    const row = await readAppRow("flaky");
    assert.equal(row.enabled, true);
    assert.equal(row.status, "enabled");
  });

  it("re-enable that fails again returns the final error record, not a stale enabled one", async () => {
    eventsShouldFail = true;
    const updated = await fixture.platform.app.inject({
      method: "PUT",
      url: "/api/core/apps/flaky/enabled",
      payload: { enabled: true },
    });
    assert.equal(updated.statusCode, 200);
    const body = updated.json();
    assert.equal(body.status, "error", "API returns final state after failed activation");
    assert.equal(body.enabled, true);
    assert.match(body.errorMessage, /registerEvents failed/);

    const row = await readAppRow("flaky");
    assert.equal(row.enabled, true);
    assert.equal(row.status, "error");
  });
});
