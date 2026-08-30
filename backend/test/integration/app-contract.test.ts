import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import {
  appMigrationTargets,
  coreMigrationTarget,
  singleAppMigrationTarget,
} from "../../src/core/database/startup-migrations.js";
import { scanApps } from "../../src/core/app-registry/scanner.js";
import type { AppRecord } from "../../src/core/app-registry/types.js";
import type { Platform } from "../../src/core/platform.js";
import { backendAppModules, frontendAppIds } from "../../src/generated/apps.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { registerTestSchemas, resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

/**
 * App Contract V1 regression test (FP-15 P03).
 *
 * Unlike the other integration files, which use synthetic fixture apps, this
 * file boots the platform exactly like src/main.ts does: the REAL repository
 * root, the REAL apps/<id>/app.yaml manifests, the REAL generated backend
 * modules and the REAL app migrations. Anything Core changes that breaks the
 * public contract — platform API version, manifest<->registry consistency,
 * per-app routes, the lifecycle guard, or per-app schemas — turns this red.
 *
 * The suite iterates the live registry instead of a hardcoded app list, so it
 * stays green when apps are added or removed, as long as each new app keeps
 * the contract (and gets a KNOWN_ROUTES entry).
 */

const log = createLogger("fatal");
// backend/test/integration -> repository root is three levels up.
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const appsDir = join(repoRoot, "apps");

/**
 * One stable public GET route per app. Iterating the registry against this
 * table forces every new app to explicitly register a probe route here —
 * a missing entry fails the suite, so a new app can never silently ship
 * without pinned, tested HTTP surface.
 * "focus" is pre-registered for the app currently under development.
 */
const KNOWN_ROUTES: Record<string, string> = {
  tasks: "/api/apps/tasks/tasks",
  assets: "/api/apps/assets/items",
  mini_game: "/api/apps/mini_game/saves",
  focus: "/api/apps/focus/state",
};

/** App id rule from the manifest JSON schema (app-registry/manifest.ts). */
const APP_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

// Real app schemas this file replays migrations for. Derived from KNOWN_ROUTES
// (which the suite proves covers the whole registry) so resetDatabase() also
// drops schemas that are not yet in db.ts's APP_SCHEMAS allowlist — e.g. an
// app that is still being developed in parallel.
registerTestSchemas(...Object.keys(KNOWN_ROUTES));

let db: Database;
let platform: Platform;
let cleanup: () => void;

before(async () => {
  // Mirror the main.ts startup path against the real repository: fresh core
  // schema, then core + every real app's migrations from apps/<id>/migrations.
  db = await resetDatabase();
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [coreMigrationTarget(repoRoot), ...(await appMigrationTargets(appsDir))],
    log,
  });

  // buildFixturePlatform with an explicit root skips the temp fixture and
  // scans the real apps/ directory; the generated modules make this the
  // production app set.
  const fixture = await buildFixturePlatform({
    root: repoRoot,
    manifests: [],
    database: db,
    backendModules: backendAppModules,
    frontendAppIds,
    // Same runtime-enable migration hook as main.ts (FP-1.1).
    migrateApp: async (appId) => {
      const target = singleAppMigrationTarget(appsDir, appId);
      if (!target) return;
      await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [target], log });
    },
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
});

after(async () => {
  // Setup may have failed partway; teardown must never turn that into a
  // secondary "cannot read properties of undefined" error.
  if (platform) await platform.stop().catch(() => undefined);
  cleanup?.();
  if (db) await db.close();
});

/** App list exactly as an API client sees it. */
async function coreApps(): Promise<AppRecord[]> {
  const res = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: AppRecord[] };
  assert.ok(Array.isArray(body.items) && body.items.length > 0, "registry must not be empty");
  return body.items;
}

