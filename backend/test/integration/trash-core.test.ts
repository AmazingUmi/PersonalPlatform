import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import { AppError } from "../../src/core/api/errors.js";
import { lockActiveUser, logout } from "../../src/core/auth/service.js";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import type { Platform } from "../../src/core/platform.js";
import { createTimeService } from "../../src/core/time/index.js";
import { TrashBlobStore } from "../../src/core/trash/blobs.js";
import { TrashService } from "../../src/core/trash/service.js";
import { registerTestSchemas, resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { buildFixturePlatform, createTestUser, loginCookie } from "../helpers/platform.js";

registerTestSchemas("trash_fixture");

const initial = new Date("2026-12-01T12:00:00.000Z").getTime();
let clock = initial;
let db: Database;
let platformDb: Database;
let platform: Platform;
let cleanup: () => void;
let taskService: TrashService;
let owner: string;
let other: string;
let ownerCookie: string;
let otherCookie: string;
let failRestore = false;
let enableBarrier: { release: Promise<void>; enter(): void } | undefined;

const fixture: BackendAppModule = {
  id: "trash_fixture",
  async registerApi(ctx) {
    ctx.api.delete<{ Params: { id: string }; Querystring: { forged?: string; prepare?: string } }>("/record/:id", async (request, reply) => {
      const user = await ctx.auth.requireUser(request);
      if (request.query.forged) {
        const fake = { user: { ...user, id: other } } as typeof request;
        await assert.rejects(ctx.trash.withMutation(fake, async () => undefined), { code: "unauthorized" });
        request.user = fake.user;
      }
      const draft = (title: string) => ({
        entityId: request.params.id, entityType: "record", title, payload: { title, userId: other },
      });
      await ctx.trash.withMutation(request, async mutation => {
        const { rows } = await mutation.database.query<{ title: string }>(
          "DELETE FROM trash_fixture.records WHERE id = $1 AND user_id = $2 RETURNING title",
          [request.params.id, mutation.userId],
        );
        if (!rows[0]) throw new AppError(404, "not_found", "Record not found");
        await mutation.moveToTrash(draft(rows[0].title));
      }, request.query.prepare ? async () => draft("Record") : undefined);
      return reply.code(204).send();
    });
  },
  async restoreFromTrash(ctx, entry) {
    const title = (entry.payload as { title: string }).title;
    await ctx.database.query("INSERT INTO trash_fixture.records VALUES ($1, $2, $3)", [ctx.restoredId, ctx.userId, title]);
    if (failRestore) throw new AppError(409, "fixture_rollback", "Fixture requests rollback");
    return { restoredId: ctx.restoredId };
  },
};

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function move(userId = owner, cookie = ownerCookie, forged = false): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO trash_fixture.records VALUES ($1, $2, 'Record')", [id, userId]);
  const result = await platform.app.inject({
    method: "DELETE", url: `/api/apps/trash_fixture/record/${id}${forged ? "?forged=1" : ""}`, headers: { cookie },
  });
  assert.equal(result.statusCode, 204, result.body);
  const { rows } = await db.query<{ id: string }>("SELECT id FROM core.trash_items WHERE entity_id = $1 AND user_id = $2", [id, userId]);
  assert.equal(rows.length, 1);
  return rows[0]!.id;
}

function restore(id: string, cookie = ownerCookie) {
  return platform.app.inject({ method: "POST", url: `/api/core/trash/${id}/restore`, headers: { cookie } });
}

