import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import clock from "../../src/apps/clock/index.js";
import notes from "../../src/apps/notes/index.js";
import tasks from "../../src/apps/tasks/index.js";
import type { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { Platform } from "../../src/core/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { buildFixturePlatform, createTestUser, ensureTestAdmin, loginCookie } from "../helpers/platform.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const timestamp = "2026-11-25T03:02:01.123456Z";
const backendModules = { tasks, notes, clock };
let db: Database;
let platform: Platform;
let cleanup: () => void;
let userId: string;
let otherUserId: string;
let cookie: string;

async function archiveId(entityId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM core.trash_items WHERE user_id = $1 AND entity_id = $2", [userId, entityId],
  );
  assert.equal(rows.length, 1);
  return rows[0]!.id;
}

async function deleteAt(url: string, baseHash?: string) {
  const headers = baseHash ? { cookie, "x-base-hash": baseHash } : { cookie };
  return platform.app.inject({ method: "DELETE", url, headers });
}

async function restore(id: string) {
  return platform.app.inject({ method: "POST", url: `/api/core/trash/${id}/restore`, headers: { cookie } });
}

async function taskFixture(id: string, owner: string = userId) {
  await db.query(`
    INSERT INTO tasks.tasks (id, user_id, title, status, priority, due_at, completed_at, created_at, updated_at)
    VALUES ($1, $2, 'Archived task', 'done', 3, $3, $3, $3, $3)`, [id, owner, timestamp]);
}

