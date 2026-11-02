import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { appliedMigrations, runMigrations } from "../../src/core/database/migrate.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

/**
 * Upgrade coverage for continuous-sync core migrations. Historical SQL is
 * copied verbatim into a temp directory so node-pg-migrate (checkOrder on)
 * records the same names as migrations/core, then the real directory applies
 * only the unapplied suffix. Applied 01–05 files are never rewritten.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const realMigrationsDir = join(repoRoot, "migrations", "core");
const SYNC_01 = "20261102000001-continuous-sync.sql";
const SYNC_02 = "20261102000002-continuous-sync-journal.sql";
const LATEST_SYNC = [
  "20261102000001-continuous-sync",
  "20261102000002-continuous-sync-journal",
  "20261102000003-continuous-sync-guards",
  "20261102000004-sync-revive",
  "20261102000005-sync-remote-filename",
];

const tmpRoot = mkdtempSync(join(tmpdir(), "pp-sync-schema-"));
let db: Database | undefined;
let preSyncDir: string;
let throughSync01Dir: string;

function historicalDir(stopBefore: string, label: string): string {
  const files = readdirSync(realMigrationsDir).filter((file) => file.endsWith(".sql")).sort();
  const boundary = files.indexOf(stopBefore);
  assert.ok(boundary > 0, `${stopBefore} is preceded by earlier core migrations`);
  const dir = join(tmpRoot, label);
  mkdirSync(dir, { recursive: true });
  for (const file of files.slice(0, boundary)) {
    copyFileSync(join(realMigrationsDir, file), join(dir, file));
  }
  return dir;
}

function coreTarget(dir: string) {
  return { scope: "core", schema: "core", dir };
}

async function useDatabase(next: Database): Promise<Database> {
  if (db) await db.close();
  db = next;
  return db;
}

/** Empty core schema in the shared test database. Does not apply migrations. */
async function cleanCore(): Promise<Database> {
  const next = await useDatabase(new Database(TEST_DATABASE_URL));
  await next.query("DROP SCHEMA IF EXISTS core CASCADE");
  return next;
}

