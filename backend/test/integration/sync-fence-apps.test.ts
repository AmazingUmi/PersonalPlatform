import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assetsApp from "../../src/apps/assets/index.js";
import clockApp from "../../src/apps/clock/index.js";
import focusApp from "../../src/apps/focus/index.js";
import miniGameApp from "../../src/apps/mini_game/index.js";
import notesApp from "../../src/apps/notes/index.js";
import tasksApp from "../../src/apps/tasks/index.js";
import { lockOwnedTables, lockOwnerSet } from "../../src/core/data-management/sync-fence.js";
import { Database } from "../../src/core/database/index.js";
import type { Platform } from "../../src/core/platform.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { multipartBody } from "../helpers/multipart.js";
import { buildFixturePlatform, ensureTestAdmin, loginCookie } from "../helpers/platform.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const sql = (app: string) => {
  const dir = join(repoRoot, "apps", app, "migrations");
  return readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(join(dir, name), "utf8"));
};

let db: Database;
let platform: Platform;
let cleanup: () => void;
let cookie: string;
let userId: string;

async function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object, headers?: Record<string, string>) {
  const response = await platform.app.inject({ method, url, payload, headers: { cookie, ...headers } });
  const raw = response.body;
  return { status: response.statusCode, body: (raw ? JSON.parse(raw) : null) as { error?: { code?: string }; [key: string]: unknown } };
}

async function link(phase: "linked" | "publication_unknown" | "unlinked") {
  await db.query("DELETE FROM core.sync_bindings WHERE user_id = $1", [userId]);
  if (phase === "unlinked") return;
  await db.query(
    `INSERT INTO core.sync_bindings (user_id, identity_id, replica_id, destination_endpoint, destination_username, pairing_verifier, phase)
     VALUES ($1, $2, $3, 'https://example.invalid', 'fence', 'verifier', $4)`,
    [userId, randomUUID(), randomUUID(), phase],
  );
}

before(async () => {
  db = await resetDatabase();
  await ensureTestAdmin(db);
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: ["tasks", "notes", "clock", "focus", "mini_game", "assets"].map((id) => ({ id, migrations: sql(id) })),
    backendModules: { tasks: tasksApp, notes: notesApp, clock: clockApp, focus: focusApp, mini_game: miniGameApp, assets: assetsApp },
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  cookie = await loginCookie(platform);
  userId = (await db.query<{ id: string }>("SELECT id FROM core.users WHERE username = 'admin'")).rows[0]!.id;
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: ["tasks", "notes", "clock", "focus", "mini_game", "assets"].map((id) => ({
      scope: id, schema: id, dir: join(fixture.root, "apps", id, "migrations"),
    })),
  });
});

