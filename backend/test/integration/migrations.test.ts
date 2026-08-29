import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { appMigrationTargets, coreMigrationTarget, singleAppMigrationTarget } from "../../src/core/database/startup-migrations.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

const log = createLogger("fatal");
const tmpRoot = mkdtempSync(join(tmpdir(), "pp-migrate-"));
// backend/test/integration -> repository root is three levels up.
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
let db: Database;

before(async () => {
  db = await resetDatabase();
});

after(async () => {
  await db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("core migration", () => {
  it("creates core.apps and core.settings in the core schema", async () => {
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [coreMigrationTarget(repoRoot)], log });

    const tables = await db.context().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      ["apps", "migrations", "settings"],
    );
  });

  it("is idempotent when run twice", async () => {
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [coreMigrationTarget(repoRoot)], log });
    const count = await db.context().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.migrations",
    );
    assert.equal(Number(count.rows[0]?.count), 1);
  });
});

describe("app migration scopes", () => {
  it("runs app migrations in their own schema and record table", async () => {
    const appsDir = join(tmpRoot, "apps");
    mkdirSync(join(appsDir, "assets", "migrations"), { recursive: true });
    writeFileSync(
      join(appsDir, "assets", "migrations", "20260101000001-init.sql"),
      "CREATE TABLE items (id integer PRIMARY KEY, name text NOT NULL);",
    );
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: [{ scope: "assets", schema: "assets", dir: join(appsDir, "assets", "migrations") }],
      log,
    });

    const tables = await db.context().query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema IN ('core', 'assets') ORDER BY table_schema, table_name`,
    );
    const rows = tables.rows.map((row) => `${row.table_schema}.${row.table_name}`);
    assert.ok(rows.includes("assets.items"));
    assert.ok(rows.includes("assets.migrations"));
    assert.ok(rows.includes("core.apps"));
  });

  it("includes disabled installed apps as targets (migration follows installation)", async () => {
    const appsDir = join(tmpRoot, "apps");
    const manifestYaml = (id: string, defaultEnabled = true) =>
      `manifest_version: 1\nid: ${id}\nname: ${id}\nversion: 0.1.0\ndescription: t\ndefault_enabled: ${defaultEnabled}\nfrontend: { route: /${id} }\ncapabilities: {}\n`;
    mkdirSync(join(appsDir, "disabled_app", "migrations"), { recursive: true });
    mkdirSync(join(appsDir, "enabled_app", "migrations"), { recursive: true });
    mkdirSync(join(appsDir, "broken_app", "migrations"), { recursive: true });
    writeFileSync(join(appsDir, "disabled_app", "app.yaml"), manifestYaml("disabled_app", false));
    writeFileSync(join(appsDir, "enabled_app", "app.yaml"), manifestYaml("enabled_app"));
    writeFileSync(join(appsDir, "broken_app", "app.yaml"), "not: valid: yaml: {");
    writeFileSync(join(appsDir, "disabled_app", "migrations", "20260101000001-init.sql"), "SELECT 1;");
    writeFileSync(join(appsDir, "enabled_app", "migrations", "20260101000001-init.sql"), "SELECT 1;");
    writeFileSync(join(appsDir, "broken_app", "migrations", "20260101000001-init.sql"), "SELECT 1;");

    await db.context().query(
      `INSERT INTO core.apps (id, name, version, enabled) VALUES ('enabled_app', 'E', '0.1.0', true)
       ON CONFLICT (id) DO UPDATE SET enabled = true`,
    );

    const targets = await appMigrationTargets(appsDir);
    const scopes = targets.map((target) => target.scope);
    assert.ok(scopes.includes("enabled_app"));
    assert.ok(scopes.includes("disabled_app"), "disabled installed apps still migrate");
    assert.ok(!scopes.includes("broken_app"), "apps with invalid manifests never migrate");
  });

  it("singleAppMigrationTarget resolves one app and skips missing manifests/migrations", async () => {
    const appsDir = join(tmpRoot, "apps");
    const withMigrations = singleAppMigrationTarget(appsDir, "enabled_app");
    assert.ok(withMigrations);
    assert.equal(withMigrations.scope, "enabled_app");

    // Manifest valid but no migrations dir.
    mkdirSync(join(appsDir, "bare_app"), { recursive: true });
    const manifestYaml = (id: string) =>
      `manifest_version: 1\nid: ${id}\nname: ${id}\nversion: 0.1.0\ndescription: t\ndefault_enabled: true\nfrontend: { route: /${id} }\ncapabilities: {}\n`;
    writeFileSync(join(appsDir, "bare_app", "app.yaml"), manifestYaml("bare_app"));
    assert.equal(singleAppMigrationTarget(appsDir, "bare_app"), null);
    assert.equal(singleAppMigrationTarget(appsDir, "ghost_app"), null);
    assert.equal(singleAppMigrationTarget(appsDir, "broken_app"), null);
  });
});
