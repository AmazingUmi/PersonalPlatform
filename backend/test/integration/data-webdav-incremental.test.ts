import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "../../src/core/database/index.js";
import { runAppMigrations } from "../../src/core/database/startup-migrations.js";
import { createAppStorage } from "../../src/core/storage/local.js";
import { AppError } from "../../src/core/api/errors.js";
import { WebdavBackups, type BackupActor, type WebdavInput, type BackupRunResult } from "../../src/core/data-management/webdav.js";
import { exportSnapshot, type Snapshot } from "../../src/core/data-management/snapshot.js";
import { TABLES } from "../../src/core/data-management/snapshot-schema.js";
import { parseManifest, getObjectRefs, canonicalJson } from "../../src/core/data-management/incremental.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { createTestUser, ensureTestAdmin } from "../helpers/platform.js";

let db: Database, root: string, alice: BackupActor, bob: BackupActor, admin: BackupActor;
let config: WebdavInput, server: http.Server;
let clock = new Date("2026-11-01T12:00:00Z");
let taskId: string, itemId: string;
const objects = new Map<string, Buffer>();
const requests: { method: string; key: string; status: number }[] = [];
const services: WebdavBackups[] = [];
const originalOrigins = process.env.DATA_BACKUP_ALLOWED_ORIGINS;
const originalKey = process.env.DATA_BACKUP_ENCRYPTION_KEY;
let failPut: ((key: string) => boolean) | undefined;
let failGet: ((method: string, key: string) => number | undefined) | undefined;
let responseHook: ((method: string, key: string) => Promise<void>) | undefined;
const payload = Buffer.from([0, 255, 1, 2, 128, 7]);
const keyFor = (filename: string, username = "dav") => `${username}|/backups/${filename}`;
function created(result: BackupRunResult) { assert.equal(result.status, "created"); assert(result.backup); return result.backup; }
function manager() {
  const value = new WebdavBackups({ database: db, storageRoot: root, installedApps: () => [], now: () => clock });
  services.push(value); return value;
}
async function snapshot(actor = alice, scope: "own" | "all" = "own") {
  return exportSnapshot({ database: db, storageRoot: root, actor, scope });
}
async function assertSnapshot(actual: Snapshot, expected: Snapshot) {
  assert.equal(actual.type, expected.type); assert.equal(actual.scope, expected.scope);
  assert.deepEqual(actual.source, expected.source); assert.deepEqual(actual.schema, expected.schema);
  assert.deepEqual(Object.keys(actual.tables).sort(), Object.keys(expected.tables).sort());
  for (const name of Object.keys(expected.tables)) {
    assert.deepEqual(actual.tables[name]!.map(row => canonicalJson(row)).sort(), expected.tables[name]!.map(row => canonicalJson(row)).sort(), name);
  }
  assert.deepEqual(actual.files.map(file => canonicalJson(file)).sort(), expected.files.map(file => canonicalJson(file)).sort());
}
async function attachment(filename: string, bytes = payload) {
  const id = randomUUID();
  await db.query("INSERT INTO assets.attachments(id,user_id,item_id,filename,size,storage_key) VALUES($1,$2,$3,$4,$5,$6)", [id, alice.id, itemId, filename, bytes.length, filename]);
  await createAppStorage(root, "assets").forUser(alice.id).save(filename, bytes);
  return id;
}

