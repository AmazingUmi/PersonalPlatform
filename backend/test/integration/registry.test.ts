import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { coreMigrationTarget } from "../../src/core/database/startup-migrations.js";
import { AppRegistry } from "../../src/core/app-registry/registry.js";
import { scanApps } from "../../src/core/app-registry/scanner.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

const log = createLogger("fatal");
// backend/test/integration -> repository root is three levels up.
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
let db: Database;

before(async () => {
  db = await resetDatabase();
  await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [coreMigrationTarget(repoRoot)], log });
});

after(async () => {
  // resetDatabase() may have failed; teardown must stay safe.
  if (db) await db.close();
});

function makeRegistry(manifestsDir: string, configEnabled: Record<string, boolean> = {}) {
  return new AppRegistry({
    manifestsDir,
    database: db,
    backendModules: {},
    configEnabled,
    log,
  });
}

describe("app registry persistence", () => {
  it("seeds enabled from default_enabled on first install and persists status", async () => {
    const { platform, cleanup } = await buildFixturePlatform({
      manifests: [{ id: "seeded" }],
      database: db,
    });
    try {
      const record = platform.getApp("seeded");
      assert.ok(record);
      assert.equal(record.status, "enabled");
      assert.equal(record.enabled, true);

      const row = await db.context().query<{ enabled: boolean; status: string }>(
        "SELECT enabled, status FROM core.apps WHERE id = 'seeded'",
      );
      assert.equal(row.rows[0]?.enabled, true);
      assert.equal(row.rows[0]?.status, "enabled");
    } finally {
      await platform.stop();
      cleanup();
    }
  });

  it("keeps the persisted enabled flag over a changed default", async () => {
    const { platform, root, cleanup } = await buildFixturePlatform({
      manifests: [{ id: "sticky" }],
      database: db,
    });
    const manifestsDir = `${root}/apps`;
    try {
      await platform.setAppEnabled("sticky", false);

      // Re-init with the same default_enabled=true: persisted false wins.
      const registry = makeRegistry(manifestsDir);
      await registry.init();
      const record = registry.get("sticky");
      assert.equal(record?.enabled, false);
      assert.equal(record?.status, "disabled");
    } finally {
      await platform.stop();
      cleanup();
    }
  });

  it("respects platform config overrides for new apps", async () => {
    const { platform, root, cleanup } = await buildFixturePlatform({
      manifests: [{ id: "overridden" }],
      database: db,
    });
    const manifestsDir = `${root}/apps`;
    try {
      // Config overrides only seed NEW installs; remove the persisted row first.
      await db.context().query("DELETE FROM core.apps WHERE id = 'overridden'");
      const registry = new AppRegistry({
        manifestsDir,
        database: db,
        backendModules: {},
        configEnabled: { overridden: false },
        log,
      });
      await registry.init();
      assert.equal(registry.get("overridden")?.enabled, false);
    } finally {
      await platform.stop();
      cleanup();
    }
  });

  it("marks invalid manifests as error without persisting them", async () => {
    const { platform, root, cleanup } = await buildFixturePlatform({
      manifests: [
        {
          id: "brokenapp",
          yaml: "manifest_version: 9\nid: brokenapp\nname: Broken\nversion: nope\ndescription: x\n",
        },
      ],
      database: db,
    });
    try {
      const record = platform.getApp("brokenapp");
      assert.equal(record?.status, "error");
      assert.ok(record?.errorMessage);

      const row = await db
        .context()
        .query<{ status: string; enabled: boolean }>(
          "SELECT status, enabled FROM core.apps WHERE id = 'brokenapp'",
        );
      assert.equal(row.rows.length, 1, "invalid manifests are recorded with status=error");
      assert.equal(row.rows[0]?.status, "error");
      assert.equal(row.rows[0]?.enabled, false);
    } finally {
      await platform.stop();
      cleanup();
    }
  });

  it("scanApps keeps working when one manifest is broken", async () => {
    const { platform, root, cleanup } = await buildFixturePlatform({
      manifests: [
        { id: "goodapp" },
        { id: "zzz_broken", yaml: "::: not yaml [" },
      ],
      database: db,
    });
    try {
      const apps = scanApps(`${root}/apps`);
      assert.ok(apps.some((app) => app.id === "goodapp" && app.manifest));
      assert.ok(apps.some((app) => app.directory === "zzz_broken" && !app.manifest));
      assert.equal(platform.getApp("goodapp")?.status, "enabled");
    } finally {
      await platform.stop();
      cleanup();
    }
  });
});
