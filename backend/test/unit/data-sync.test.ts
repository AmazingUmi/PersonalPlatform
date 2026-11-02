import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { dataLockNames } from "../../src/core/data-management/data-lock.js";
import { readCachedObject, writeCachedObject } from "../../src/core/data-management/sync-cache.js";
import {
  createPairingMaterial, cycleDecision, formatPairingCode, parsePairingCode, projectRow, reconcile,
  recoverPublication, redactSyncText, selectTransfers, semanticHash, syncKeyOf,
} from "../../src/core/data-management/sync-protocol.js";
import { probeConditionalWrites, readStrongEtag } from "../../src/core/data-management/sync-transport.js";
import { columnSignature, validateSyncPlan } from "../../src/core/data-management/sync-validate.js";
import { assertCanonicalCloudRow, buildSyncDocument, changedObjectNames, parseSyncHead, reconstructSyncDocument, syncObjectName } from "../../src/core/data-management/sync-document.js";
import { TABLES, digest, type Column, type Row } from "../../src/core/data-management/snapshot-schema.js";
import { AppError } from "../../src/core/api/errors.js";
import { collectSyncRetentionRefs } from "../../src/core/data-management/sync-service.js";
import type { SyncHead } from "../../src/core/data-management/sync-document.js";

const actor = randomUUID();
const other = randomUUID();
const at = "2026-11-02T00:00:00.000Z";
const origins = process.env.DATA_BACKUP_ALLOWED_ORIGINS;
afterEach(() => {
  if (origins === undefined) delete process.env.DATA_BACKUP_ALLOWED_ORIGINS;
  else process.env.DATA_BACKUP_ALLOWED_ORIGINS = origins;
});