before(async () => {
  delete process.env.DATA_BACKUP_ENCRYPTION_KEY;
  db = await resetDatabase();
  admin = { id: await ensureTestAdmin(db), role: "admin" };
  alice = { id: (await createTestUser(db, "inc-alice")).id, role: "user" };
  bob = { id: (await createTestUser(db, "inc-bob")).id, role: "user" };
  await runAppMigrations({ databaseUrl: TEST_DATABASE_URL, manifestsDir: resolve(import.meta.dirname, "../../../apps") });
  server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization?.replace(/^Basic /, "") ?? "", "base64").toString();
    const split = auth.indexOf(":"); const user = auth.slice(0, split);
    const key = `${user}|${req.url}`;
    const record = (status: number) => { requests.push({ method: req.method!, key, status }); res.writeHead(status); };
    const forced = failGet?.(req.method!, key);
    if (forced) { record(forced); res.end(); return; }
    if (auth.slice(split + 1) !== "secret") { record(401); res.end(); return; }
    if (req.method === "PUT") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      assert.equal(req.headers["if-none-match"], "*");
      if (failPut?.(key)) { record(503); res.end(); return; }
      if (objects.has(key)) { record(412); res.end(); return; }
      objects.set(key, Buffer.concat(chunks)); await responseHook?.("PUT", key); record(201); res.end(); return;
    }
    const body = objects.get(key);
    if (req.method === "PROPFIND") { record(207); res.end('<d:multistatus xmlns:d="DAV:"/>'); return; }
    if (!body) { record(404); res.end(); return; }
    res.setHeader("content-length", body.length); await responseHook?.(req.method!, key); record(200); res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  process.env.DATA_BACKUP_ALLOWED_ORIGINS = origin;
  config = { endpoint: origin + "/backups/", username: "dav", password: "secret", scope: "own", intervalHours: 1 };
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pp-incremental-dav-"));
  objects.clear(); requests.length = 0; failPut = undefined; failGet = undefined; responseHook = undefined; clock = new Date("2026-11-01T12:00:00Z");
  await db.query("DELETE FROM core.backup_history"); await db.query("DELETE FROM core.backup_targets");
  await db.query("TRUNCATE " + TABLES.filter(table => !table.name.startsWith("core.")).map(table => table.name).join(",") + " CASCADE");
  await db.query("UPDATE core.users SET status='active', role=CASE WHEN id=$1 THEN 'admin' ELSE 'user' END", [admin.id]);
  taskId = randomUUID(); itemId = randomUUID();
  await db.query("INSERT INTO tasks.tasks(id,user_id,title) VALUES($1,$2,'first'),($3,$2,'second'),($4,$5,'private to bob')", [taskId, alice.id, randomUUID(), randomUUID(), bob.id]);
  await db.query("INSERT INTO assets.items(id,user_id,name) VALUES($1,$2,'camera')", [itemId, alice.id]);
  await attachment("photo-a.bin"); await attachment("photo-b.bin");
});
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); await rm(root, {recursive: true, force: true}); });
after(async () => {
  if (db) await db.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (originalOrigins === undefined) delete process.env.DATA_BACKUP_ALLOWED_ORIGINS; else process.env.DATA_BACKUP_ALLOWED_ORIGINS = originalOrigins;
  if (originalKey === undefined) delete process.env.DATA_BACKUP_ENCRYPTION_KEY; else process.env.DATA_BACKUP_ENCRYPTION_KEY = originalKey;
});