describe("Core Trash transactions and authorization", () => {
  before(async () => {
    db = await resetDatabase();
    await db.query(`CREATE SCHEMA trash_fixture;
      CREATE TABLE trash_fixture.records (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE, title text NOT NULL)`);
    owner = (await createTestUser(db, "trash-core-owner")).id;
    other = (await createTestUser(db, "trash-core-other")).id;
    platformDb = new Database(TEST_DATABASE_URL, undefined, { max: 1 });
    const built = await buildFixturePlatform({
      database: platformDb, manifests: [{ id: fixture.id }], backendModules: { [fixture.id]: fixture },
      clock: () => new Date(clock),
      migrateApp: async () => {
        enableBarrier?.enter();
        await enableBarrier?.release;
      },
    });
    platform = built.platform;
    cleanup = built.cleanup;
    const log = createLogger("fatal");
    const storageRoot = `${built.root}/storage`;
    taskService = new TrashService({
      database: db, retentionDays: 30, log, storageRoot,
      time: createTimeService({ defaultTimezone: "UTC", clock: () => new Date(clock) }),
      blobs: new TrashBlobStore({ database: db, storageRoot, log }),
      restoreTarget: () => ({ status: "unavailable" }),
    });
    ownerCookie = await loginCookie(platform, "trash-core-owner", "test-password-trash-core-owner");
    otherCookie = await loginCookie(platform, "trash-core-other", "test-password-trash-core-other");
  });

  after(async () => {
    await platform?.stop();
    cleanup?.();
    await platformDb?.close();
    await db?.close();
  });

  it("uses guard-owned identity, stable previews and session-only own-scope routes", async () => {
    const id = await move(owner, ownerCookie, true);
    const foreign = await move(other, otherCookie);
    const result = await platform.app.inject({ method: "GET", url: "/api/core/trash?limit=1&appId=trash_fixture", headers: { cookie: ownerCookie } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(result.json().items.map((item: { id: string }) => item.id), [id]);
    assert.equal(result.json().items[0].deletedByLabel, "trash-core-owner");
    assert.equal(result.json().items[0].deletedByType, "user");
    assert.equal(Date.parse(result.json().items[0].expiresAt) - Date.parse(result.json().items[0].deletedAt), 30 * 86_400_000);
    assert.equal((await restore(foreign)).statusCode, 404);
    const denied = await platform.app.inject({ method: "DELETE", url: `/api/core/trash/${id}`, headers: { authorization: "Bearer untrusted" } });
    assert.equal(denied.statusCode, 401);
    const empty = await platform.app.inject({ method: "DELETE", url: "/api/core/trash", headers: { cookie: ownerCookie } });
    assert.equal(empty.statusCode, 204);
    assert.equal((await db.query("SELECT 1 FROM core.trash_items WHERE id = $1", [foreign])).rowCount, 1);
  });

  it("rolls back the restore hook and permits exactly one competing claim", async () => {
    const id = await move();
    failRestore = true;
    try {
      const result = await restore(id);
      assert.equal(result.statusCode, 409, result.body);
      assert.equal((await db.query("SELECT 1 FROM trash_fixture.records WHERE user_id = $1", [owner])).rowCount, 0);
      assert.equal((await db.query("SELECT 1 FROM core.trash_items WHERE id = $1", [id])).rowCount, 1);
    } finally {
      failRestore = false;
    }
    const claims = await Promise.all([restore(id), restore(id)]);
    assert.deepEqual(claims.map(response => response.statusCode).sort(), [200, 404]);
    const restoredId = claims.find(response => response.statusCode === 200)!.json().restoredId;
    assert.deepEqual((await db.query("SELECT user_id FROM trash_fixture.records WHERE id = $1", [restoredId])).rows, [{ user_id: owner }]);
  });

  it("archives a Core-authorized Agent actor atomically and lists its historical attribution", async () => {
    const agent = { type: "agent" as const, id: randomUUID(), label: "Fixture Agent" };
    const entityId = randomUUID();
    const scope = { userId: owner, appId: fixture.id, trashId: randomUUID() };
    await db.query("INSERT INTO trash_fixture.records VALUES ($1, $2, 'Agent record')", [entityId, owner]);
    const apply = (rollback: boolean) => db.withTransaction(async tx => {
      assert.ok(await lockActiveUser(tx, owner));
      await taskService.runMutation(tx, scope, agent, async mutation => {
        const deleted = await mutation.database.query("DELETE FROM trash_fixture.records WHERE id = $1 AND user_id = $2", [entityId, mutation.userId]);
        assert.equal(deleted.rowCount, 1);
        await mutation.moveToTrash({ entityType: "record", entityId, title: "Agent record", payload: { title: "Agent record" } });
        if (rollback) throw new Error("abort Agent action");
      });
    });
    await assert.rejects(apply(true), /abort Agent action/);
    assert.equal((await db.query("SELECT id FROM trash_fixture.records WHERE id = $1", [entityId])).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM core.trash_items WHERE id = $1", [scope.trashId])).rowCount, 0);
    await apply(false);
    const list = await platform.app.inject({ method: "GET", url: "/api/core/trash", headers: { cookie: ownerCookie } });
    const preview = list.json().items.find((entry: { id: string }) => entry.id === scope.trashId);
    assert.equal(preview.deletedByType, "agent");
    assert.equal(preview.deletedByLabel, agent.label);
    assert.deepEqual((await db.query("SELECT deleted_by_agent_id FROM core.trash_items WHERE id = $1", [scope.trashId])).rows,
      [{ deleted_by_agent_id: agent.id }]);
  });

  it("races restore against manual and bulk purge without duplicating the live record", async () => {
    for (const bulk of [false, true]) {
      const id = await move();
      const before = (await db.query("SELECT id FROM trash_fixture.records WHERE user_id = $1", [owner])).rowCount!;
      const [restored, purged] = await Promise.all([
        restore(id),
        platform.app.inject({ method: "DELETE", url: bulk ? "/api/core/trash" : `/api/core/trash/${id}`, headers: { cookie: ownerCookie } }),
      ]);
      assert.ok(restored.statusCode === 200 || restored.statusCode === 404, restored.body);
      assert.equal(purged.statusCode, !bulk && restored.statusCode === 200 ? 404 : 204, purged.body);
      assert.equal((await db.query("SELECT id FROM core.trash_items WHERE id = $1", [id])).rowCount, 0);
      assert.equal((await db.query("SELECT id FROM trash_fixture.records WHERE user_id = $1", [owner])).rowCount,
        before + (restored.statusCode === 200 ? 1 : 0));
    }
  });

  it("checks expiry after waiting on the final row lock", async () => {
    const id = await move();
    const unexpired = await move();
    const deadline = clock + 60_000;
    await db.query("UPDATE core.trash_items SET expires_at = $2 WHERE id = $1", [id, new Date(deadline)]);
    const held = signal();
    const release = signal();
    const blocker = db.withTransaction(async tx => {
      await tx.query("SELECT id FROM core.trash_items WHERE id = $1 FOR UPDATE", [id]);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const result = restore(id);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const { rows } = await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT * FROM core.trash_items WHERE user_id = $1 AND id = $2 FOR UPDATE%'");
        waiting = rows.length > 0;
        if (!waiting) await setTimeout(10);
      }
      assert.ok(waiting, "restore is waiting on the final entry lock");
      clock = deadline;
      assert.equal(await taskService.purgeExpired(), 0, "sweep skips the in-flight claim");
    } finally {
      release.resolve();
      await blocker;
    }
    try {
      assert.equal((await result).statusCode, 404);
      const visible = await platform.app.inject({ method: "GET", url: "/api/core/trash", headers: { cookie: ownerCookie } });
      const visibleIds = visible.json().items.map((row: { id: string }) => row.id);
      assert.ok(visibleIds.includes(unexpired));
      assert.ok(!visibleIds.includes(id));
      assert.equal(await taskService.purgeExpired(), 1);
      assert.equal((await db.query("SELECT id FROM core.trash_items WHERE id = $1", [id])).rowCount, 0);
    } finally {
      clock = initial;
    }
  });

  it("keeps disabled entries listed and fences restore through pending migrations", async () => {
    const id = await move();
    const purgeId = await move();
    await platform.setAppEnabled(fixture.id, false);
    const visible = await platform.app.inject({ method: "GET", url: "/api/core/trash", headers: { cookie: ownerCookie } });
    assert.ok(visible.json().items.some((row: { id: string }) => row.id === id));
    const purged = await platform.app.inject({ method: "DELETE", url: `/api/core/trash/${purgeId}`, headers: { cookie: ownerCookie } });
    assert.equal(purged.statusCode, 204, purged.body);
    const disabled = await restore(id);
    assert.equal(disabled.json().error.code, "app_disabled");
    const entered = signal();
    const release = signal();
    enableBarrier = { enter: entered.resolve, release: release.promise };
    const enabling = platform.setAppEnabled(fixture.id, true);
    await entered.promise;
    try {
      const pending = await restore(id);
      assert.equal(pending.json().error.code, "app_unavailable");
    } finally {
      release.resolve();
      await enabling;
      enableBarrier = undefined;
    }
    assert.equal((await restore(id)).statusCode, 200);
  });

  it("rechecks a Cookie session revoked between preparation and the final mutation", { timeout: 5_000 }, async () => {
    const cookie = await loginCookie(platform, "trash-core-owner", "test-password-trash-core-owner");
    const entityId = randomUUID();
    await db.query("INSERT INTO trash_fixture.records VALUES ($1, $2, 'Record')", [entityId, owner]);
    const reachedFinal = signal();
    const release = signal();
    const original = platformDb.getClient;
    let checkouts = 0;
    platformDb.getClient = async () => {
      if (++checkouts === 2) {
        reachedFinal.resolve();
        await release.promise;
      }
      return original.call(platformDb);
    };
    const pending = platform.app.inject({ method: "DELETE", url: `/api/apps/trash_fixture/record/${entityId}?prepare=1`, headers: { cookie } }).then(response => response);
    try {
      await Promise.race([reachedFinal.promise, pending.then(response => {
        assert.fail(`request ended before final authorization: ${response.statusCode}`);
      })]);
      await logout(db.context(), cookie.slice(cookie.indexOf("=") + 1));
    } finally {
      release.resolve();
      platformDb.getClient = original;
    }
    assert.equal((await pending).statusCode, 401);
    assert.equal((await db.query("SELECT id FROM trash_fixture.records WHERE id = $1", [entityId])).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM core.trash_items WHERE entity_id = $1", [entityId])).rowCount, 0);
  });
});
