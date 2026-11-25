import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Database, DatabaseContext } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { coreMigrationTarget } from "../../src/core/database/startup-migrations.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const trashMigration = "20261125000001-unified-trash.sql";
const deletedAt = "2026-11-25T10:00:00Z";
const expiresAt = "2026-12-25T10:00:00Z";
let db: Database;

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO core.users (id, username, password_hash) VALUES ($1, $2, '!test-fixture')",
    [id, `trash-${id}`],
  );
  return id;
}

function attachment(trashId: string, attachmentId = randomUUID()) {
  return { attachmentId, key: `trash/${trashId}/${attachmentId}`, size: 12, sha256: "a".repeat(64) };
}

async function insertArchive(userId: string, options: {
  id?: string;
  files?: unknown;
  actorType?: string;
  agentId?: string;
} = {}): Promise<string> {
  const id = options.id ?? randomUUID();
  await db.query(`
    INSERT INTO core.trash_items (
      id, user_id, app_id, entity_type, entity_id, title, payload, attachment_keys,
      deleted_by_type, deleted_by_agent_id, deleted_by_label, deleted_at, expires_at
    ) VALUES ($1, $2, 'assets', 'asset_item', $3, 'Archived asset', '{}', $4::jsonb,
              $5, $6, 'Fixture actor', $7, $8)`,
  [
    id, userId, randomUUID(), JSON.stringify(options.files ?? []),
    options.actorType ?? "user", options.agentId ?? null, deletedAt, expiresAt,
  ]);
  return id;
}

function cleanupRows(ctx: Pick<DatabaseContext, "query">, userId: string) {
  return ctx.query<{ user_id: string; app_id: string; trash_id: string; storage_key: string; kind: string }>(`
    SELECT user_id, app_id, trash_id, storage_key, kind FROM core.trash_blob_cleanup
    WHERE user_id = $1 ORDER BY storage_key`, [userId]);
}