describe("incremental WebDAV against a real HTTP server", () => {
  it("deduplicates binary attachments, uploads one changed row bucket and reconstructs each historical state", async () => {
    const service = manager(); await service.save(alice, config);
    const original = await snapshot(); const first = created(await service.run(alice));
    const manifest = parseManifest(objects.get(keyFor(first.filename))!);
    assert.equal(manifest.files.length, 2); assert.equal(new Set(manifest.files.map(file => file.object.filename)).size, 1);
    assert.equal(requests.filter(request => request.method === "PUT" && request.key.endsWith(".bin")).length, 1);
    await assertSnapshot(JSON.parse((await service.download(alice, first.id)).data.toString()) as Snapshot, original);
    requests.length = 0;
    await db.query("UPDATE tasks.tasks SET title='changed' WHERE id=$1", [taskId]);
    const changed = await snapshot(); const second = created(await service.run(alice));
    assert.equal(requests.filter(request => request.method === "PUT").length, 2, "one row bucket plus manifest");
    assert.equal(requests.filter(request => request.method === "PUT" && request.key.endsWith(".bin")).length, 0);
    await assertSnapshot(JSON.parse((await service.download(alice, second.id)).data.toString()) as Snapshot, changed);
    await assertSnapshot(JSON.parse((await service.download(alice, first.id)).data.toString()) as Snapshot, original);
    await db.query("DELETE FROM tasks.tasks WHERE id=$1", [taskId]);
    await db.query("DELETE FROM assets.attachments WHERE filename='photo-a.bin'");
    const deleted = await snapshot(); const third = created(await service.run(alice));
    await assertSnapshot(JSON.parse((await service.download(alice, third.id)).data.toString()) as Snapshot, deleted);
    assert(!(JSON.parse((await service.download(alice, third.id)).data.toString()) as Snapshot).tables['tasks.tasks']!.some(row => row.id === taskId));
  });

  it("skips unchanged timestamps, repairs missing objects, and resumes the persisted schedule after restart", async () => {
    const service = manager(); await service.save(alice, config);
    const first = created(await service.run(alice)); requests.length = 0;
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    const unchanged = await service.run(alice);
    assert.equal(unchanged.status, "unchanged"); assert.equal(unchanged.uploadedBytes, 0); assert.equal(unchanged.uploadedObjects, 0);
    assert.equal(requests.filter(request => request.method === "PUT").length, 0); assert.equal((await service.history(alice)).items.length, 1);
    const manifest = parseManifest(objects.get(keyFor(first.filename))!); const ref = getObjectRefs(manifest)[0]!;
    objects.delete(keyFor(ref.filename)); requests.length = 0;
    const repaired = await service.run(alice);
    assert.equal(repaired.status, "unchanged"); assert.equal(repaired.uploadedObjects, 1); assert.equal(repaired.uploadedBytes, ref.size);
    assert.equal((await service.history(alice)).items.length, 1); assert(objects.has(keyFor(ref.filename)));
    await service.stop(); const restarted = manager();
    clock = new Date(clock.getTime() + 2 * 3_600_000); requests.length = 0;
    await restarted.tick(); assert.equal((await restarted.config(alice)).lastStatus, "unchanged");
    assert.equal(requests.filter(request => request.method === "PUT").length, 0);
  });

  it("rebuilds a new manifest when the previous one is missing, including after a full backup, and repairs missing objects", async () => {
    const service = manager(); await service.save(alice, config);
    const first = created(await service.run(alice));
    const full = created(await service.run(alice, false, "full"));
    const before = await snapshot();
    objects.delete(keyFor(first.filename)); requests.length = 0;
    const recovered = created(await service.run(alice));
    assert.notEqual(recovered.id, first.id); assert.equal(recovered.kind, "incremental");
    assert.deepEqual((await service.history(alice)).items.map(item => item.id), [recovered.id, full.id, first.id]);
    assert(objects.has(keyFor(full.filename)));
    assert(requests.some(request => request.method === "PUT" && request.status === 412 && request.key.endsWith(".bin")));
    assert.equal(requests.filter(request => request.method === "PUT" && request.status === 201 && request.key.includes("ppm-")).length, 1);
    await assertSnapshot(JSON.parse((await service.download(alice, recovered.id)).data.toString()) as Snapshot, before);
    requests.length = 0;
    const unchanged = await service.run(alice);
    assert.equal(unchanged.status, "unchanged"); assert.equal(unchanged.uploadedBytes, 0); assert.equal(unchanged.uploadedObjects, 0);
    assert.equal(requests.filter(request => request.method === "PUT").length, 0);
    const manifest = parseManifest(objects.get(keyFor(recovered.filename))!);
    const ref = getObjectRefs(manifest)[0]!;
    objects.delete(keyFor(recovered.filename)); objects.delete(keyFor(ref.filename)); requests.length = 0;
    const repaired = created(await service.run(alice));
    assert(objects.has(keyFor(ref.filename))); assert(objects.has(keyFor(repaired.filename)));
    assert(requests.some(request => request.method === "PUT" && request.status === 201 && request.key === keyFor(ref.filename)));
    await assertSnapshot(JSON.parse((await service.download(alice, repaired.id)).data.toString()) as Snapshot, before);
    assert.equal((await service.history(alice)).items.length, 4);
  });

  it("recovers a missing manifest on the scheduled incremental run", async () => {
    const service = manager(); await service.save(alice, config);
    const first = created(await service.run(alice));
    objects.delete(keyFor(first.filename));
    clock = new Date(clock.getTime() + 2 * 3_600_000); requests.length = 0;
    await service.tick();
    const items = (await service.history(alice)).items;
    assert.equal(items.length, 2); assert.notEqual(items[0]!.id, first.id);
    assert.equal((await service.config(alice)).lastStatus, "success");
    assert(requests.some(request => request.method === "PUT" && request.key.includes("ppm-") && request.status === 201));
    await assertSnapshot(JSON.parse((await service.download(alice, items[0]!.id)).data.toString()) as Snapshot, await snapshot());
  });

  it("keeps non-404 manifest read failures from uploading or rewriting history", async () => {
    const service = manager(); await service.save(alice, config); created(await service.run(alice));
    for (const status of [401, 403, 429, 503]) {
      failGet = (method, key) => method === "GET" && key.includes("ppm-") ? status : undefined;
      requests.length = 0;
      await assert.rejects(service.run(alice), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "webdav_failed");
        assert.equal((error.details as { status?: number }).status, status);
        return true;
      });
      assert.equal(requests.filter(request => request.method === "PUT").length, 0);
      assert.equal((await service.history(alice)).items.length, 1);
      assert.match((await service.config(alice)).lastError ?? "", /^webdav_failed:/);
    }
  });

  it("rejects corrupted previous manifests and detects wrong-size or same-size object corruption", async () => {
    const service = manager(); await service.save(alice, config); const first = created(await service.run(alice));
    const mainKey = keyFor(first.filename), main = objects.get(mainKey)!;
    objects.set(mainKey, Buffer.from("bad")); await assert.rejects(service.run(alice), /manifest has changed/);
    objects.set(mainKey, main);
    const ref = getObjectRefs(parseManifest(main))[0]!, objectKey = keyFor(ref.filename), object = objects.get(objectKey)!;
    objects.set(objectKey, Buffer.concat([object, Buffer.from("extra")])); await assert.rejects(service.run(alice), /incorrect size/);
    const sameSize = Buffer.from(object); sameSize[0] = sameSize[0]! ^ 1; objects.set(objectKey, sameSize);
    assert.equal((await service.run(alice)).status, "unchanged", "HEAD only verifies existence and length");
    await assert.rejects(service.download(alice, first.id), /hash|checksum|digest|content/i);
    assert.equal((await service.history(alice)).items.length, 1);
  });

  it("does not publish incomplete objects or manifests and safely reuses conditional-PUT conflicts on retry", async () => {
    const service = manager(); await service.save(alice, config);
    let seen = 0; failPut = key => key.includes("ppc-") && ++seen === 2;
    await assert.rejects(service.run(alice), /503/); assert.equal((await service.history(alice)).items.length, 0);
    assert([...objects.keys()].some(key => key.includes("ppc-"))); assert(![...objects.keys()].some(key => key.includes("ppm-")));
    const orphanKey = [...objects.keys()][0]!, orphan = objects.get(orphanKey)!;
    const damaged = Buffer.from(orphan); damaged[0] = damaged[0]! ^ 1;
    objects.set(orphanKey, damaged); failPut = undefined;
    await assert.rejects(service.run(alice), /immutable backup object differs/);
    assert.equal((await service.history(alice)).items.length, 0);
    assert.deepEqual(objects.get(orphanKey), damaged, "412 validation never overwrites remote content");
    objects.set(orphanKey, orphan);
    failPut = key => key.includes("ppm-");
    await assert.rejects(service.run(alice), /503/); assert.equal((await service.history(alice)).items.length, 0);
    assert(requests.some(request => request.status === 412 && request.method === "PUT"));
    assert(requests.some(request => request.method === "GET" && request.key.includes("ppc-")));
    failPut = undefined; const first = created(await service.run(alice));
    await assertSnapshot(JSON.parse((await service.download(alice, first.id)).data.toString()) as Snapshot, await snapshot());
  });

  it("preserves successful history on database-publication failure, then retries without overwriting remote files", async () => {
    const service = manager(); await service.save(alice, config); const first = created(await service.run(alice));
    await db.query("UPDATE tasks.tasks SET title='pending revision' WHERE id=$1", [taskId]);
    const original = db.withTransaction.bind(db);
    db.withTransaction = async callback => original(async tx => {
      const query = tx.query.bind(tx);
      tx.query = async (sql, values) => {
        if (sql.includes("INSERT INTO core.backup_history")) throw new Error("injected publication failure");
        return query(sql, values);
      };
      return callback(tx);
    });
    try { await assert.rejects(service.run(alice), /Backup failed/); } finally { db.withTransaction = original; }
    assert.equal((await service.history(alice)).items.length, 1);
    await service.download(alice, first.id);
    const second = created(await service.run(alice));
    assert.notEqual(second.id, first.id); assert(requests.some(request => request.status === 412));
    await assertSnapshot(JSON.parse((await service.download(alice, second.id)).data.toString()) as Snapshot, await snapshot());
  });

  it("keeps manual full files standalone, old full history readable, and latest incremental ordering independent of clock ties", async () => {
    const service = manager(); await service.save(alice, config);
    const first = created(await service.run(alice)); const fullResult = await service.run(alice, false, "full"), full = created(fullResult);
    assert.equal(full.kind, "full"); assert.equal(JSON.parse(objects.get(keyFor(full.filename))!.toString()).type, "personal-platform-data");
    assert.equal(fullResult.uploadedObjects, 1);
    await db.query("UPDATE core.backup_history SET destination_username=NULL,namespace=NULL WHERE id=$1", [full.id]);
    await assertSnapshot(JSON.parse((await service.download(alice, full.id)).data.toString()) as Snapshot, await snapshot());
    requests.length = 0; assert.equal((await service.run(alice)).status, "unchanged");
    assert.equal(requests.filter(request => request.method === "PUT").length, 0);
    await db.query("UPDATE tasks.tasks SET title='third point' WHERE id=$1", [taskId]);
    const third = created(await service.run(alice));
    assert.deepEqual((await service.history(alice)).items.map(item => item.id), [third.id, full.id, first.id]);
    assert.equal((await service.run(alice)).status, "unchanged");
    await assert.rejects(service.run(alice, true, "full"), /Automatic backups use incremental/);
  });

  it("does not publish or report unchanged after another worker has acquired its lease", async () => {
    const service = manager(); await service.save(alice, config);
    const stolen = randomUUID(); let switched = false;
    const steal = async () => {
      if (switched) return; switched = true;
      await db.query("UPDATE core.backup_targets SET lease_token=$2,lease_until=$3 WHERE user_id=$1", [alice.id, stolen, new Date(clock.getTime() + 3_600_000)]);
    };
    responseHook = async (method, key) => { if (method === "PUT" && key.includes("ppc-")) await steal(); };
    await assert.rejects(service.run(alice), /lease|another worker/i);
    assert.equal((await service.history(alice)).items.length, 0);
    assert(![...objects.keys()].some(key => key.includes("ppm-")));
    assert.equal((await db.query("SELECT lease_token FROM core.backup_targets WHERE user_id=$1", [alice.id])).rows[0]!.lease_token, stolen);
    responseHook = undefined;
    await db.query("UPDATE core.backup_targets SET lease_token=NULL,lease_until=NULL WHERE user_id=$1", [alice.id]);
    created(await service.run(alice)); requests.length = 0; switched = false;
    responseHook = async method => { if (method === "HEAD") await steal(); };
    await assert.rejects(service.run(alice), /lease|another worker/i);
    assert.equal((await service.history(alice)).items.length, 1);
    assert.equal(requests.filter(request => request.method === "PUT").length, 0);
    assert.equal((await db.query("SELECT lease_token FROM core.backup_targets WHERE user_id=$1", [alice.id])).rows[0]!.lease_token, stolen);
  });

  it("isolates user, scope, destination and remote username namespaces and hides prior credentials' history", async () => {
    const service = manager(); await service.save(alice, config); await service.save(bob, config);
    const aliceBackup = created(await service.run(alice)); const bobBackup = created(await service.run(bob));
    const aliceNamespace = parseManifest(objects.get(keyFor(aliceBackup.filename))!).namespace;
    const bobNamespace = parseManifest(objects.get(keyFor(bobBackup.filename))!).namespace;
    assert.notEqual(aliceNamespace, bobNamespace); await assert.rejects(service.download(bob, aliceBackup.id), /not available/);
    await service.save(admin, config); const own = created(await service.run(admin));
    await service.save(admin, {...config, scope: "all"}); const all = created(await service.run(admin));
    assert.notEqual(parseManifest(objects.get(keyFor(own.filename))!).namespace, parseManifest(objects.get(keyFor(all.filename))!).namespace);
    await service.save(alice, {...config, username: "new-dav"}); const switched = created(await service.run(alice));
    assert.notEqual(parseManifest(objects.get(keyFor(switched.filename, "new-dav"))!).namespace, aliceNamespace);
    assert.equal((await service.history(alice)).items.find(item => item.id === aliceBackup.id)!.available, false);
    await assert.rejects(service.download(alice, aliceBackup.id), /not available/);
    await service.save(alice, {...config, endpoint: config.endpoint + "other/"});
    const moved = created(await service.run(alice));
    const movedManifest = parseManifest(objects.get(`dav|/backups/other/${moved.filename}`)!);
    assert.notEqual(movedManifest.namespace, aliceNamespace);
    await assert.rejects(service.download(alice, switched.id), /not available/);
    await db.query("UPDATE core.users SET role='user' WHERE id=$1", [admin.id]);
    await assert.rejects(service.download({...admin, role: "user"}, all.id), /administrators/);
    await assert.rejects(service.run(admin), /administrators/);
  });
});