after(async () => {
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

describe("app sync fences", () => {
  it("accepts an omitted hash while unlinked and rejects a stale or missing hash once linked", async () => {
    await link("unlinked");
    const created = await call("POST", "/api/apps/tasks/tasks", { title: "Fence" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { id: string }).id;
    const listed = await call("GET", "/api/apps/tasks/tasks");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const item = ((listed.body as { items: Array<{ id: string; baseHash: string; title: string }> }).items).find((row) => row.id === id)!;
    const omitted = await call("PATCH", `/api/apps/tasks/tasks/${id}`, { title: "Unlinked edit" });
    assert.equal(omitted.status, 200);

    await link("linked");
    const fresh = await call("GET", "/api/apps/tasks/tasks");
    const current = ((fresh.body as { items: Array<{ id: string; baseHash: string; title: string }> }).items).find((row) => row.id === id)!;
    const missing = await call("PATCH", `/api/apps/tasks/tasks/${id}`, { title: "Should not land" });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error?.code, "sync_base_required");
    const stale = await call("PATCH", `/api/apps/tasks/tasks/${id}`, { title: "Stale", baseHash: item.baseHash });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error?.code, "sync_stale");
    const kept = await call("GET", "/api/apps/tasks/tasks");
    assert.equal(((kept.body as { items: Array<{ id: string; title: string }> }).items).find((row) => row.id === id)!.title, "Unlinked edit");
    const saved = await call("PATCH", `/api/apps/tasks/tasks/${id}`, { title: "Linked edit", baseHash: current.baseHash });
    assert.equal(saved.status, 200);
    const foreign = await call("PATCH", `/api/apps/tasks/tasks/${randomUUID()}`, { title: "Nope" });
    assert.equal(foreign.status, 404);

    await link("publication_unknown");
    const paused = await call("PATCH", `/api/apps/tasks/tasks/${id}`, { title: "Paused client" });
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error?.code, "sync_base_required");
  });

  it("requires the absence hash for a linked first save and keeps the locked game pair", async () => {
    await link("linked");
    const absentGame = await call("GET", "/api/apps/mini_game/saves");
    const absentHash = (absentGame.body as { baseHash: string }).baseHash;
    const board = [[0, 0, 0, 0], [0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0]];
    const missing = await call("PUT", "/api/apps/mini_game/saves", { score: 2, board, revision: 1 });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error?.code, "sync_base_required");
    const staleOld = await call("PUT", "/api/apps/mini_game/saves", { score: 2, board, revision: 1, baseHash: "a".repeat(64) });
    assert.equal(staleOld.status, 409);
    const first = await call("PUT", "/api/apps/mini_game/saves", { score: 2, board, revision: 1, baseHash: absentHash });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((first.body as { accepted: boolean }).accepted, true);
    const loadedHash = (first.body as { baseHash: string }).baseHash;
    const rejected = await call("PUT", "/api/apps/mini_game/saves", { score: 4, board, revision: 1, baseHash: loadedHash });
    assert.equal(rejected.status, 200);
    assert.equal((rejected.body as { accepted: boolean }).accepted, false);
    assert.equal((rejected.body as { save: { revision: number; score: number } }).save.revision, 1);
    assert.equal((rejected.body as { save: { score: number } }).save.score, 2);
    assert.equal((rejected.body as { baseHash: string }).baseHash, loadedHash);

    await db.query("DELETE FROM mini_game.saves WHERE user_id = $1", [userId]);
    const afterDelete = await call("GET", "/api/apps/mini_game/saves");
    const missingAfter = await call("PUT", "/api/apps/mini_game/saves", { score: 2, board, revision: 1 });
    assert.equal(missingAfter.status, 409);
    const staleExisting = await call("PUT", "/api/apps/mini_game/saves", { score: 2, board, revision: 1, baseHash: loadedHash });
    assert.equal(staleExisting.status, 409);
    assert.equal(staleExisting.body.error?.code, "sync_stale");
    const restored = await call("PUT", "/api/apps/mini_game/saves", {
      score: 2, board, revision: 1, baseHash: (afterDelete.body as { baseHash: string }).baseHash,
    });
    assert.equal(restored.status, 200);

    const clock = await call("GET", "/api/apps/clock/settings");
    const clockMissing = await call("PUT", "/api/apps/clock/settings", { displayMode: "analog", showSeconds: false, showDate: true, hourFormat: 24 });
    assert.equal(clockMissing.status, 409);
    const clockSaved = await call("PUT", "/api/apps/clock/settings", {
      displayMode: "analog", showSeconds: false, showDate: true, hourFormat: 24, baseHash: (clock.body as { baseHash: string }).baseHash,
    });
    assert.equal(clockSaved.status, 200);

    const alarm = await call("POST", "/api/apps/clock/alarms", { time: "08:15" });
    const alarmId = (alarm.body as { id: string }).id;
    const alarms = await call("GET", "/api/apps/clock/alarms");
    const alarmHash = ((alarms.body as { items: Array<{ id: string; baseHash: string }> }).items).find((row) => row.id === alarmId)!.baseHash;
    const alarmStale = await call("PATCH", `/api/apps/clock/alarms/${alarmId}`, { label: "nope", baseHash: "e".repeat(64) });
    assert.equal(alarmStale.status, 409);
    const alarmSaved = await call("PATCH", `/api/apps/clock/alarms/${alarmId}`, { label: "Morning", baseHash: alarmHash });
    assert.equal(alarmSaved.status, 200);
    const tokyo = await call("POST", "/api/apps/clock/world-clocks", { city: "Tokyo", timezone: "Asia/Tokyo" });
    const london = await call("POST", "/api/apps/clock/world-clocks", { city: "London", timezone: "Europe/London" });
    const clocks = await call("GET", "/api/apps/clock/world-clocks");
    const orderHash = (clocks.body as { orderHash: string }).orderHash;
    const ids = [(london.body as { id: string }).id, (tokyo.body as { id: string }).id];
    const orderStale = await call("PUT", "/api/apps/clock/world-clocks/order", { ids, baseHash: "f".repeat(64) });
    assert.equal(orderStale.status, 409);
    const orderSaved = await call("PUT", "/api/apps/clock/world-clocks/order", { ids, baseHash: orderHash });
    assert.equal(orderSaved.status, 200);

    const focusSettings = await call("GET", "/api/apps/focus/settings");
    const focusMissing = await call("PUT", "/api/apps/focus/settings", {
      focusDurationSeconds: 1500, shortBreakDurationSeconds: 300, longBreakDurationSeconds: 900, longBreakInterval: 4,
    });
    assert.equal(focusMissing.status, 409);
    const focusSaved = await call("PUT", "/api/apps/focus/settings", {
      focusDurationSeconds: 1200, shortBreakDurationSeconds: 300, longBreakDurationSeconds: 900, longBreakInterval: 4,
      baseHash: (focusSettings.body as { baseHash: string }).baseHash,
    });
    assert.equal(focusSaved.status, 200);
    assert.equal((focusSaved.body as { focusDurationSeconds: number }).focusDurationSeconds, 1200);
    const focusState = await call("GET", "/api/apps/focus/state");
    assert.equal(
      (focusState.body as { settings: { baseHash: string } }).settings.baseHash,
      (focusSaved.body as { baseHash: string }).baseHash,
    );
  });

  it("accepts a focus settings write that presents the hash from GET /state", async () => {
    await link("linked");
    const loaded = await call("GET", "/api/apps/focus/state");
    const current = (loaded.body as { settings: { focusDurationSeconds: number; shortBreakDurationSeconds: number; longBreakDurationSeconds: number; longBreakInterval: number; baseHash: string } }).settings;
    const oldHash = current.baseHash;
    const firstDuration = current.focusDurationSeconds === 1600 ? 1700 : 1600;
    const fields = {
      shortBreakDurationSeconds: current.shortBreakDurationSeconds,
      longBreakDurationSeconds: current.longBreakDurationSeconds,
      longBreakInterval: current.longBreakInterval,
    };
    const saved = await call("PUT", "/api/apps/focus/settings", {
      ...fields, focusDurationSeconds: firstDuration, baseHash: oldHash,
    });
    assert.equal(saved.status, 200);
    const reloaded = await call("GET", "/api/apps/focus/state");
    const next = (reloaded.body as { settings: { baseHash: string; focusDurationSeconds: number } }).settings;
    assert.equal(next.focusDurationSeconds, firstDuration);
    assert.equal(next.baseHash, (saved.body as { baseHash: string }).baseHash);
    const stale = await call("PUT", "/api/apps/focus/settings", {
      ...fields, focusDurationSeconds: 1800, baseHash: oldHash,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error?.code, "sync_stale");
    const second = await call("PUT", "/api/apps/focus/settings", {
      ...fields, focusDurationSeconds: 1800, baseHash: next.baseHash,
    });
    assert.equal(second.status, 200);
    const after = await call("GET", "/api/apps/focus/state");
    assert.equal((after.body as { settings: { focusDurationSeconds: number; baseHash: string } }).settings.focusDurationSeconds, 1800);
    assert.equal(
      (after.body as { settings: { baseHash: string } }).settings.baseHash,
      (second.body as { baseHash: string }).baseHash,
    );
  });

  it("keeps note links when an old aggregate loses and lets a later hash win", async () => {
    await link("linked");
    const tag = await call("POST", "/api/apps/notes/tags", { name: `fence-${randomUUID().slice(0, 8)}` });
    const tagId = (tag.body as { id: string }).id;
    const note = await call("POST", "/api/apps/notes/notes", { content: "linked", tagIds: [tagId] });
    const noteId = (note.body as { id: string }).id;
    const loaded = await call("GET", `/api/apps/notes/notes/${noteId}`);
    const hash = (loaded.body as { baseHash: string }).baseHash;
    assert.equal((loaded.body as { tags: unknown[] }).tags.length, 1);

    const holder = await db.getClient();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE notes.notes, notes.note_tags, notes.tags IN ROW EXCLUSIVE MODE");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('notes'), hashtext($1))", [userId]);
    const pending = call("PATCH", `/api/apps/notes/notes/${noteId}`, { content: "from waiter", baseHash: hash });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    await holder.query("UPDATE notes.notes SET content = 'from holder' WHERE id = $1", [noteId]);
    await holder.query("COMMIT");
    holder.release();
    const lost = await pending;
    assert.equal(lost.status, 409);
    assert.equal(lost.body.error?.code, "sync_stale");
    const after = await call("GET", `/api/apps/notes/notes/${noteId}`);
    assert.equal((after.body as { content: string }).content, "from holder");
    assert.equal((after.body as { tags: unknown[] }).tags.length, 1);
    const won = await call("PATCH", `/api/apps/notes/notes/${noteId}`, {
      content: "from client", baseHash: (after.body as { baseHash: string }).baseHash,
    });
    assert.equal(won.status, 200);

    const tagGone = await call("DELETE", `/api/apps/notes/tags/${tagId}`, undefined, { "x-base-hash": "b".repeat(64) });
    assert.equal(tagGone.status, 409);
    const still = await call("GET", `/api/apps/notes/notes/${noteId}`);
    assert.equal((still.body as { tags: unknown[] }).tags.length, 1);
  });

  it("rejects a stale category hash and a stale attachment upload without adding a file", async () => {
    await link("linked");
    const category = await call("POST", "/api/apps/assets/categories", { name: `Cat ${randomUUID().slice(0, 8)}` });
    const categoryId = (category.body as { id: string }).id;
    const listed = await call("GET", "/api/apps/assets/categories");
    const proof = ((listed.body as { items: Array<{ id: string; baseHash: string }> }).items).find((row) => row.id === categoryId)!;
    const stale = await call("PATCH", `/api/apps/assets/categories/${categoryId}`, { name: "Renamed", baseHash: "c".repeat(64) });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const renamed = await call("PATCH", `/api/apps/assets/categories/${categoryId}`, { name: "Renamed", baseHash: proof.baseHash });
    assert.equal(renamed.status, 200);

    const item = await call("POST", "/api/apps/assets/items", { name: "Boxed" });
    const itemId = (item.body as { id: string }).id;
    const detail = await call("GET", `/api/apps/assets/items/${itemId}`);
    const form = multipartBody([{ name: "file", filename: "a.txt", contentType: "text/plain", data: "hello" }]);
    const upload = await platform.app.inject({
      method: "POST",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      payload: form.payload,
      headers: { cookie, ...form.headers, "x-base-hash": "d".repeat(64) },
    });
    assert.equal(upload.statusCode, 409);
    const files = await db.query("SELECT id FROM assets.attachments WHERE item_id = $1", [itemId]);
    assert.equal(files.rowCount, 0);
    assert.equal(typeof (detail.body as { baseHash?: string }).baseHash, "string");
  });

  it("pauses a focus session with the hash returned by start", async () => {
    await link("linked");
    await db.query("DELETE FROM focus.sessions WHERE user_id = $1", [userId]);
    const started = await call("POST", "/api/apps/focus/start", { kind: "focus" });
    assert.equal(started.status, 201);
    const active = (started.body as { state: { active: { revision: number; baseHash?: string } } }).state.active;
    assert.equal(typeof active.baseHash, "string");
    const paused = await call("POST", "/api/apps/focus/pause", { baseRevision: active.revision, baseHash: active.baseHash });
    assert.equal(paused.status, 200);
    await call("POST", "/api/apps/focus/stop", {
      baseRevision: (paused.body as { state: { active: { revision: number; baseHash?: string } } }).state.active.revision,
      baseHash: (paused.body as { state: { active: { baseHash?: string } } }).state.active.baseHash,
    });
  });

  it("returns sync_busy instead of deadlocking while a share lock is held", async () => {
    await link("linked");
    const created = await call("POST", "/api/apps/tasks/tasks", { title: "Busy" });
    const id = (created.body as { id: string }).id;
    const listed = await call("GET", "/api/apps/tasks/tasks");
    const hash = ((listed.body as { items: Array<{ id: string; baseHash: string }> }).items).find((row) => row.id === id)!.baseHash;
    const holder = await db.getClient();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE tasks.tasks IN SHARE ROW EXCLUSIVE MODE");
    const pending = call("PATCH", `/api/apps/tasks/tasks/${id}`, { title: "While locked", baseHash: hash });
    const lost = await pending;
    assert.equal(lost.status, 409);
    assert.equal(lost.body.error?.code, "sync_busy");
    await holder.query("ROLLBACK");
    holder.release();
    const title = await db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id = $1", [id]);
    assert.equal(title.rows[0]!.title, "Busy");
    const saved = await call("PATCH", `/api/apps/tasks/tasks/${id}`, { title: "After lock", baseHash: hash });
    assert.equal(saved.status, 200);
  });

  it("serializes an aggregate reader behind the owner advisory", async () => {
    await link("unlinked");
    const tag = await call("POST", "/api/apps/notes/tags", { name: `order-${randomUUID().slice(0, 8)}` });
    const tagId = (tag.body as { id: string }).id;
    const note = await call("POST", "/api/apps/notes/notes", { content: "order", tagIds: [tagId] });
    const noteId = (note.body as { id: string }).id;
    const holder = await db.getClient();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE notes.notes, notes.note_tags, notes.tags IN ROW EXCLUSIVE MODE");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('notes'), hashtext($1))", [userId]);
    let seen = -1;
    const waiter = db.withTransaction(async (tx) => {
      await lockOwnedTables(tx, ["notes.notes", "notes.note_tags", "notes.tags"]);
      await lockOwnerSet(tx, userId, "notes");
      const links = await tx.query("SELECT note_id FROM notes.note_tags WHERE note_id = $1", [noteId]);
      seen = links.rowCount ?? 0;
      return seen;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    await holder.query("DELETE FROM notes.note_tags WHERE note_id = $1", [noteId]);
    await holder.query("COMMIT");
    holder.release();
    assert.equal(await waiter, 0);
    assert.equal(seen, 0);
  });
});