function task(id: string, title: string, owner = other): Row {
  return { id, title, description: null, status: "todo", due_at: null, completed_at: null, created_at: at, updated_at: at, start_at: null, priority: 1, revision: 9, user_id: owner, storage_key: "../secret" };
}
function grid(tile: number): number[][] {
  return [[tile, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
}
const taskColumns: Column[] = [
  { name: "id", type: "uuid", nullable: false },
  { name: "title", type: "text", nullable: false },
  { name: "description", type: "text", nullable: true },
  { name: "status", type: "text", nullable: false },
  { name: "due_at", type: "timestamp with time zone", nullable: true },
  { name: "completed_at", type: "timestamp with time zone", nullable: true },
  { name: "created_at", type: "timestamp with time zone", nullable: false },
  { name: "updated_at", type: "timestamp with time zone", nullable: false },
  { name: "start_at", type: "timestamp with time zone", nullable: true },
  { name: "priority", type: "smallint", nullable: false },
  { name: "user_id", type: "uuid", nullable: false },
];
const tagColumns: Column[] = [
  { name: "id", type: "uuid", nullable: false },
  { name: "name", type: "text", nullable: false },
  { name: "created_at", type: "timestamp with time zone", nullable: false },
  { name: "user_id", type: "uuid", nullable: false },
];
function mapOf(entries: Array<[string, Row]>): Map<string, Row> {
  return new Map(entries);
}

describe("sync canonical identity", () => {
  it("ignores local concurrency metadata and server-owned fields", () => {
    const left = task(randomUUID(), "Buy milk");
    const right = { ...left, updated_at: "2026-11-03T00:00:00.000Z", revision: 40, user_id: actor, storage_key: "server/new" };
    assert.equal(semanticHash(left), semanticHash(right));
    assert.equal(syncKeyOf("tasks.tasks", left), syncKeyOf("tasks.tasks", right));
    assert.equal(projectRow(left).revision, undefined);
    assert.deepEqual(dataLockNames(["notes.notes", "core.users", "notes.notes"]), ["core.users", "notes.notes"]);
  });

  it("round-trips a pairing code without treating the secret as the verifier", () => {
    const material = createPairingMaterial();
    const parsed = parsePairingCode(material.code);
    assert.equal(parsed.identityId, material.identityId);
    assert.equal(parsed.verifier, material.verifier);
    assert.notEqual(parsed.verifier, material.secret.toString("hex"));
    assert.equal(redactSyncText(`code ${material.code} end`), "code ppss1.[redacted] end");
    assert.throws(() => parsePairingCode("ppss1.aa"));
    assert.throws(() => formatPairingCode(material.identityId, Buffer.from("short")));
  });
});

describe("sync reconciliation", () => {
  const id = randomUUID();
  const key = syncKeyOf("tasks.tasks", task(id, "A"));

  it("keeps both sides on a first join and does not treat absence as deletion", () => {
    const localOnly = task(randomUUID(), "Local");
    const remoteOnly = task(randomUUID(), "Remote");
    const result = reconcile({
      baselineEstablished: false,
      base: new Map(),
      local: mapOf([[syncKeyOf("tasks.tasks", localOnly), localOnly], [key, task(id, "Local title")]]),
      remote: mapOf([[syncKeyOf("tasks.tasks", remoteOnly), remoteOnly], [key, task(id, "Cloud title")]]),
      remoteTombstones: new Set([syncKeyOf("tasks.tasks", task(randomUUID(), "gone"))]),
      localTombstones: new Set(),
    });
    assert.equal(result.invalid, null);
    assert.ok(result.actions.some(action => action.type === "conflict" && action.key === key && action.reason === "diverged"));
    assert.ok(result.actions.some(action => action.type === "pending-local" && action.key === syncKeyOf("tasks.tasks", localOnly)));
    assert.ok(result.actions.some(action => action.type === "apply-remote" && action.key === syncKeyOf("tasks.tasks", remoteOnly)));
    const tombstoneKey = syncKeyOf("tasks.tasks", task(randomUUID(), "gone"));
    const joined = reconcile({
      baselineEstablished: false, base: new Map(),
      local: mapOf([[key, task(id, "Keep")]]),
      remote: new Map(),
      remoteTombstones: new Set([key, tombstoneKey]),
      localTombstones: new Set(),
    });
    assert.ok(joined.actions.some(action => action.type === "conflict" && action.reason === "tombstone" && action.key === key));
    assert.ok(joined.actions.some(action => action.type === "adopt-tombstone" && action.key === tombstoneKey));
    assert.equal(joined.actions.some(action => action.type === "delete-local"), false);
  });

  it("publishes a local edit when the cloud head is unchanged", () => {
    const row = task(id, "Edited");
    const actions = reconcile({
      baselineEstablished: true,
      base: new Map([[key, semanticHash(task(id, "Base"))]]),
      local: mapOf([[key, row]]),
      remote: mapOf([[key, task(id, "Base")]]),
      remoteTombstones: new Set(),
      localTombstones: new Set(),
    }).actions;
    assert.equal(cycleDecision(true, actions), "publish");
    assert.equal(cycleDecision(true, [{ type: "unchanged", key }]), "idle");
  });

  it("rejects a head that drops a baseline row without a tombstone", () => {
    const result = reconcile({
      baselineEstablished: true, base: new Map([[key, semanticHash(task(id, "Base"))]]),
      local: mapOf([[key, task(id, "Base")]]), remote: new Map(),
      remoteTombstones: new Set(), localTombstones: new Set(),
    });
    assert.match(result.invalid ?? "", /tombstone/);
    assert.equal(result.actions.length, 0);
  });

  it("raises a game best score without choosing either conflicting board", () => {
    const save = (tile: number, high: number): Row => ({ id: "current", score: tile, board: grid(tile), updated_at: at, high_score: high, revision: 3, user_id: actor });
    const key = syncKeyOf("mini_game.saves", save(2, 10));
    const actions = reconcile({
      baselineEstablished: false, base: new Map(),
      local: mapOf([[key, save(2, 10)]]), remote: mapOf([[key, save(4, 50)]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
    }).actions;
    const conflict = actions.find(action => action.type === "conflict");
    assert.equal(conflict?.type === "conflict" ? conflict.highScore : undefined, 50);
    assert.equal(actions.some(action => action.type === "apply-remote"), false);
  });

  it("keeps the higher game score on a fast-forward and then stops", () => {
    const save = (tile: number, score: number, high: number): Row => ({ id: "current", score, board: grid(tile), updated_at: at, high_score: high, revision: 3, user_id: actor });
    const local = save(2, 10, 100);
    const remote = save(4, 30, 20);
    const key = syncKeyOf("mini_game.saves", local);
    const base = semanticHash(local);
    const first = reconcile({
      baselineEstablished: true, base: new Map([[key, { hash: base, highScore: 100 }]]),
      local: mapOf([[key, local]]), remote: mapOf([[key, remote]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
    }).actions;
    const applied = first.find(action => action.type === "apply-remote");
    assert.equal(applied?.type === "apply-remote" ? applied.row.high_score : undefined, 100);
    assert.equal(applied?.type === "apply-remote" ? applied.row.score : undefined, 30);
    const merged = applied?.type === "apply-remote" ? applied.row : local;
    const publish = reconcile({
      baselineEstablished: true, base: new Map([[key, { hash: semanticHash(merged), highScore: 100 }]]),
      local: mapOf([[key, merged]]), remote: mapOf([[key, remote]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
    }).actions;
    assert.equal(publish.some(action => action.type === "pending-local"), true);
    const settled = reconcile({
      baselineEstablished: true, base: new Map([[key, semanticHash(merged)]]),
      local: mapOf([[key, merged]]), remote: mapOf([[key, merged]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
    }).actions;
    assert.deepEqual(settled.map(action => action.type), ["unchanged"]);
    const onlyScore = reconcile({
      baselineEstablished: true, base: new Map([[key, semanticHash(save(2, 10, 100))]]),
      local: mapOf([[key, save(2, 10, 100)]]), remote: mapOf([[key, save(2, 10, 20)]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
    }).actions;
    assert.equal(onlyScore.some(action => action.type === "pending-local"), true);
    const converged = reconcile({
      baselineEstablished: true, base: new Map([[key, semanticHash(save(2, 10, 100))]]),
      local: mapOf([[key, save(2, 10, 100)]]), remote: mapOf([[key, save(2, 10, 100)]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
    }).actions;
    assert.deepEqual(converged.map(action => action.type), ["unchanged"]);
  });

  it("reconciles an attachment byte change instead of comparing metadata alone", () => {
    const itemId = randomUUID();
    const attachmentId = randomUUID();
    const row: Row = { id: attachmentId, item_id: itemId, filename: "a.bin", content_type: null, size: 4, created_at: at, user_id: actor };
    const key = syncKeyOf("assets.attachments", row);
    const left = digest(Buffer.from("left"));
    const right = digest(Buffer.from("right"));
    const base = semanticHash(row, left);
    const forwarded = reconcile({
      baselineEstablished: true, base: new Map([[key, base]]),
      local: mapOf([[key, row]]), remote: mapOf([[key, row]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
      content: { local: new Map([[key, left]]), remote: new Map([[key, right]]) },
    }).actions;
    assert.equal(forwarded.some(action => action.type === "apply-remote"), true);
    const diverged = reconcile({
      baselineEstablished: true, base: new Map([[key, semanticHash(row, digest(Buffer.from("base")))]]),
      local: mapOf([[key, row]]), remote: mapOf([[key, row]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
      content: { local: new Map([[key, left]]), remote: new Map([[key, right]]) },
    }).actions;
    assert.equal(diverged.some(action => action.type === "conflict" && action.reason === "diverged"), true);
  });

  it("treats a restored local row as a resurrection and rejects a live tombstone", () => {
    const row = task(id, "Restored");
    const restored = reconcile({
      baselineEstablished: true, base: new Map([[key, semanticHash(row)]]),
      local: mapOf([[key, row]]), remote: mapOf([[key, row]]),
      remoteTombstones: new Set(), localTombstones: new Set([key]),
    });
    assert.equal(restored.invalid, null);
    assert.equal(restored.actions.some(action => action.type === "publish-tombstone"), false);
    assert.ok(restored.actions.some(action => action.type === "conflict" && action.reason === "resurrection"));
    const both = reconcile({
      baselineEstablished: true, base: new Map([[key, semanticHash(row)]]),
      local: mapOf([[key, row]]), remote: mapOf([[key, row]]),
      remoteTombstones: new Set([key]), localTombstones: new Set(),
    });
    assert.match(both.invalid ?? "", /live and deleted/);
    assert.equal(both.actions.length, 0);
  });

  it("does not replace a different active focus session", () => {
    const localId = randomUUID(), remoteId = randomUUID();
    const session = (id: string, status: string): Row => ({
      id, kind: "focus", status, planned_duration_seconds: 60, elapsed_before_pause_seconds: 0,
      started_at: at, last_resumed_at: at, paused_at: null, ended_at: null, end_reason: null,
      actual_duration_seconds: null, revision: 2, created_at: at, updated_at: at, user_id: actor,
    });
    const local = session(localId, "running"), remote = session(remoteId, "paused");
    const actions = reconcile({
      baselineEstablished: true, base: new Map([[syncKeyOf("focus.sessions", local), semanticHash(local)]]),
      local: mapOf([[syncKeyOf("focus.sessions", local), local]]),
      remote: mapOf([[syncKeyOf("focus.sessions", local), local], [syncKeyOf("focus.sessions", remote), remote]]),
      remoteTombstones: new Set(), localTombstones: new Set(),
    }).actions;
    assert.ok(actions.some(action => action.type === "conflict" && action.reason === "focus-active"));
    assert.equal(actions.some(action => action.type === "apply-remote"), false);
  });

  it("does not advance the baseline when the capture changed after upload", () => {
    const pending = {
      opToken: randomUUID(), contentHash: "a".repeat(64), captureHash: "b".repeat(64), applied: false,
      parentOpToken: randomUUID(), parentContentHash: "e".repeat(64), parentEtag: "\"parent\"",
    };
    const remote = { remoteEtag: "\"parent\"", localCaptureHash: pending.captureHash };
    assert.equal(recoverPublication({ pending, remoteOpToken: pending.parentOpToken, remoteContentHash: pending.parentContentHash, ...remote }), "retry-same");
    assert.equal(recoverPublication({ pending, remoteOpToken: pending.opToken, remoteContentHash: pending.contentHash, remoteEtag: "\"new\"", localCaptureHash: "c".repeat(64) }), "retain-pending");
    assert.equal(recoverPublication({ pending: { ...pending, applied: true }, remoteOpToken: pending.opToken, remoteContentHash: pending.contentHash, remoteEtag: "\"new\"", localCaptureHash: pending.captureHash }), "commit-remote");
    assert.equal(recoverPublication({ pending: { ...pending, applied: true }, remoteOpToken: randomUUID(), remoteContentHash: "d".repeat(64), remoteEtag: "\"later\"", localCaptureHash: pending.captureHash }), "lost-race");
    assert.equal(recoverPublication({ pending, remoteOpToken: randomUUID(), remoteContentHash: "d".repeat(64), remoteEtag: "\"later\"", localCaptureHash: "c".repeat(64) }), "retain-pending");
  });

  it("continues transfers after cached objects instead of repeating them", () => {
    const needed = ["aa", "bb", "cc", "dd"];
    const first = selectTransfers(needed, new Set(["aa"]), 2);
    assert.deepEqual(first.transfer, ["bb", "cc"]);
    assert.equal(first.done, false);
    const cached = new Set(["aa", ...first.transfer]);
    assert.deepEqual(selectTransfers(needed, cached, 2), { transfer: ["dd"], done: true });
  });
});

describe("sync plan validation", () => {
  const schema = { "notes.tags": digest(Buffer.from("tags")) };
  const columns = new Map([["notes.tags", tagColumns]]);
  const tag = (id: string, name: string, owner = other): Row => ({ id, name, created_at: at, user_id: owner });
  const planInput = (tables: Record<string, Row[]>, extra: Record<string, unknown> = {}) => ({
    actorId: actor, remoteOwnerId: other, columns, schema, expectedSchema: schema, tables, files: [] as [], ...extra,
  });

  it("rewrites the owner after rejecting a foreign owner, duplicates, and a bad task", () => {
    const id = randomUUID();
    const source = [tag(id, "Work")];
    const plan = validateSyncPlan(planInput({ "notes.tags": source }));
    assert.equal(plan.tables["notes.tags"]![0]!.user_id, actor);
    assert.equal(source[0]!.user_id, other);
    assert.equal("storage_key" in plan.tables["notes.tags"]![0]!, false);
    assert.throws(() => validateSyncPlan(planInput({ "notes.tags": [tag(id, "Work", actor)] })), /more than one owner/);
    assert.throws(() => validateSyncPlan({
      ...planInput({ "notes.tags": [tag(id, "Work")] }), expectedSchema: { "notes.tags": "other" },
    }), (error: AppError) => error.code === "invalid_sync");
    assert.throws(() => validateSyncPlan(planInput({ "notes.tags": [tag(id, "Work"), tag(randomUUID(), "Work")] })), /Duplicate name/);
    assert.throws(() => validateSyncPlan(planInput({ "notes.tags": [tag(id, "Work"), tag(id, "Other")] })), /Duplicate primary key/);
    assert.throws(() => validateSyncPlan(planInput({ "core.users": [tag(id, "Work")] }, { schema: { "core.users": schema["notes.tags"] }, expectedSchema: { "core.users": schema["notes.tags"] } })), /core data/);
    const malformed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    assert.throws(() => validateSyncPlan({
      actorId: malformed, remoteOwnerId: malformed, columns: new Map([["tasks.tasks", taskColumns]]),
      schema: { "tasks.tasks": "schema" }, expectedSchema: { "tasks.tasks": "schema" },
      tables: { "tasks.tasks": [{ id: rowId, user_id: malformed, title: 42, status: "bogus" }] }, files: [],
    }), (error: AppError) => error.code === "invalid_sync");
    const wire = task(rowId, "Milk", malformed);
    delete wire.revision;
    delete wire.storage_key;
    const completeBad = { ...wire, title: 42, status: "bogus" };
    assert.throws(() => validateSyncPlan({
      actorId: malformed, remoteOwnerId: malformed, columns: new Map([["tasks.tasks", taskColumns]]),
      schema: { "tasks.tasks": "schema" }, expectedSchema: { "tasks.tasks": "schema" },
      tables: { "tasks.tasks": [completeBad] }, files: [],
    }), /Invalid value|Invalid task status/);
    const accepted = validateSyncPlan({
      actorId: malformed, remoteOwnerId: malformed, columns: new Map([["tasks.tasks", taskColumns]]),
      schema: { "tasks.tasks": "schema" }, expectedSchema: { "tasks.tasks": "schema" },
      tables: { "tasks.tasks": [wire] }, files: [],
    });
    assert.equal(accepted.tables["tasks.tasks"]![0]!.title, "Milk");
    assert.equal(accepted.tables["tasks.tasks"]![0]!.storage_key, undefined);
  });

  it("changes the attachment hash when the bytes change", () => {
    const itemId = randomUUID();
    const attachmentId = randomUUID();
    const item: Row = {
      id: itemId, name: "Lens", description: null, quantity: 1, acquired_at: null,
      created_at: at, updated_at: at, target_location: null, user_id: other,
    };
    const left = Buffer.from("left-bytes");
    const right = Buffer.from("right-bytes");
    const attachment = (bytes: Buffer): Row => ({
      id: attachmentId, item_id: itemId, filename: "a.bin", content_type: null, size: bytes.length,
      storage_key: "server/owned", created_at: at, user_id: other,
    });
    const file = (bytes: Buffer) => ({ attachmentId, sha256: digest(bytes), size: bytes.length, data: bytes.toString("base64") });
    const catalog = new Map<string, Column[]>([
      ["assets.items", [
        { name: "id", type: "uuid", nullable: false }, { name: "name", type: "text", nullable: false },
        { name: "description", type: "text", nullable: true }, { name: "quantity", type: "integer", nullable: false },
        { name: "acquired_at", type: "date", nullable: true }, { name: "created_at", type: "timestamp with time zone", nullable: false },
        { name: "updated_at", type: "timestamp with time zone", nullable: false }, { name: "target_location", type: "text", nullable: true },
        { name: "user_id", type: "uuid", nullable: false },
      ]],
      ["assets.attachments", [
        { name: "id", type: "uuid", nullable: false }, { name: "item_id", type: "uuid", nullable: false },
        { name: "filename", type: "text", nullable: false }, { name: "content_type", type: "text", nullable: true },
        { name: "size", type: "bigint", nullable: false }, { name: "storage_key", type: "text", nullable: false },
        { name: "created_at", type: "timestamp with time zone", nullable: false }, { name: "user_id", type: "uuid", nullable: false },
      ]],
    ]);
    const fingerprints = { "assets.items": digest(Buffer.from("items")), "assets.attachments": digest(Buffer.from("files")) };
    const run = (bytes: Buffer, storageKey: string) => validateSyncPlan({
      actorId: actor, remoteOwnerId: other, columns: catalog, schema: fingerprints, expectedSchema: fingerprints,
      tables: { "assets.items": [item], "assets.attachments": [{ ...attachment(bytes), storage_key: storageKey }] },
      files: [file(bytes)],
    });
    const first = run(left, "server/owned");
    const moved = run(left, "server/other");
    const replaced = run(right, "server/owned");
    const key = syncKeyOf("assets.attachments", attachment(left));
    assert.equal(first.hashes.get(key), moved.hashes.get(key));
    assert.notEqual(first.hashes.get(key), replaced.hashes.get(key));
    assert.equal(first.tables["assets.attachments"]![0]!.storage_key, undefined);
    assert.throws(() => validateSyncPlan({
      actorId: actor, remoteOwnerId: other, columns: catalog, schema: fingerprints, expectedSchema: fingerprints,
      tables: { "assets.items": [item], "assets.attachments": [attachment(left)] },
      files: [{ ...file(left), size: left.length + 1 }],
    }), /size/);
  });
});

describe("sync conditional WebDAV probe", () => {
  it("accepts only a strong GET ETag", () => {
    assert.equal(readStrongEtag("\"abc\""), "\"abc\"");
    assert.equal(readStrongEtag("W/\"abc\""), null);
    assert.equal(readStrongEtag(undefined), null);
    assert.equal(readStrongEtag("abc"), null);
    assert.equal(readStrongEtag("\"\""), null);
    assert.equal(readStrongEtag("\"ab\r\n\""), null);
    assert.equal(readStrongEtag("\"" + "x".repeat(129) + "\""), null);
  });

  it("keeps auth, rate-limit, and network errors distinct from a missing CAS", async () => {
    const denied = await mockDav({ status: 401 });
    const limited = await mockDav({ status: 429 });
    process.env.DATA_BACKUP_ALLOWED_ORIGINS = `${new URL(denied.auth.endpoint).origin},${new URL(limited.auth.endpoint).origin}`;
    try {
      await assert.rejects(probeConditionalWrites(denied.auth), (error: AppError) => error.code === "webdav_failed" && (error.details as { status: number }).status === 401);
      await assert.rejects(probeConditionalWrites(limited.auth), (error: AppError) => error.code === "webdav_failed" && (error.details as { status: number }).status === 429);
    } finally {
      await denied.close();
      await limited.close();
    }
    process.env.DATA_BACKUP_ALLOWED_ORIGINS = "http://127.0.0.1:1";
    await assert.rejects(probeConditionalWrites({ endpoint: "http://127.0.0.1:1/dav/", username: "user", password: "secret" }), (error: AppError) => error.code === "webdav_unreachable");
  });

  it("records an unconditional overwrite instead of enabling sync", async () => {
    const server = await mockDav({ unconditional: true });
    try {
      await assert.rejects(probeConditionalWrites(server.auth), (error: AppError) => {
        assert.equal(error.code, "webdav_cas_unsupported");
        assert.equal((error.details as { step: string }).step, "create-if-absent");
        assert.doesNotMatch(error.message, /secret/);
        return true;
      });
    } finally { await server.close(); }
  });

  it("fails closed when GET never returns a strong ETag", async () => {
    const server = await mockDav({ weak: true });
    try {
      await assert.rejects(probeConditionalWrites(server.auth), (error: AppError) => error.code === "webdav_cas_unsupported" && (error.details as { step: string }).step === "etag");
    } finally { await server.close(); }
  });

  it("passes create protection, a wrong tag, a stale tag, and the current tag", async () => {
    const server = await mockDav({});
    try {
      await probeConditionalWrites(server.auth);
      assert.ok(server.puts >= 4);
    } finally { await server.close(); }
  });
});

describe("sync object cache", () => {
  it("stores bytes by hash under the user directory and rejects a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pp-sync-cache-"));
    const user = randomUUID();
    const bytes = Buffer.from("attachment");
    const sha = digest(bytes);
    try {
      const path = await writeCachedObject(root, user, sha, bytes);
      assert.match(path, new RegExp(`${user}/${sha}$`));
      assert.deepEqual(await readCachedObject(root, user, sha), bytes);
      assert.equal(await writeCachedObject(root, user, sha, bytes), path);
      await writeFile(path, Buffer.from("corrupt"));
      await assert.rejects(readCachedObject(root, user, sha), /hash/);
      assert.deepEqual(await readCachedObject(root, user, sha).catch(() => writeCachedObject(root, user, sha, bytes).then(() => readCachedObject(root, user, sha))), bytes);
      const outside = join(root, "outside-target");
      await writeFile(outside, Buffer.from("keep-me"));
      await symlink(outside, path + ".partial");
      assert.deepEqual(await readCachedObject(root, user, sha), bytes);
      await rm(path);
      assert.equal(await writeCachedObject(root, user, sha, bytes), join(root, ".sync", user, sha));
      assert.equal(await readFile(outside, "utf8"), "keep-me");
      await Promise.all([writeCachedObject(root, user, sha, bytes), writeCachedObject(root, user, sha, bytes)]);
      assert.deepEqual(await readCachedObject(root, user, sha), bytes);
      await rm(path);
      await symlink(root, path);
      await assert.rejects(readCachedObject(root, user, sha), /symlink/);
      await rm(path);
      const outsideDir = await mkdtemp(join(tmpdir(), "pp-sync-outside-"));
      await rm(join(root, ".sync"), { recursive: true, force: true });
      await symlink(outsideDir, join(root, ".sync"));
      await assert.rejects(writeCachedObject(root, user, sha, bytes), /symlink/);
      await assert.rejects(readCachedObject(root, user, sha), /symlink/);
      await rm(join(root, ".sync"));
      await mkdir(join(root, ".sync"), { mode: 0o700 });
      await symlink(outsideDir, join(root, ".sync", user));
      await assert.rejects(writeCachedObject(root, user, sha, bytes), /symlink/);
      await rm(outsideDir, { recursive: true, force: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("sync content objects", () => {
  it("rewrites one row bucket when one tag changes", async () => {
    const identity = randomUUID();
    const verifier = "ab".repeat(32);
    const fingerprint = columnSignature(tagColumns);
    const row = (name: string): Row => ({ id: randomUUID(), name, created_at: at, user_id: actor });
    const firstRow = row("Work");
    const snapshot = (rows: Row[]) => ({
      type: "personal-platform-data" as const, formatVersion: 1 as const, createdAt: at, scope: "own" as const,
      source: { id: actor, username: "owner" }, schema: { "notes.tags": fingerprint },
      tables: { "notes.tags": rows }, files: [],
    });
    const gone = syncKeyOf("tasks.tasks", task(randomUUID(), "Gone", actor));
    const before = buildSyncDocument({ snapshot: snapshot([firstRow]), identityId: identity, pairingVerifier: verifier, generation: 1, tombstones: [gone] });
    const otherOwner = buildSyncDocument({ snapshot: snapshot([{ ...firstRow, user_id: other, revision: 9, storage_key: "other/key", updated_at: "2026-11-03T00:00:00.000Z" }]), identityId: identity, pairingVerifier: verifier, generation: 4, tombstones: [gone] });
    assert.deepEqual(changedObjectNames(before, otherOwner), []);
    const after = buildSyncDocument({ snapshot: snapshot([{ ...firstRow, name: "Home" }]), identityId: identity, pairingVerifier: verifier, generation: 2, opToken: randomUUID(), parentOpToken: before.head.opToken, tombstones: [gone] });
    assert.deepEqual(changedObjectNames(before, after), [after.head.tables["notes.tags"]![0]!.object.filename]);
    assert.equal(before.head.tombstones.sha256, after.head.tombstones.sha256);
    assert.throws(() => parseSyncHead({ ...after.head, formatVersion: 2 }), /Unsupported/);
    assert.throws(() => parseSyncHead(after.head, randomUUID()), /identity/);
    assert.throws(() => parseSyncHead({ ...after.head, contentHash: "ef".repeat(32) }), /content hash/);
    assert.throws(() => parseSyncHead({ ...after.head, tombstones: { ...after.head.tombstones, filename: "pps-" + identity + "-../evil.json" } }), /Unsafe|object name|reference/);
    const columns = new Map([["notes.tags", tagColumns]]);
    const plan = await reconstructSyncDocument(after.head, async ref => after.objects.get(ref.filename)!.data, columns, actor);
    assert.equal(plan.tables["notes.tags"]![0]!.name, "Home");
    assert.deepEqual(plan.tombstones, [gone]);
    assert.equal(plan.tables["notes.tags"]![0]!.user_id, actor);
    const mismatched = new Map([["notes.tags", tagColumns.map(column => column.name === "name" ? { ...column, type: "integer" } : column)]]);
    await assert.rejects(reconstructSyncDocument(after.head, async ref => after.objects.get(ref.filename)!.data, mismatched, actor), (error: unknown) => error instanceof AppError && error.code === "invalid_sync");
    await assert.rejects(reconstructSyncDocument(after.head, async () => Buffer.from("nope"), columns, actor), /SHA-256|size/);
    const attachment = { filename: syncObjectName(identity, after.head.tombstones.sha256, "attachment"), sha256: after.head.tombstones.sha256, size: after.head.tombstones.size, kind: "attachment" as const };
    const repeated = { ...after.head, files: Array.from({ length: 1024 }, () => ({ attachmentId: randomUUID(), object: attachment })) };
    assert.throws(() => parseSyncHead(repeated), (error: unknown) => error instanceof AppError && /1024/.test(error.message));
    assert.throws(() => parseSyncHead([]), (error: unknown) => error instanceof AppError);
    assert.throws(() => parseSyncHead({ ...after.head, tables: [] }), (error: unknown) => error instanceof AppError);
    assert.throws(() => parseSyncHead({ ...after.head, tables: { "notes.tags": [{ bucket: 0, object: after.head.tombstones }, { bucket: 0, object: after.head.tombstones }] } }), (error: unknown) => error instanceof AppError);
    assert.throws(() => parseSyncHead({ ...after.head, files: [{ attachmentId: "not-a-uuid", object: after.head.tombstones }] }), (error: unknown) => error instanceof AppError);
  });

  it("round-trips attachment bytes and rejects a bad catalog before apply", async () => {
    const identity = randomUUID();
    const itemId = randomUUID();
    const attachmentId = randomUUID();
    const bytes = Buffer.from("round-trip");
    const itemColumns: Column[] = [
      { name: "id", type: "uuid", nullable: false }, { name: "name", type: "text", nullable: false },
      { name: "description", type: "text", nullable: true }, { name: "quantity", type: "integer", nullable: false },
      { name: "acquired_at", type: "date", nullable: true }, { name: "created_at", type: "timestamp with time zone", nullable: false },
      { name: "updated_at", type: "timestamp with time zone", nullable: false }, { name: "target_location", type: "text", nullable: true },
      { name: "user_id", type: "uuid", nullable: false },
    ];
    const attachmentColumns: Column[] = [
      { name: "id", type: "uuid", nullable: false }, { name: "item_id", type: "uuid", nullable: false },
      { name: "filename", type: "text", nullable: false }, { name: "content_type", type: "text", nullable: true },
      { name: "size", type: "bigint", nullable: false }, { name: "storage_key", type: "text", nullable: false },
      { name: "created_at", type: "timestamp with time zone", nullable: false }, { name: "user_id", type: "uuid", nullable: false },
    ];
    const columns = new Map<string, Column[]>([["assets.items", itemColumns], ["assets.attachments", attachmentColumns]]);
    const snapshot = {
      type: "personal-platform-data" as const, formatVersion: 1 as const, createdAt: at, scope: "own" as const,
      source: { id: actor, username: "owner" },
      schema: { "assets.items": columnSignature(itemColumns), "assets.attachments": columnSignature(attachmentColumns) },
      tables: {
        "assets.items": [{ id: itemId, name: "Lens", description: null, quantity: 1, acquired_at: null, created_at: at, updated_at: at, target_location: null, user_id: other }],
        "assets.attachments": [{ id: attachmentId, item_id: itemId, filename: "a.bin", content_type: null, size: bytes.length, storage_key: "server/old", created_at: at, user_id: other }],
      },
      files: [{ attachmentId, sha256: digest(bytes), data: bytes.toString("base64") }],
    };
    const document = buildSyncDocument({ snapshot, identityId: identity, pairingVerifier: "ab".repeat(32), generation: 1, tombstones: [] });
    const plan = await reconstructSyncDocument(document.head, async ref => document.objects.get(ref.filename)!.data, columns, actor);
    assert.equal(plan.files[0]!.data, bytes.toString("base64"));
    assert.equal(plan.hashes.get(syncKeyOf("assets.attachments", snapshot.tables["assets.attachments"][0]!)), semanticHash(plan.tables["assets.attachments"]![0]!, digest(bytes)));
    assert.equal(plan.tables["assets.attachments"]![0]!.storage_key, undefined);
    const missing: Row = { ...snapshot.tables["assets.items"][0]! };
    delete missing.name;
    assert.throws(() => validateSyncPlan({
      actorId: actor, remoteOwnerId: other, columns: new Map([["assets.items", itemColumns]]),
      schema: { "assets.items": columnSignature(itemColumns) }, expectedSchema: { "assets.items": columnSignature(itemColumns) },
      tables: { "assets.items": [missing] }, files: [],
    }), (error: unknown) => error instanceof AppError && error.code === "invalid_sync");
    assert.throws(() => validateSyncPlan({
      actorId: actor, remoteOwnerId: other, columns: new Map([["assets.items", itemColumns]]),
      schema: { "assets.items": columnSignature(itemColumns) }, expectedSchema: { "assets.items": "ff".repeat(32) },
      tables: { "assets.items": [snapshot.tables["assets.items"][0]!] }, files: [],
    }), (error: unknown) => error instanceof AppError);
  });

  it("keeps a user-scoped bucket stable when the local account id changes", () => {
    const identity = randomUUID();
    const board = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const save = (owner: string, revision: number): Row => ({ id: "current", score: 2, board, updated_at: at, high_score: 4, revision, user_id: owner });
    const document = (owner: string, revision: number) => buildSyncDocument({
      snapshot: {
        type: "personal-platform-data", formatVersion: 1, createdAt: at, scope: "own", source: { id: owner, username: "owner" },
        schema: { "mini_game.saves": "ab".repeat(32) }, tables: { "mini_game.saves": [save(owner, revision)] }, files: [],
      },
      identityId: identity, pairingVerifier: "cd".repeat(32), generation: revision,
    });
    const left = document(actor, 1);
    const right = document(other, 9);
    assert.equal(left.head.tables["mini_game.saves"]![0]!.bucket, right.head.tables["mini_game.saves"]![0]!.bucket);
    assert.deepEqual(changedObjectNames(left, right), []);
    const changed = buildSyncDocument({
      snapshot: {
        type: "personal-platform-data", formatVersion: 1, createdAt: at, scope: "own", source: { id: actor, username: "owner" },
        schema: { "mini_game.saves": "ab".repeat(32) }, tables: { "mini_game.saves": [{ ...save(actor, 1), score: 8 }] }, files: [],
      },
      identityId: identity, pairingVerifier: "cd".repeat(32), generation: 3,
    });
    assert.equal(changed.head.tables["mini_game.saves"]![0]!.bucket, left.head.tables["mini_game.saves"]![0]!.bucket);
    assert.deepEqual(changedObjectNames(left, changed), [changed.head.tables["mini_game.saves"]![0]!.object.filename]);
  });

  it("rejects a forged cloud owner before hydration fills the identity", () => {
    const spec = TABLES.find(table => table.name === "notes.tags")!;
    const identity = randomUUID();
    const row = { id: randomUUID(), name: "Work", created_at: at, user_id: other };
    assert.throws(() => assertCanonicalCloudRow(row, spec, identity), (error: unknown) => error instanceof AppError && error.code === "invalid_sync");
    assert.equal(row.user_id, other);
    assert.throws(() => assertCanonicalCloudRow({ ...row, user_id: identity, storage_key: "secret" }, spec, identity), /Unexpected cloud field/);
  });
});

describe("sync retention refs", () => {
  it("protects every head object, both conflict hashes, and live storage keys", () => {
    const head = {
      tombstones: { sha256: "aa".repeat(32) },
      files: [{ object: { sha256: "bb".repeat(32) } }],
      tables: { "tasks.tasks": [{ object: { sha256: "cc".repeat(32) } }] },
    } as unknown as SyncHead;
    const pending = {
      tombstones: { sha256: "dd".repeat(32) },
      files: [],
      tables: {},
    } as unknown as SyncHead;
    const refs = collectSyncRetentionRefs({
      heads: [head, pending, null],
      conflictHashes: ["ee".repeat(32), null, "ff".repeat(32)],
      storageKeys: ["sync/" + randomUUID(), "imports/keep"],
    });
    assert.equal(refs.cacheHashes.size, 6);
    assert.ok(refs.cacheHashes.has("aa".repeat(32)));
    assert.ok(refs.cacheHashes.has("cc".repeat(32)));
    assert.ok(refs.cacheHashes.has("ee".repeat(32)));
    assert.ok(refs.storageKeys.has("imports/keep"));
  });
});

async function mockDav(options: { unconditional?: boolean; weak?: boolean; status?: number }): Promise<{ auth: { endpoint: string; username: string; password: string }; puts: number; close: () => Promise<void> }> {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  let serial = 0;
  const stats = { puts: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const current = objects.get(req.url!);
    if (req.method === "PUT") {
      if (options.status) { res.writeHead(options.status).end(); return; }
      stats.puts++;
      const match = req.headers["if-match"];
      const create = req.headers["if-none-match"] === "*";
      if (create && current && !options.unconditional) { res.writeHead(412).end(); return; }
      if (!options.unconditional && typeof match === "string" && (!current || match !== current.etag)) { res.writeHead(412).end(); return; }
      serial += 1;
      objects.set(req.url!, { body, etag: `"v${serial}"` });
      res.writeHead(current ? 204 : 201).end();
      return;
    }
    if (!current) { res.writeHead(404).end(); return; }
    res.setHeader("etag", options.weak ? `W/${current.etag}` : current.etag);
    res.writeHead(200).end(body.length ? undefined : current.body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.DATA_BACKUP_ALLOWED_ORIGINS = origin;
  return {
    get puts() { return stats.puts; }, auth: { endpoint: `${origin}/dav/`, username: "user", password: "secret" },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