describe("App Contract V1: platform API", () => {
  it("pins platformApiVersion to 1", async () => {
    const res = await platform.app.inject({ method: "GET", url: "/api/core/platform" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().platformApiVersion, 1);
  });
});

describe("App Contract V1: manifest <-> registry consistency", () => {
  it("serves every registered app enabled with a valid id and matching route", async () => {
    for (const app of await coreApps()) {
      assert.match(app.id, APP_ID_PATTERN, `app id "${app.id}" must match the manifest id rule`);
      assert.ok(
        app.route.startsWith(`/${app.id}`),
        `app "${app.id}" route "${app.route}" must start with /${app.id}`,
      );
      // Every real manifest currently ships default_enabled: true, so a fresh
      // install serves the app immediately.
      assert.equal(app.status, "enabled", `app "${app.id}" must default to enabled`);
      assert.equal(app.enabled, true, `app "${app.id}" must report enabled=true`);
      // Convention: the manifest lives at apps/<id>/app.yaml.
      assert.ok(
        existsSync(join(appsDir, app.id, "app.yaml")),
        `app "${app.id}" must have a manifest at apps/${app.id}/app.yaml`,
      );
    }
  });

  it("registers every valid manifest on disk (no app silently skipped)", async () => {
    const ids = new Set((await coreApps()).map((app) => app.id));
    const validManifests = scanApps(appsDir).filter(
      (scanned) => scanned.manifest !== null && scanned.errors.length === 0,
    );
    assert.ok(validManifests.length > 0, "the real apps/ directory must contain valid manifests");
    for (const scanned of validManifests) {
      assert.ok(
        ids.has(scanned.id),
        `manifest "${scanned.id}" exists on disk but is missing from GET /api/core/apps`,
      );
    }
  });
});

describe("App Contract V1: known routes", () => {
  it("requires a KNOWN_ROUTES entry for every registered app", async () => {
    for (const app of await coreApps()) {
      assert.ok(
        KNOWN_ROUTES[app.id] !== undefined,
        `app "${app.id}" has no KNOWN_ROUTES entry — register one of its public GET routes in app-contract.test.ts`,
      );
    }
  });

  it("answers a known GET route with 200 for every app with a compiled backend", async () => {
    for (const app of await coreApps()) {
      // A manifest whose backend module has not been generated yet cannot
      // serve traffic (platform registers routes only for compiled modules);
      // the probe applies as soon as the module exists.
      if (!app.hasBackend) continue;
      const route = KNOWN_ROUTES[app.id]!;
      const res = await platform.app.inject({ method: "GET", url: route });
      assert.equal(res.statusCode, 200, `GET ${route} for app "${app.id}"`);
    }
  });
});

describe("App Contract V1: per-app database schemas", () => {
  it("creates a PostgreSQL schema for every registered app", async () => {
    const result = await db
      .context()
      .query<{ schema_name: string }>("SELECT schema_name FROM information_schema.schemata");
    const schemas = new Set(result.rows.map((row) => row.schema_name));
    for (const app of await coreApps()) {
      assert.ok(schemas.has(app.id), `schema "${app.id}" must exist after startup migrations`);
    }
  });
});

// Last on purpose: disable/enable mutates the enabled state every other
// assertion relies on.
describe("App Contract V1: lifecycle guard", () => {
  it("disable 404s the app API, re-enable restores it, others stay enabled", async () => {
    const items = await coreApps();
    const target = items.find((app) => app.hasBackend);
    assert.ok(target, "at least one registered app must have a compiled backend");
    const targetRoute = KNOWN_ROUTES[target.id]!;

    const disable = await platform.app.inject({
      method: "PUT",
      url: `/api/core/apps/${target.id}/enabled`,
      payload: { enabled: false },
    });
    assert.equal(disable.statusCode, 200);
    assert.equal(disable.json().status, "disabled");

    // Any /api/apps/<id>/* request for a non-enabled app answers 404 (doc 4.4).
    const guarded = await platform.app.inject({ method: "GET", url: targetRoute });
    assert.equal(guarded.statusCode, 404);
    assert.equal(guarded.json().error.code, "not_found");

    // The app list reflects the disabled state while other apps are untouched.
    const during = await coreApps();
    assert.equal(during.find((app) => app.id === target.id)?.status, "disabled");
    for (const app of during) {
      if (app.id === target.id) continue;
      assert.equal(app.status, "enabled", `app "${app.id}" must not be affected`);
    }

    const enable = await platform.app.inject({
      method: "PUT",
      url: `/api/core/apps/${target.id}/enabled`,
      payload: { enabled: true },
    });
    assert.equal(enable.statusCode, 200);
    assert.equal(enable.json().status, "enabled");

    const restored = await platform.app.inject({ method: "GET", url: targetRoute });
    assert.equal(restored.statusCode, 200, "re-enable must restore the app API");
  });
});