describe("Trash operations for Tasks, Clock, and Notes", () => {
  before(async () => {
    db = await resetDatabase();
    userId = await ensureTestAdmin(db);
    otherUserId = (await createTestUser(db, "trash-other")).id;
    const appIds = Object.keys(backendModules);
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: appIds.map((id) => ({
      dir: join(repoRoot, "apps", id, "migrations"), schema: id, scope: id,
    })) });
    const fixture = await buildFixturePlatform({
      database: db, manifests: appIds.map((id) => ({ id })), backendModules,
      clock: () => new Date("2026-11-25T04:00:00Z"),
    });
    platform = fixture.platform;
    cleanup = fixture.cleanup;
    cookie = await loginCookie(platform);
  });

  after(async () => {
    await platform?.stop();
    cleanup?.();
    await db?.close();
  });

  it("requires a current presented Task hash and restores all business values exactly under a new ID", async () => {
    const oldId = randomUUID();
    const url = `/api/apps/tasks/tasks/${oldId}`;
    await taskFixture(oldId);
    const snapshot = (id: string) => db.query("SELECT to_jsonb(t) - 'id' AS task FROM tasks.tasks t WHERE id = $1", [id]);
    const original = (await snapshot(oldId)).rows;
    const stale = await deleteAt(url, "0".repeat(64));
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "sync_stale");
    assert.equal((await db.query("SELECT 1 FROM core.trash_items WHERE entity_id = $1", [oldId])).rowCount, 0);

    const current = await platform.app.inject({ method: "GET", url, headers: { cookie } });
    const deleted = await deleteAt(url, current.json().baseHash);
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal((await snapshot(oldId)).rowCount, 0);
    const restored = await restore(await archiveId(oldId));
    assert.equal(restored.statusCode, 200, restored.body);
    const { restoredId } = restored.json<{ restoredId: string }>();
    assert.notEqual(restoredId, oldId);
    assert.deepEqual((await snapshot(restoredId)).rows, original);
    assert.equal((await deleteAt(url)).statusCode, 404);
    assert.deepEqual((await snapshot(restoredId)).rows, original);
  });

  it("retains Trash after importing the original and restores when the old ID belongs to someone else", async () => {
    const oldId = randomUUID();
    await taskFixture(oldId);
    const backup = await platform.app.inject({ method: "GET", url: "/api/core/data/export?scope=own", headers: { cookie } });
    assert.equal(backup.statusCode, 200, backup.body);
    const deleted = await deleteAt(`/api/apps/tasks/tasks/${oldId}`);
    assert.equal(deleted.statusCode, 204, deleted.body);
    const id = await archiveId(oldId);
    const imported = await platform.app.inject({
      method: "POST", url: "/api/core/data/import", headers: { cookie },
      payload: { scope: "own", snapshot: backup.json() },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().inserted, 1);
    const conflict = await restore(id);
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, "original_live");
    assert.equal(await archiveId(oldId), id);

    await db.query("UPDATE tasks.tasks SET user_id = $2 WHERE id = $1", [oldId, otherUserId]);
    const restored = await restore(id);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual((await db.query("SELECT user_id FROM tasks.tasks WHERE id = $1", [oldId])).rows, [{ user_id: otherUserId }]);
  });

  it("restores a disabled Clock alarm with the exact archived weekday order and timestamps", async () => {
    const oldId = randomUUID();
    const url = `/api/apps/clock/alarms/${oldId}`;
    await db.query(`
      INSERT INTO clock.alarms (id, user_id, time, label, enabled, repeat_days, created_at, updated_at)
      VALUES ($1, $2, '06:30', '', false, ARRAY[5, 2, 0], $3, $3)`, [oldId, userId, timestamp]);
    const snapshot = (id: string) => db.query("SELECT to_jsonb(a) - 'id' AS alarm FROM clock.alarms a WHERE id = $1", [id]);
    const original = (await snapshot(oldId)).rows;
    const deleted = await deleteAt(url);
    assert.equal(deleted.statusCode, 204, deleted.body);
    const archive = await archiveId(oldId);
    await db.query("UPDATE core.trash_items SET payload_version = 2 WHERE id = $1", [archive]);
    const unsupported = await restore(archive);
    assert.equal(unsupported.statusCode, 422, unsupported.body);
    assert.equal(unsupported.json().error.code, "trash_payload_invalid");
    assert.equal(await archiveId(oldId), archive);

    await db.query("UPDATE core.trash_items SET payload_version = 1 WHERE id = $1", [archive]);
    const restored = await restore(archive);
    assert.equal(restored.statusCode, 200, restored.body);
    const { restoredId } = restored.json<{ restoredId: string }>();
    assert.notEqual(restoredId, oldId);
    assert.deepEqual((await snapshot(restoredId)).rows, original);
    assert.equal((await deleteAt(url)).statusCode, 404);
  });

  it("restores Notes tags by original ID, current name and archived metadata, deduplicating collapsed links", async () => {
    const oldId = randomUUID();
    const [renamedId, reusedId, recreatedId, collapsedId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query(`
      INSERT INTO notes.notes (id, user_id, content, occurred_at, pinned, created_at, updated_at)
      VALUES ($1, $2, 'Archived note', $3, true, $3, $3)`, [oldId, userId, timestamp]);
    for (const [tagId, name] of [[renamedId, "Old name"], [reusedId, "Reused"], [recreatedId, "Recreated"], [collapsedId, "Collapsed"]]) {
      await db.query("INSERT INTO notes.tags (id, user_id, name, created_at) VALUES ($1, $2, $3, $4)", [tagId, userId, name, timestamp]);
      await db.query("INSERT INTO notes.note_tags (note_id, tag_id) VALUES ($1, $2)", [oldId, tagId]);
    }
    const snapshot = (id: string) => db.query("SELECT to_jsonb(n) - 'id' AS note FROM notes.notes n WHERE id = $1", [id]);
    const original = (await snapshot(oldId)).rows;
    const deleted = await deleteAt(`/api/apps/notes/notes/${oldId}`);
    assert.equal(deleted.statusCode, 204, deleted.body);

    const currentId = randomUUID();
    const currentTimestamp = "2026-11-25T03:30:00Z";
    await db.query("DELETE FROM notes.tags WHERE id = ANY($1::uuid[])", [[reusedId, collapsedId]]);
    await db.query("UPDATE notes.tags SET name = 'Collapsed' WHERE id = $1", [renamedId]);
    await db.query("UPDATE notes.tags SET user_id = $2 WHERE id = $1", [recreatedId, otherUserId]);
    await db.query("INSERT INTO notes.tags (id, user_id, name, created_at) VALUES ($1, $2, 'Reused', $3)", [currentId, userId, currentTimestamp]);

    const restored = await restore(await archiveId(oldId));
    assert.equal(restored.statusCode, 200, restored.body);
    const { restoredId } = restored.json<{ restoredId: string }>();
    assert.notEqual(restoredId, oldId);
    assert.deepEqual((await snapshot(restoredId)).rows, original);
    const links = await db.query<{ id: string; name: string; user_id: string; timestamp_preserved: boolean }>(`
      SELECT t.id, t.name, t.user_id, t.created_at = $2::timestamptz AS timestamp_preserved
      FROM notes.note_tags nt JOIN notes.tags t ON t.id = nt.tag_id WHERE nt.note_id = $1 ORDER BY t.name`,
    [restoredId, timestamp]);
    assert.deepEqual(links.rows.map((row) => row.name), ["Collapsed", "Recreated", "Reused"]);
    assert.ok(links.rows.every((row) => row.user_id === userId));
    assert.equal(links.rows[0]?.id, renamedId);
    assert.notEqual(links.rows[1]?.id, recreatedId);
    assert.equal(links.rows[1]?.timestamp_preserved, true);
    assert.equal(links.rows[2]?.id, currentId);
    assert.equal(links.rows[2]?.timestamp_preserved, false);
  });

  it("reuses a matching tag committed concurrently during Note restore", async () => {
    const oldId = randomUUID();
    const tagId = randomUUID();
    const winningTagId = randomUUID();
    await db.query("INSERT INTO notes.notes (id, user_id, content, occurred_at) VALUES ($1, $2, 'Concurrent tag', $3)", [oldId, userId, timestamp]);
    await db.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1, $2, 'Concurrent tag')", [tagId, userId]);
    await db.query("INSERT INTO notes.note_tags (note_id, tag_id) VALUES ($1, $2)", [oldId, tagId]);
    assert.equal((await deleteAt(`/api/apps/notes/notes/${oldId}`)).statusCode, 204);
    await db.query("DELETE FROM notes.tags WHERE id = $1", [tagId]);
    const id = await archiveId(oldId);

    const client = await db.getClient();
    let restoring: ReturnType<typeof restore> | undefined;
    try {
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await client.query("BEGIN");
      await client.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1, $2, 'Concurrent tag')", [winningTagId, userId]);
      restoring = restore(id);
      const deadline = Date.now() + 3_000;
      for (;;) {
        const waiting = await db.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [rows[0]!.pid]);
        if (waiting.rowCount) break;
        assert.ok(Date.now() < deadline, "restore should reach the concurrent tag insert");
        await setTimeout(10);
      }
      await client.query("COMMIT");
      const restored = await restoring;
      assert.equal(restored.statusCode, 200, restored.body);
      const { restoredId } = restored.json<{ restoredId: string }>();
      const links = await db.query("SELECT tag_id FROM notes.note_tags WHERE note_id = $1", [restoredId]);
      assert.deepEqual(links.rows, [{ tag_id: winningTagId }]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await restoring?.catch(() => undefined);
    }
  });
});