async function assertLatestSyncShape(database: Database): Promise<void> {
  const names = await appliedMigrations(TEST_DATABASE_URL, "core");
  for (const name of LATEST_SYNC) {
    assert.ok(names.includes(name), `${name} is applied`);
  }
  assert.deepEqual(
    names.filter((name) => name.startsWith("20261102")),
    LATEST_SYNC,
    "sync migrations stay in filename order",
  );

  const identity = await database.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'core' AND indexname = 'sync_bindings_identity'",
  );
  assert.match(identity.rows[0]!.indexdef, /UNIQUE/i);

  const columns = await database.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT table_name, column_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'core'
       AND (
         (table_name = 'sync_bindings' AND column_name IN ('head_etag', 'origin', 'pending_tombstones'))
         OR (table_name = 'sync_row_state' AND column_name IN ('high_score', 'revive'))
         OR (table_name = 'sync_conflicts' AND column_name = 'base_hash')
         OR (table_name = 'sync_remote_objects' AND column_name = 'filename')
         OR (table_name = 'sync_guards' AND column_name = 'applied_hash')
       )`,
  );
  const present = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
  for (const key of [
    "sync_bindings.head_etag",
    "sync_bindings.origin",
    "sync_bindings.pending_tombstones",
    "sync_row_state.high_score",
    "sync_row_state.revive",
    "sync_conflicts.base_hash",
    "sync_remote_objects.filename",
    "sync_guards.applied_hash",
  ]) {
    assert.ok(present.has(key), `${key} exists on the latest schema`);
  }
  const filename = columns.rows.find((row) => row.table_name === "sync_remote_objects" && row.column_name === "filename")!;
  assert.equal(filename.is_nullable, "NO");
  const revive = columns.rows.find((row) => row.column_name === "revive")!;
  assert.match(revive.column_default ?? "", /false/);
  const origin = columns.rows.find((row) => row.column_name === "origin")!;
  assert.match(origin.column_default ?? "", /create/);
}

before(() => {
  preSyncDir = historicalDir(SYNC_01, "pre-sync");
  throughSync01Dir = historicalDir(SYNC_02, "through-01");
});

after(async () => {
  if (db) await db.close();
  db = undefined;
  const restored = await resetDatabase();
  await restored.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("continuous sync schema", () => {
  it("installs the latest core schema with sync journal, guards, revive, and filename", async () => {
    const database = await useDatabase(await resetDatabase());
    await assertLatestSyncShape(database);
    const user = randomUUID();
    await database.query(
      "INSERT INTO core.users (id, username, password_hash) VALUES ($1, $2, 'hash')",
      [user, `sync-fresh-${user.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO core.sync_remote_objects (user_id, sha256, filename)
       VALUES ($1, $2, 'row.json')`,
      [user, "a".repeat(64)],
    );
    await assert.rejects(
      database.query(
        "INSERT INTO core.sync_remote_objects (user_id, sha256) VALUES ($1, $2)",
        [user, "b".repeat(64)],
      ),
      (error: { code?: string }) => error.code === "23502",
    );
  });

  it("upgrades without dropping backup history and binds an identity once", async () => {
    const database = await cleanCore();
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [coreTarget(preSyncDir)] });
    const appliedPrefix = await appliedMigrations(TEST_DATABASE_URL, "core");
    assert.equal(appliedPrefix.some((name) => name.startsWith("20261102")), false);

    const userA = randomUUID();
    const userB = randomUUID();
    const identity = randomUUID();
    const historyId = randomUUID();
    await database.query(
      "INSERT INTO core.users (id, username, password_hash) VALUES ($1, $2, 'hash'), ($3, $4, 'hash')",
      [userA, `sync-a-${userA.slice(0, 8)}`, userB, `sync-b-${userB.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO core.backup_history (id, user_id, endpoint, filename, scope, size_bytes, sha256)
       VALUES ($1, $2, 'https://cloud.example/dav/', 'legacy.json', 'own', 4, 'abcd')`,
      [historyId, userA],
    );

    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: [coreTarget(realMigrationsDir)],
    });
    await assertLatestSyncShape(database);

    const history = await database.query<{ id: string; filename: string }>(
      "SELECT id, filename FROM core.backup_history WHERE filename = 'legacy.json'",
    );
    assert.equal(history.rowCount, 1);
    assert.equal(history.rows[0]!.id, historyId);

    const endpoint = "https://cloud.example/dav/";
    await database.query(
      `INSERT INTO core.sync_bindings (user_id, identity_id, replica_id, destination_endpoint, destination_username, pairing_verifier)
       VALUES ($1, $2, $3, $4, 'one', $5)`,
      [userA, identity, randomUUID(), endpoint, "a".repeat(64)],
    );
    await assert.rejects(
      database.query(
        `INSERT INTO core.sync_bindings (user_id, identity_id, replica_id, destination_endpoint, destination_username, pairing_verifier)
         VALUES ($1, $2, $3, $4, 'two', $5)`,
        [userB, identity, randomUUID(), endpoint, "b".repeat(64)],
      ),
      (error: { code?: string }) => error.code === "23505",
    );
    const bound = await database.query<{ identity_id: string }>(
      "SELECT identity_id FROM core.sync_bindings WHERE user_id = $1",
      [userA],
    );
    assert.equal(bound.rowCount, 1);
    assert.equal(bound.rows[0]!.identity_id, identity);
  });

  it("adds journal, guards, revive, and filename on upgrade and keeps backup and binding rows", async () => {
    const database = await cleanCore();
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [coreTarget(throughSync01Dir)] });
    const appliedBaseline = await appliedMigrations(TEST_DATABASE_URL, "core");
    assert.ok(appliedBaseline.includes("20261102000001-continuous-sync"));
    assert.equal(appliedBaseline.includes("20261102000002-continuous-sync-journal"), false);

    const user = randomUUID();
    const identity = randomUUID();
    const historyId = randomUUID();
    await database.query(
      "INSERT INTO core.users (id, username, password_hash) VALUES ($1, $2, 'hash')",
      [user, `sync-upgrade-${user.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO core.backup_history (id, user_id, endpoint, filename, scope, size_bytes, sha256)
       VALUES ($1, $2, 'https://cloud.example/dav/', 'upgrade.json', 'own', 4, 'abcd')`,
      [historyId, user],
    );
    await database.query(
      `INSERT INTO core.sync_bindings (user_id, identity_id, replica_id, destination_endpoint, destination_username, pairing_verifier)
       VALUES ($1, $2, $3, 'https://cloud.example/dav/', 'one', $4)`,
      [user, identity, randomUUID(), "c".repeat(64)],
    );
    await database.query(
      "INSERT INTO core.sync_row_state (user_id, sync_key, base_hash) VALUES ($1, 'mini_game.save', 'row-base')",
      [user],
    );
    await database.query(
      "INSERT INTO core.sync_guards (user_id, sync_key, remote_image, applied_hash) VALUES ($1, 'mini_game.save', '{\"v\":1}'::jsonb, 'guard-hash')",
      [user],
    );

    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: [coreTarget(realMigrationsDir)],
    });

    const history = await database.query<{ id: string }>(
      "SELECT id FROM core.backup_history WHERE filename = 'upgrade.json'",
    );
    assert.equal(history.rowCount, 1);
    assert.equal(history.rows[0]!.id, historyId);

    const binding = await database.query<{
      identity_id: string;
      head_etag: string | null;
      origin: string;
      pending_tombstones: unknown;
    }>(
      `SELECT identity_id, head_etag, origin, pending_tombstones
       FROM core.sync_bindings WHERE user_id = $1`,
      [user],
    );
    assert.equal(binding.rows[0]!.identity_id, identity);
    assert.equal(binding.rows[0]!.head_etag, null);
    assert.equal(binding.rows[0]!.origin, "create");
    assert.deepEqual(binding.rows[0]!.pending_tombstones, []);

    const rowState = await database.query<{ base_hash: string; revive: boolean; high_score: number | null }>(
      "SELECT base_hash, revive, high_score FROM core.sync_row_state WHERE user_id = $1 AND sync_key = 'mini_game.save'",
      [user],
    );
    assert.equal(rowState.rows[0]!.base_hash, "row-base");
    assert.equal(rowState.rows[0]!.revive, false);
    assert.equal(rowState.rows[0]!.high_score, null);

    const guard = await database.query<{ applied_hash: string }>(
      "SELECT applied_hash FROM core.sync_guards WHERE user_id = $1 AND sync_key = 'mini_game.save'",
      [user],
    );
    assert.equal(guard.rows[0]!.applied_hash, "guard-hash");

    const filename = await database.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'core' AND table_name = 'sync_remote_objects' AND column_name = 'filename'`,
    );
    assert.equal(filename.rows[0]!.is_nullable, "NO");
    await database.query(
      "INSERT INTO core.sync_remote_objects (user_id, sha256, filename) VALUES ($1, $2, 'kept.json')",
      [user, "d".repeat(64)],
    );
    assert.equal(
      (await database.query("SELECT filename FROM core.sync_remote_objects WHERE user_id = $1", [user])).rows[0]!.filename,
      "kept.json",
    );
  });
});