describe("Unified Trash Core migration", () => {
  before(async () => {
    db = await resetDatabase();
  });

  after(async () => {
    await db?.close();
  });

  it("installs the archive, intent, and cleanup tables in a fresh database", async () => {
    const { rows } = await db.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'core' AND table_name = ANY($1::text[]) ORDER BY table_name`,
    [["trash_items", "trash_blob_intents", "trash_blob_cleanup"]]);
    assert.deepEqual(rows.map((row) => row.table_name), ["trash_blob_cleanup", "trash_blob_intents", "trash_items"]);
  });

  it("enforces archive ownership and user/Agent attribution", async () => {
    const owner = await insertUser();
    const agentId = randomUUID();
    const userTrashId = await insertArchive(owner);
    const agentTrashId = await insertArchive(owner, { actorType: "agent", agentId });

    const { rows } = await db.query(`
      SELECT id, user_id, deleted_by_type, deleted_by_agent_id, payload_version
      FROM core.trash_items WHERE user_id = $1 ORDER BY deleted_by_type`, [owner]);
    assert.deepEqual(rows, [
      { id: agentTrashId, user_id: owner, deleted_by_type: "agent", deleted_by_agent_id: agentId, payload_version: 1 },
      { id: userTrashId, user_id: owner, deleted_by_type: "user", deleted_by_agent_id: null, payload_version: 1 },
    ]);

    for (const overrides of [{ agentId }, { actorType: "agent" }, { actorType: "other", agentId }]) {
      await assert.rejects(insertArchive(owner, overrides), { code: "23514", constraint: "trash_items_actor_check" });
    }
    await assert.rejects(insertArchive(randomUUID()), { code: "23503", constraint: "trash_items_user_id_fkey" });
  });

  it("rejects noncanonical or malformed attachment mappings on insert and update", async () => {
    const owner = await insertUser();
    const id = randomUUID();
    const file = attachment(id);
    const invalidMappings = [
      {},
      [null],
      [{ ...file, key: `../${file.key}` }],
      [{ ...file, key: attachment(randomUUID(), file.attachmentId).key }],
      [attachment(id, "A0000000-0000-4000-8000-000000000000")],
      [{ ...file, size: "12" }],
      [{ ...file, size: 1.5 }],
      [{ ...file, size: -1 }],
      [{ ...file, size: 9_007_199_254_740_992 }],
      [{ ...file, sha256: "not-a-digest" }],
      [{ ...file, sourceKey: "apps/assets/attachments/existing" }],
      [file, file],
    ];
    const mappingViolation = { code: "23514", constraint: "trash_items_attachment_keys_check" };
    for (const files of invalidMappings) {
      await assert.rejects(insertArchive(owner, { id, files }), mappingViolation);
    }

    await insertArchive(owner, { id, files: [file] });
    await assert.rejects(
      db.query("UPDATE core.trash_items SET attachment_keys = $2::jsonb WHERE id = $1", [id, JSON.stringify(invalidMappings[2])]),
      mappingViolation,
    );
    const { rows } = await db.query("SELECT attachment_keys FROM core.trash_items WHERE id = $1", [id]);
    assert.deepEqual(rows, [{ attachment_keys: [file] }]);
  });

  it("enqueues every attachment only when the direct purge commits", async () => {
    const owner = await insertUser();
    const id = randomUUID();
    const keys = [attachment(id), attachment(id)];
    await insertArchive(owner, { id, files: keys });
    const expected = keys.map((file) => file.key).sort();
    const rollback = new Error("roll back purge");

    await assert.rejects(db.withTransaction(async (tx) => {
      await tx.query("DELETE FROM core.trash_items WHERE id = $1 AND user_id = $2", [id, owner]);
      assert.deepEqual((await cleanupRows(tx, owner)).rows.map((row) => row.storage_key), expected);
      throw rollback;
    }), (error) => error === rollback);

    assert.equal((await cleanupRows(db, owner)).rowCount, 0);
    assert.equal((await db.query("SELECT id FROM core.trash_items WHERE id = $1", [id])).rowCount, 1);
    await db.query("DELETE FROM core.trash_items WHERE id = $1 AND user_id = $2", [id, owner]);
    assert.deepEqual((await cleanupRows(db, owner)).rows, expected.map((key) => ({
      user_id: owner, app_id: "assets", trash_id: id, storage_key: key, kind: "trash",
    })));
  });

  it("keeps staging and cleanup locators after owner cascade and preserves the other owner's archive", async () => {
    const owner = await insertUser();
    const otherOwner = await insertUser();
    const id = randomUUID();
    const otherId = randomUUID();
    const intentId = randomUUID();
    const file = attachment(id);
    const sourceKey = `apps/assets/sync/${randomUUID()}`;
    await insertArchive(owner, { id, files: [file] });
    await insertArchive(otherOwner, { id: otherId, files: [attachment(otherId)] });
    await db.query(`
      INSERT INTO core.trash_blob_intents (id, user_id, app_id, trash_id, operation, files, created_at, abandon_after)
      VALUES ($1, $2, 'assets', $3, 'delete', $4::jsonb, $5, $6)`,
    [intentId, owner, id, JSON.stringify([{
      attachmentId: file.attachmentId, sourceKey, destinationKey: file.key,
      temporaryKey: `${file.key}.stage-${intentId}`, size: file.size, sha256: file.sha256,
    }]), deletedAt, expiresAt]);
    await db.query(`
      INSERT INTO core.trash_blob_cleanup (user_id, storage_key, app_id, trash_id, kind)
      VALUES ($1, $2, 'assets', $3, 'live')`, [owner, sourceKey, id]);

    await db.query("DELETE FROM core.users WHERE id = $1", [owner]);

    const archives = await db.query("SELECT id, user_id FROM core.trash_items WHERE id = ANY($1::uuid[])", [[id, otherId]]);
    assert.deepEqual(archives.rows, [{ id: otherId, user_id: otherOwner }]);
    const intents = await db.query("SELECT id, user_id, trash_id FROM core.trash_blob_intents WHERE id = $1", [intentId]);
    assert.deepEqual(intents.rows, [{ id: intentId, user_id: owner, trash_id: id }]);
    assert.deepEqual((await cleanupRows(db, owner)).rows, [
      { user_id: owner, app_id: "assets", trash_id: id, storage_key: sourceKey, kind: "live" },
      { user_id: owner, app_id: "assets", trash_id: id, storage_key: file.key, kind: "trash" },
    ]);
    assert.equal((await cleanupRows(db, otherOwner)).rowCount, 0);
  });

  it("upgrades the preceding Core schema without changing existing account and App data", async () => {
    const core = coreMigrationTarget(repoRoot);
    const previousDir = mkdtempSync(join(tmpdir(), "pp-before-trash-"));
    try {
      for (const file of readdirSync(core.dir).filter((name) => name.endsWith(".sql") && name < trashMigration)) {
        copyFileSync(join(core.dir, file), join(previousDir, file));
      }
      await db.query("DROP SCHEMA core CASCADE");
      await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [{ ...core, dir: previousDir }] });
      await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [
        { scope: "tasks", schema: "tasks", dir: join(repoRoot, "apps", "tasks", "migrations") },
        { scope: "assets", schema: "assets", dir: join(repoRoot, "apps", "assets", "migrations") },
      ] });
      const userId = await insertUser();
      const taskId = randomUUID();
      const assetId = randomUUID();
      const attachmentId = randomUUID();
      const storageKey = `attachments/${assetId}/${attachmentId}`;
      await db.query("INSERT INTO tasks.tasks (id, user_id, title, description) VALUES ($1, $2, 'Existing task', NULL)", [taskId, userId]);
      await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1, $2, 'Existing asset')", [assetId, userId]);
      await db.query(`
        INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key)
        VALUES ($1, $2, $3, 'existing.bin', 12, $4)`, [attachmentId, userId, assetId, storageKey]);
      assert.deepEqual((await db.query("SELECT to_regclass('core.trash_items') AS archive")).rows, [{ archive: null }]);

      await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [core] });
      await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [core] });

      assert.equal((await db.query("SELECT id FROM core.users WHERE id = $1", [userId])).rowCount, 1);
      assert.deepEqual((await db.query("SELECT user_id, title, description FROM tasks.tasks WHERE id = $1", [taskId])).rows,
        [{ user_id: userId, title: "Existing task", description: null }]);
      assert.deepEqual((await db.query("SELECT user_id, item_id, filename, storage_key FROM assets.attachments WHERE id = $1", [attachmentId])).rows,
        [{ user_id: userId, item_id: assetId, filename: "existing.bin", storage_key: storageKey }]);
      assert.equal((await db.query("SELECT id FROM core.trash_items")).rowCount, 0);
      assert.equal((await db.query("SELECT name FROM core.migrations WHERE name = $1", [trashMigration.slice(0, -4)])).rowCount, 1);
    } finally {
      rmSync(previousDir, { recursive: true, force: true });
    }
  });
});
