import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { registerTestSchemas, resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { prepareFixtureRoot } from "../helpers/platform.js";

/**
 * FP-11.3 restore smoke: create data -> backup -> mutate/delete -> restore ->
 * verify database rows AND storage/config files came back.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const nodeRequire = createRequire(import.meta.url);
const tsxCli = join(dirname(nodeRequire.resolve("tsx/package.json")), "dist", "cli.mjs");

registerTestSchemas("bkp_smoke");

let db: Database;
let root: string;
let rootCleanup: () => void;

function runBackupCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [tsxCli, join(repoRoot, "scripts", "backup.ts"), ...args], {
    encoding: "utf8",
  });
}

before(async () => {
  db = await resetDatabase();
  const fixture = prepareFixtureRoot([{ id: "assets" }, { id: "tasks" }]);
  root = fixture.root;
  rootCleanup = fixture.cleanup;

  // Seed database state: a setting plus an app-like schema with a row.
  await db.context().query(`CREATE SCHEMA bkp_smoke`);
  await db.context().query(
    `CREATE TABLE bkp_smoke.notes (id serial PRIMARY KEY, body text, created_at timestamptz DEFAULT now())`,
  );
  await db.context().query(`INSERT INTO bkp_smoke.notes (body) VALUES ('keep me')`);
  await db
    .context()
    .query(
      `INSERT INTO core.settings (key, value, updated_at) VALUES ('backup.smoke', '"before"', now())`,
    );

  // Seed storage + config that must survive round-trips.
  mkdirSync(join(root, "storage", "apps", "bkp_smoke", "attachments"), { recursive: true });
  writeFileSync(join(root, "storage", "apps", "bkp_smoke", "attachments", "a.txt"), "attachment-bytes");
  mkdirSync(join(root, "config", "apps"), { recursive: true });
  writeFileSync(join(root, "config", "apps", "bkp_smoke.yaml"), "greeting: before\n");

  // Decoys that must NEVER be packaged into a backup.
  writeFileSync(join(root, ".env"), "SECRET=do-not-back-me-up\n");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "decoy.txt"), "nope");
});

after(async () => {
  await db.context().query(`DROP SCHEMA IF EXISTS bkp_smoke CASCADE`).catch(() => undefined);
  rootCleanup();
  if (db) await db.close();
});

describe("backup & restore (FP-11)", () => {
  let backupDir: string;

  it("create packages database, storage, config and metadata", async () => {
    const backupsRoot = join(root, "backups");
    const result = runBackupCli(["create", "--root", root, "--database", TEST_DATABASE_URL, "--output", backupsRoot]);
    assert.equal(result.status, 0, `backup create failed:\n${String(result.stderr)}`);

    const entries = readdirSync(backupsRoot);
    assert.equal(entries.length, 1, "one timestamped backup directory");
    backupDir = join(backupsRoot, entries[0]!);

    const metadata = JSON.parse(readFileSync(join(backupDir, "metadata.json"), "utf8")) as {
      formatVersion: number;
      createdAt: string;
      platformVersion: string;
      apps: string[];
      contents: Record<string, string>;
    };
    assert.equal(metadata.formatVersion, 1);
    assert.ok(!Number.isNaN(Date.parse(metadata.createdAt)));
    assert.match(metadata.platformVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(metadata.apps.includes("assets") && metadata.apps.includes("tasks"));
    assert.ok(existsSync(join(backupDir, metadata.contents["database"]!)));
    assert.ok(existsSync(join(backupDir, metadata.contents["storage"]!)));
    assert.ok(existsSync(join(backupDir, "config", "platform.yaml")));

    // The dump actually contains the seeded schema and data.
    const dump = readFileSync(join(backupDir, "database.sql"), "utf8");
    assert.match(dump, /CREATE SCHEMA bkp_smoke/);
    assert.match(dump, /keep me/);

    // Secrets and dependencies are structurally excluded.
    const backupEntries = readdirSync(backupDir).sort();
    assert.deepEqual(
      backupEntries.filter((entry) => entry.startsWith(".") || entry === "node_modules"),
      [],
      "no .env or node_modules in the backup",
    );
    assert.ok(!existsSync(join(backupDir, ".env")));
  });

  it("restore refuses to run without --yes", async () => {
    const result = runBackupCli(["restore", backupDir, "--root", root, "--database", TEST_DATABASE_URL]);
    assert.notEqual(result.status, 0, "restore without --yes must fail");
    assert.match(String(result.stderr), /--yes/);
  });

  it("restore rejects an unsupported format version", async () => {
    const corrupted = join(root, "backups", "corrupted");
    mkdirSync(corrupted, { recursive: true });
    writeFileSync(join(corrupted, "metadata.json"), JSON.stringify({ formatVersion: 99 }));
    const result = runBackupCli(["restore", corrupted, "--root", root, "--database", TEST_DATABASE_URL, "--yes"]);
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /format version/);
  });

  it("round-trips: destroyed data and files come back after restore", async () => {
    // Destroy: drop the schema, clear settings, delete storage + config.
    await db.context().query(`DROP SCHEMA bkp_smoke CASCADE`);
    await db.context().query(`DELETE FROM core.settings`);
    rmSync(join(root, "storage", "apps", "bkp_smoke"), { recursive: true, force: true });
    writeFileSync(join(root, "config", "apps", "bkp_smoke.yaml"), "greeting: destroyed\n");

    const destroyedSchema = await db
      .context()
      .query(`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'bkp_smoke'`);
    assert.equal(destroyedSchema.rows[0]!.n, 0, "schema really dropped");

    const result = runBackupCli([
      "restore",
      backupDir,
      "--root",
      root,
      "--database",
      TEST_DATABASE_URL,
      "--yes",
    ]);
    assert.equal(result.status, 0, `restore failed:\n${String(result.stderr)}`);

    // Database records are back.
    const note = await db.context().query<{ body: string }>(`SELECT body FROM bkp_smoke.notes`);
    assert.equal(note.rows[0]!.body, "keep me");
    const setting = await db
      .context()
      .query<{ value: unknown }>(`SELECT value FROM core.settings WHERE key = 'backup.smoke'`);
    assert.equal(setting.rows[0]!.value, "before");

    // Storage attachment content is back, byte for byte.
    assert.equal(
      readFileSync(join(root, "storage", "apps", "bkp_smoke", "attachments", "a.txt"), "utf8"),
      "attachment-bytes",
    );
    // Config rode along too.
    assert.equal(readFileSync(join(root, "config", "apps", "bkp_smoke.yaml"), "utf8"), "greeting: before\n");
  });
});
