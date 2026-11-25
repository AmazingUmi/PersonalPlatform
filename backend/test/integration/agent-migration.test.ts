import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { runMigrations } from "../../src/core/database/migrate.js";
import { coreMigrationTarget } from "../../src/core/database/startup-migrations.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

const repo = resolve(import.meta.dirname, "../../..");
const agentFile = "20261125000002-agent-interface.sql";

it("upgrades a Batch 1 database containing user, App and Trash rows without changing them", async () => {
  const db = await resetDatabase();
  const previous = await mkdtemp(join(tmpdir(), "pp-before-agent-"));
  const core = coreMigrationTarget(repo);
  try {
    await db.query("DROP SCHEMA core CASCADE");
    const migrations = (await readdir(core.dir)).filter((name) => name.endsWith(".sql") && name < agentFile);
    await Promise.all(migrations.map((file) => copyFile(join(core.dir, file), join(previous, file))));
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [{ ...core, dir: previous }] });
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [
      { scope: "tasks", schema: "tasks", dir: join(repo, "apps", "tasks", "migrations") },
    ] });
    const userId = randomUUID();
    const taskId = randomUUID();
    const originId = randomUUID();
    const trashId = randomUUID();
    await db.query("INSERT INTO core.users (id, username, password_hash) VALUES ($1, 'before-agent', '!test-fixture')", [userId]);
    await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1, $2, 'Existing task')", [taskId, userId]);
    await db.query(`
      INSERT INTO core.trash_items
        (id, user_id, app_id, entity_type, entity_id, title, payload, deleted_by_type, deleted_by_label, deleted_at, expires_at)
      VALUES ($1, $2, 'tasks', 'task', $3, 'Archived task', '{"title":"Archived task"}', 'user',
        'before-agent', '2026-11-25T10:00:00Z', '2026-12-25T10:00:00Z')`,
    [trashId, userId, originId]);
    assert.deepEqual((await db.query("SELECT to_regclass('core.agents') AS agent_table")).rows, [{ agent_table: null }]);

    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [core] });
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [core] });
    assert.deepEqual((await db.query("SELECT id, username FROM core.users WHERE id = $1", [userId])).rows,
      [{ id: userId, username: "before-agent" }]);
    assert.deepEqual((await db.query("SELECT id, user_id, title FROM tasks.tasks WHERE id = $1", [taskId])).rows,
      [{ id: taskId, user_id: userId, title: "Existing task" }]);
    assert.deepEqual((await db.query("SELECT id, user_id, entity_id, payload FROM core.trash_items WHERE id = $1", [trashId])).rows,
      [{ id: trashId, user_id: userId, entity_id: originId, payload: { title: "Archived task" } }]);
    assert.equal((await db.query("SELECT id FROM core.agents")).rowCount, 0);
    await assert.rejects(db.query(`
      INSERT INTO core.agents (id, name, created_by_user_id, token_hash, token_prefix)
      VALUES ($1, 'Agent', $2, 'not-a-digest', 'prefix')`, [randomUUID(), userId]), { code: "23514" });
  } finally {
    await db.close();
    await rm(previous, { recursive: true, force: true });
  }
});
