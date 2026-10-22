import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { registerTestSchemas, resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { prepareFixtureRoot } from "../helpers/platform.js";

/**
 * FP-11.3 restore smoke: create data -> backup -> mutate/delete -> restore ->
 * verify database rows AND storage/config files came back.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

registerTestSchemas("bkp_smoke");

let db: Database;
let root: string;
let rootCleanup: () => void;

function runBackupCli(args: string[], options: { nodeArgs?: string[]; env?: NodeJS.ProcessEnv } = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), "--import", "tsx", join(repoRoot, "scripts", "backup.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
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

  // Shared fixture: create the backup once in a suite-level hook. Creating it
  // in the first test instead let a create failure (e.g. a pg_dump version
  // mismatch) cascade into misleading ".../backups/undefined is not a backup"
  // errors in every restore test below; a failing hook reports the real error
  // once for the whole suite.
  before(async () => {
    const backupsRoot = join(root, "backups");
    const result = runBackupCli(["create", "--root", root, "--database", TEST_DATABASE_URL, "--output", backupsRoot]);
    assert.equal(result.status, 0, `backup create failed:\n${String(result.stderr)}`);

    const entries = readdirSync(backupsRoot);
    assert.equal(entries.length, 1, "one timestamped backup directory");
    backupDir = join(backupsRoot, entries[0]!);
  });

  it("create packages database, storage, config and metadata", async () => {
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

  it("SQL rollback preserves every original schema and leaves files unchanged", async () => {
    const corrupted = join(root, "backups", "sql-error");
    cpSync(backupDir, corrupted, { recursive: true });
    appendFileSync(join(corrupted, "database.sql"), "\nSELECT deliberately_missing_restore_function();\n");
    await db.context().query("INSERT INTO bkp_smoke.notes (body) VALUES ('live-sentinel')");
    await db.context().query("UPDATE core.settings SET value = '\"live-setting\"' WHERE key = 'backup.smoke'");
    const attachment = join(root, "storage", "apps", "bkp_smoke", "attachments", "a.txt");
    const config = join(root, "config", "apps", "bkp_smoke.yaml");
    writeFileSync(attachment, "live-attachment");
    writeFileSync(config, "greeting: live\n");

    const result = runBackupCli(["restore", corrupted, "--root", root, "--database", TEST_DATABASE_URL, "--yes"]);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(attachment, "utf8"), "live-attachment");
    assert.equal(readFileSync(config, "utf8"), "greeting: live\n");
    const notes = await db.context().query("SELECT body FROM bkp_smoke.notes ORDER BY id");
    assert.deepEqual(notes.rows.map((row) => row.body), ["keep me", "live-sentinel"]);
    const setting = await db.context().query("SELECT value FROM core.settings WHERE key = 'backup.smoke'");
    assert.equal(setting.rows[0]!.value, "live-setting");
    assert.ok(!String(result.stderr).includes(TEST_DATABASE_URL), "failure logs must not expose connection credentials");
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".restore-stage-")), []);
  });

  it("a corrupt storage archive is rejected before changing the database", async () => {
    const corrupted = join(root, "backups", "archive-error");
    cpSync(backupDir, corrupted, { recursive: true });
    writeFileSync(join(corrupted, "storage.tar.gz"), "not a tar archive");
    await db.context().query("UPDATE core.settings SET value = '\"archive-sentinel\"' WHERE key = 'backup.smoke'");
    const result = runBackupCli(["restore", corrupted, "--root", root, "--database", TEST_DATABASE_URL, "--yes"]);
    assert.notEqual(result.status, 0);
    const setting = await db.context().query("SELECT value FROM core.settings WHERE key = 'backup.smoke'");
    assert.equal(setting.rows[0]!.value, "archive-sentinel");
    assert.equal(readFileSync(join(root, "storage", "apps", "bkp_smoke", "attachments", "a.txt"), "utf8"), "live-attachment");
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".restore-stage-")), []);
  });

  it("an archive without storage and a preflight copy error never change the database", async () => {
    const incomplete = join(root, "backups", "missing-storage");
    cpSync(backupDir, incomplete, { recursive: true });
    const archive = spawnSync("tar", ["-czf", join(incomplete, "storage.tar.gz"), "-C", join(incomplete, "config"), "platform.yaml"], { encoding: "utf8" });
    assert.equal(archive.status, 0, archive.stderr);
    await db.context().query("UPDATE core.settings SET value = '\"preflight-sentinel\"' WHERE key = 'backup.smoke'");
    const missingRoot = runBackupCli(["restore", incomplete, "--root", root, "--database", TEST_DATABASE_URL, "--yes"]);
    assert.notEqual(missingRoot.status, 0);

    const faultModule = join(root, "preflight-fault.mjs");
    writeFileSync(faultModule, `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const copy=fs.cpSync;
      fs.cpSync=(source,destination,options)=>{
        if(String(destination).endsWith('/previous-storage')) throw new Error('injected preflight copy failure');
        return copy(source,destination,options);
      };
      syncBuiltinESMExports();
    `);
    const failedCopy = runBackupCli(["restore", backupDir, "--root", root, "--database", TEST_DATABASE_URL, "--yes"], { nodeArgs: ["--import", faultModule] });
    assert.notEqual(failedCopy.status, 0);
    const setting = await db.context().query("SELECT value FROM core.settings WHERE key = 'backup.smoke'");
    assert.equal(setting.rows[0]!.value, "preflight-sentinel");
    assert.equal(readFileSync(join(root, "storage", "apps", "bkp_smoke", "attachments", "a.txt"), "utf8"), "live-attachment");
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".restore-stage-")), []);
  });

  it("post-commit file failure retains old and incoming trees and reports partial completion", async () => {
    const faultModule = join(root, "copy-fault.mjs");
    writeFileSync(faultModule, `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const copy=fs.cpSync;
      fs.cpSync=(source,destination,options)=>{
        if(destination===process.env.PP_TEST_RESTORE_DEST) throw new Error('injected installation failure');
        return copy(source,destination,options);
      };
      syncBuiltinESMExports();
    `);
    const result = runBackupCli(["restore", backupDir, "--root", root, "--database", TEST_DATABASE_URL, "--yes"], {
      nodeArgs: ["--import", faultModule], env: { PP_TEST_RESTORE_DEST: join(root, "storage") },
    });
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /database.*committed|database.*restored/i);
    assert.match(String(result.stderr), /file.*incomplete|file.*failed/i);
    const stages = readdirSync(root).filter((name) => name.startsWith(".restore-stage-"));
    assert.equal(stages.length, 1);
    const staging = join(root, stages[0]!);
    assert.ok(String(result.stderr).includes(staging));
    assert.equal(readFileSync(join(staging, "previous-storage", "apps", "bkp_smoke", "attachments", "a.txt"), "utf8"), "live-attachment");
    assert.equal(readFileSync(join(staging, "incoming", "storage", "apps", "bkp_smoke", "attachments", "a.txt"), "utf8"), "attachment-bytes");
    assert.equal(readFileSync(join(staging, "previous-config", "apps", "bkp_smoke.yaml"), "utf8"), "greeting: live\n");
    const setting = await db.context().query("SELECT value FROM core.settings WHERE key = 'backup.smoke'");
    assert.equal(setting.rows[0]!.value, "before", "the database transaction did commit before the filesystem fault");
    rmSync(staging, { recursive: true, force: true });
  });

  it("symlink target roots are rejected before database or original tree mutation", async () => {
    await db.context().query("UPDATE core.settings SET value = '\"symlink-sentinel\"' WHERE key = 'backup.smoke'");
    // The preceding injected installation fault cleared storage; populate a
    // fresh sentinel before checking both supported-root boundaries.
    const marker = join(root, "storage", "symlink-marker.txt");
    mkdirSync(join(root, "storage"), { recursive: true });
    writeFileSync(marker, "original-root-bytes");
    for (const tree of ["storage", "config"]) {
      const source = join(root, tree);
      const real = join(root, `${tree}-real`);
      renameSync(source, real);
      symlinkSync(real, source, "dir");
      try {
        const result = runBackupCli(["restore", backupDir, "--root", root, "--database", TEST_DATABASE_URL, "--yes"]);
        assert.notEqual(result.status, 0);
        assert.match(String(result.stderr), /real directory.*symlink/);
        const setting = await db.context().query("SELECT value FROM core.settings WHERE key = 'backup.smoke'");
        assert.equal(setting.rows[0]!.value, "symlink-sentinel");
        assert.equal(readFileSync(marker, "utf8"), "original-root-bytes");
        assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".restore-stage-")), []);
      } finally {
        rmSync(source);
        renameSync(real, source);
      }
    }
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
    const repeated = runBackupCli(["restore", backupDir, "--root", root, "--database", TEST_DATABASE_URL, "--yes"]);
    assert.equal(repeated.status, 0, String(repeated.stderr));
    const again = await db.context().query("SELECT body FROM bkp_smoke.notes");
    assert.deepEqual(again.rows.map((row) => row.body), ["keep me"]);
  });
});
