import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { Database } from "../../src/core/database/index.js";
import { AppError } from "../../src/core/api/errors.js";
import { WebdavBackups, type BackupActor, type WebdavInput } from "../../src/core/data-management/webdav.js";
import type { DavRequest } from "../../src/core/data-management/webdav-http.js";
import { resetDatabase } from "../helpers/db.js";
import { createTestUser, ensureTestAdmin, loginCookie, withFixturePlatform } from "../helpers/platform.js";

let db: Database;
let admin: BackupActor, alice: BackupActor, bob: BackupActor;
let root: string;
let clock = new Date("2026-11-01T12:00:00Z");
const originalKey = process.env.DATA_BACKUP_ENCRYPTION_KEY;
const originalOrigins = process.env.DATA_BACKUP_ALLOWED_ORIGINS;
const services: WebdavBackups[] = [];
const objects = new Map<string, Buffer>();
let requests: DavRequest[] = [];
const config: WebdavInput = { endpoint: "https://cloud.example/backups/", username: "dav-user", password: "secret-for-dav", scope: "own", intervalHours: 1 };

before(async () => {
  delete process.env.DATA_BACKUP_ENCRYPTION_KEY;
  db = await resetDatabase();
  admin = { id: await ensureTestAdmin(db), role: "admin" };
  alice = { id: (await createTestUser(db, "dav-alice")).id, role: "user" };
  bob = { id: (await createTestUser(db, "dav-bob")).id, role: "user" };
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pp-dav-service-"));
  clock = new Date("2026-11-01T12:00:00Z"); objects.clear(); requests = [];
  await db.query("DELETE FROM core.backup_history");
  await db.query("DELETE FROM core.backup_targets");
  await db.query("UPDATE core.users SET status='active',role=CASE WHEN id=$1 THEN 'admin' ELSE 'user' END", [admin.id]);
});
afterEach(async () => {
  if (originalOrigins === undefined) delete process.env.DATA_BACKUP_ALLOWED_ORIGINS; else process.env.DATA_BACKUP_ALLOWED_ORIGINS = originalOrigins;
  await Promise.all(services.splice(0).map(service => service.stop()));
  await rm(root, { recursive: true, force: true });
});
after(async () => {
  if (originalKey === undefined) delete process.env.DATA_BACKUP_ENCRYPTION_KEY; else process.env.DATA_BACKUP_ENCRYPTION_KEY = originalKey;
  if (db) await db.close();
});

async function transport(input: DavRequest): Promise<Buffer> {
  requests.push(input);
  assert.equal(input.password, config.password);
  const key = input.endpoint + (input.filename ?? "");
  if (input.method === "PUT") { assert(!objects.has(key)); objects.set(key, Buffer.from(input.body!)); return Buffer.alloc(0); }
  if (input.method === "GET") { assert(objects.has(key)); return objects.get(key)!; }
  return Buffer.from('<d:multistatus xmlns:d="DAV:"/>');
}
function service(request = transport): WebdavBackups {
  const value = new WebdavBackups({ database: db, storageRoot: root, installedApps: () => [], now: () => clock, request });
  services.push(value); return value;
}
const advance = (hours: number) => { clock = new Date(clock.getTime() + hours * 3_600_000); };

describe("WebDAV persistence and private configuration", () => {
  it("upgrades previous core tables without changing accounts or settings", async () => {
    const beforeUsers = (await db.query("SELECT * FROM core.users ORDER BY id")).rows;
    await db.query("INSERT INTO core.settings(key,value) VALUES ('dav.migration-sentinel', '{\"preserve\":true}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
    const migration = await readFile(resolve(import.meta.dirname, "../../..", "migrations/core/20261101000001-data-backups.sql"), "utf8");
    await db.withTransaction(async tx => {
      await tx.query("DROP TABLE core.backup_history,core.backup_targets");
      await tx.query(migration);
      await tx.query("INSERT INTO core.backup_history(id,user_id,endpoint,filename,scope,size_bytes,sha256) VALUES(gen_random_uuid(),$1,'https://old.example/','legacy.json','own',123,'old-hash')", [alice.id]);
      await tx.query(await readFile(resolve(import.meta.dirname, "../../..", "migrations/core/20261101000002-incremental-backups.sql"), "utf8"));
      const legacy = (await tx.query("SELECT * FROM core.backup_history WHERE filename='legacy.json'")).rows[0]!;
      assert.equal(legacy.kind, "full"); assert.equal(legacy.logical_size_bytes, 123);
      assert.equal(Number(legacy.uploaded_bytes), 123); assert.equal(legacy.uploaded_objects, 1);
      assert.equal(legacy.namespace, null); assert.equal(legacy.destination_username, null);
      assert(legacy.sequence);

      assert.deepEqual((await tx.query("SELECT * FROM core.users ORDER BY id")).rows, beforeUsers);
      assert.deepEqual((await tx.query("SELECT value FROM core.settings WHERE key='dav.migration-sentinel'")).rows[0]!.value, { preserve: true });
    });
    assert.equal((await service().config(alice)).configured, false);
  });

  it("stores encrypted credentials per user, reloads them and never returns passwords", async () => {
    const first = service();
    const saved = await first.save(alice, config);
    assert.equal(saved.hasPassword, true);
    assert.equal(saved.nextRunAt, "2026-11-01T13:00:00.000Z");
    assert.equal((await first.config(bob)).configured, false);
    const row = (await db.query("SELECT password_ciphertext FROM core.backup_targets WHERE user_id=$1", [alice.id])).rows[0]!;
    assert(!JSON.stringify(row).includes(config.password!));
    assert(!JSON.stringify(saved).includes(config.password!));
    assert(!Object.hasOwn(saved, "password_ciphertext"));
    const restarted = service();
    assert.deepEqual(await restarted.config(alice), saved);
    await restarted.test(alice);
    assert.equal(requests.at(-1)!.password, config.password);
    const { password: _ignored, ...withoutPassword } = config;
    await restarted.save(alice, { ...withoutPassword, intervalHours: 6 });
    await restarted.test(alice);
    assert.equal((await restarted.config(alice)).intervalHours, 6);
    assert.equal((await db.query("SELECT * FROM core.settings WHERE key LIKE '%webdav%'")).rowCount, 0);
  });

  it("requires fresh credentials when changing destination or username and rejects non-admin all scope", async () => {
    const manager = service();
    const { password: _ignored, ...withoutPassword } = config;
    await assert.rejects(manager.save(alice, withoutPassword), /password/);
    await manager.save(alice, config);
    await assert.rejects(manager.save(alice, { ...withoutPassword, endpoint: "https://elsewhere.example/dav/" }), /password/);
    await assert.rejects(manager.save(alice, { ...withoutPassword, username: "another" }), /password/);
    await assert.rejects(manager.save(alice, { ...config, scope: "all" }), /administrators/);
    await assert.rejects(manager.save(alice, { ...config, password: "" }), /non-empty/);
    assert.equal((await manager.config(alice)).endpoint, config.endpoint);
    await manager.save(admin, { ...config, scope: "all" });
    assert.equal((await manager.config(admin)).scope, "all");
  });

  it("reports a changed key without exposing secrets and recovers when the password is saved again", async () => {
    const manager = service(); await manager.save(alice, config);
    process.env.DATA_BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    try {
      await assert.rejects(manager.test(alice), /decrypt/);
      assert.equal(requests.length, 0);
      await manager.save(alice, config);
      await manager.test(alice);
      assert.equal(requests.length, 1);
      assert(!JSON.stringify(await manager.config(alice)).includes(config.password!));
    } finally { delete process.env.DATA_BACKUP_ENCRYPTION_KEY; }
  });
});

describe("WebDAV draft connection tests", () => {
  it("tests an unsaved connection without creating targets, history or encryption keys", async () => {
    const manager = service();
    const draft = { endpoint: "https://cloud.example/backups", username: config.username, password: config.password };
    assert.deepEqual(await manager.test(alice, draft), { ok: true });
    assert.deepEqual(requests, [{ endpoint: config.endpoint, username: config.username, password: config.password, method: "PROPFIND" }]);
    assert.equal((await manager.config(alice)).configured, false);
    assert.equal((await db.query("SELECT * FROM core.backup_targets")).rowCount, 0);
    assert.equal((await db.query("SELECT * FROM core.backup_history")).rowCount, 0);
    await assert.rejects(stat(join(root, ".core")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });

  it("uses a draft password without changing saved configuration, schedule, status or key", async () => {
    const manager = service(); await manager.save(alice, config);
    const before = (await db.query("SELECT * FROM core.backup_targets WHERE user_id=$1", [alice.id])).rows;
    const key = await readFile(join(root, ".core", "backup.key"));
    const draft = { endpoint: "https://other.example/new/", username: "new-user", password: "new-secret" };
    const testing = service(async input => { requests.push(input); throw new AppError(502, "webdav_failed", "WebDAV returned HTTP 401."); });
    await assert.rejects(testing.test(alice, draft), /401/);
    assert.deepEqual(requests.at(-1), { ...draft, method: "PROPFIND" });
    assert.deepEqual((await db.query("SELECT * FROM core.backup_targets WHERE user_id=$1", [alice.id])).rows, before);
    assert.deepEqual(await readFile(join(root, ".core", "backup.key")), key);
    assert.equal((await db.query("SELECT * FROM core.backup_history")).rowCount, 0);
  });

  it("reuses only the same owner's password at the same normalized URL and username", async () => {
    const manager = service(); await manager.save(alice, config);
    await manager.test(alice, { endpoint: "https://CLOUD.example/backups", username: config.username });
    assert.equal(requests.at(-1)!.password, config.password);
    const count = requests.length;
    await assert.rejects(manager.test(bob, { endpoint: config.endpoint, username: config.username }), /password/);
    await assert.rejects(manager.test(alice, { endpoint: "https://other.example/backups/", username: config.username }), /password/);
    await assert.rejects(manager.test(alice, { endpoint: config.endpoint, username: "new-user" }), /password/);
    assert.equal(requests.length, count);
    await manager.test(alice, {});
    assert.equal(requests.length, count + 1);
  });

  it("rejects incomplete inputs and inactive accounts before sending credentials", async () => {
    const manager = service();
    for (const draft of [{ endpoint: config.endpoint }, { username: config.username }, { password: "secret" }]) {
      await assert.rejects(manager.test(alice, draft), /endpoint and username/);
    }
    await assert.rejects(manager.test(alice, { endpoint: config.endpoint, username: "bad:user", password: "secret" }), /username/);
    await assert.rejects(manager.test(alice, { endpoint: config.endpoint, username: config.username, password: "" }), /password/);
    await db.query("UPDATE core.users SET status='disabled' WHERE id=$1", [alice.id]);
    await assert.rejects(manager.test(alice, { endpoint: config.endpoint, username: config.username, password: config.password }), /not active/);
    assert.equal(requests.length, 0);
    assert.equal((await db.query("SELECT * FROM core.backup_targets")).rowCount, 0);
  });
});

describe("WebDAV backups and durable schedule", () => {
  it("uploads unique snapshots, downloads exact bytes and isolates history by owner and destination", async () => {
    const manager = service();
    await manager.save(alice, config); await manager.save(bob, config);
    const first = (await manager.run(alice, false, "full")).backup!, second = (await manager.run(alice, false, "full")).backup!;
    assert.notEqual(first.filename, second.filename);
    const result = await manager.download(alice, first.id);
    const snapshot = JSON.parse(result.data.toString()) as { scope: string; source: { id: string } };
    assert.equal(snapshot.scope, "own"); assert.equal(snapshot.source.id, alice.id);
    assert(!result.data.includes(Buffer.from(config.password!)));
    assert.equal((await manager.history(alice)).items.length, 2);
    assert.deepEqual((await manager.history(bob)).items, []);
    await assert.rejects(manager.download(bob, first.id), /not available/);
    await manager.save(alice, { ...config, endpoint: "https://cloud.example/new/" });
    assert((await manager.history(alice)).items.every(item => !item.available));
    await assert.rejects(manager.download(alice, first.id), /not available/);
  });

  it("detects a changed remote backup before returning it to the browser", async () => {
    const manager = service(); await manager.save(alice, config);
    const uploaded = (await manager.run(alice, false, "full")).backup!;
    objects.set(config.endpoint + uploaded.filename, Buffer.from("tampered"));
    await assert.rejects(manager.download(alice, uploaded.id), /differs/);
  });

  it("runs one missed interval after restart, advances the persistent deadline and stops when disabled", async () => {
    const first = service(); await first.save(alice, config); await first.stop();
    const restarted = service();
    await restarted.tick(); assert.equal(objects.size, 0);
    advance(72); await restarted.tick();
    assert.equal(objects.size, 1);
    assert.equal((await restarted.config(alice)).nextRunAt, new Date(clock.getTime() + 3_600_000).toISOString());
    await restarted.tick(); assert.equal(objects.size, 1);
    await restarted.save(alice, { ...config, intervalHours: 0 });
    advance(72); await restarted.tick(); assert.equal(objects.size, 1);
    assert.equal((await restarted.config(alice)).nextRunAt, null);
  });

  it("records a safe failure, schedules the next attempt and does not repeatedly retry an overdue slot", async () => {
    const manager = service(async () => { throw new Error("remote-secret-body secret-for-dav"); });
    await manager.save(alice, config); advance(2);
    await manager.tick();
    const state = await manager.config(alice);
    assert.equal(state.lastStatus, "failed");
    assert(!state.lastError!.includes("secret-for-dav"));
    assert.equal(state.nextRunAt, new Date(clock.getTime() + 3_600_000).toISOString());
    assert.deepEqual((await manager.history(alice)).items, []);
    const lastRun = state.lastRunAt;
    await manager.tick(); assert.equal((await manager.config(alice)).lastRunAt, lastRun);
  });

  it("rechecks disabled users and revoked administrator privileges before scheduled upload", async () => {
    const manager = service();
    await manager.save(alice, config); await manager.save(admin, { ...config, scope: "all" });
    await db.query("UPDATE core.users SET status='disabled' WHERE id=$1", [alice.id]);
    await db.query("UPDATE core.users SET role='user' WHERE id=$1", [admin.id]);
    advance(2); await manager.tick();
    assert.equal(objects.size, 0); assert.equal(requests.length, 0);
    assert.equal((await manager.config(alice)).lastStatus, "failed");
    assert.equal((await manager.config(admin)).lastStatus, "failed");
    await assert.rejects(manager.run(admin), /administrators/);
  });

  it("serializes manual and scheduled runs across service instances and waits for shutdown", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = service(async input => { if (input.method === "PUT") { enter(); await gate; } return transport(input); });
    const second = service();
    await first.save(alice, config); advance(2);
    const active = first.run(alice); await entered;
    try {
      await assert.rejects(second.run(alice), (error: AppError) => error.code === "backup_busy");
      await second.tick(); assert.equal(objects.size, 0);
      await assert.rejects(second.save(alice, config), /running/);
      await assert.rejects(second.remove(alice), /running/);
      let stopped = false;
      const stopping = first.stop().then(() => { stopped = true; });
      await Promise.resolve(); assert.equal(stopped, false);
      release(); await active; await stopping;
      assert.equal(stopped, true); assert.equal(objects.size, 1);
      await assert.rejects(first.run(alice), /stopping/);
    } finally { release(); await active.catch(() => undefined); }
  });

  it("marks all-scope history unavailable and refuses download after its owner's demotion", async () => {
    const manager = service(); await manager.save(admin, { ...config, scope: "all" });
    const uploaded = (await manager.run(admin, false, "full")).backup!;
    await db.query("UPDATE core.users SET role='user' WHERE id=$1", [admin.id]);
    const current = { ...admin, role: "user" as const };
    assert.equal((await manager.history(current)).items[0]!.available, false);
    await assert.rejects(manager.download(current, uploaded.id), /administrators/);
  });
});

describe("Settings data API authorization", () => {
  it("accepts draft and legacy tests while rejecting partial or extra fields without persisting drafts", async () => {
    const authHeaders: string[] = [];
    const server = http.createServer((req, res) => {
      assert.equal(req.method, "PROPFIND");
      authHeaders.push(req.headers.authorization ?? "");
      res.writeHead(207).end('<d:multistatus xmlns:d="DAV:"/>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.DATA_BACKUP_ALLOWED_ORIGINS = origin;
    try {
      await withFixturePlatform({ database: db, manifests: [] }, async platform => {
        const draft = { endpoint: `${origin}/dav/`, username: "draft-user", password: "draft-secret" };
        const url = "/api/core/data/webdav/test";
        assert.equal((await platform.app.inject({ method: "POST", url, payload: draft })).statusCode, 401);
        const cookie = await loginCookie(platform, "dav-alice", "test-password-dav-alice");
        const test = (payload: Record<string, unknown>) => platform.app.inject({ method: "POST", url, headers: { cookie }, payload });
        const result = await test(draft);
        assert.equal(result.statusCode, 200, result.body);
        assert.deepEqual(result.json(), { ok: true });
        assert.equal(authHeaders[0], `Basic ${Buffer.from("draft-user:draft-secret").toString("base64")}`);
        assert.equal((await db.query("SELECT * FROM core.backup_targets")).rowCount, 0);
        assert.equal((await db.query("SELECT * FROM core.backup_history")).rowCount, 0);
        for (const payload of [{ endpoint: draft.endpoint }, { username: draft.username }, { password: draft.password }, { ...draft, scope: "all" }, { ...draft, extra: true }, { ...draft, intervalHours: 1 }, { ...draft, password: "" }]) {
          const invalid = await test(payload);
          assert.equal(invalid.statusCode, 400, invalid.body);
        }
        assert.equal(authHeaders.length, 1);
        assert.equal((await test({})).statusCode, 422);
        const saved = await platform.app.inject({ method: "PUT", url: "/api/core/data/webdav", headers: { cookie }, payload: { ...draft, scope: "own", intervalHours: 24 } });
        assert.equal(saved.statusCode, 200, saved.body);
        const before = (await db.query("SELECT * FROM core.backup_targets")).rows;
        assert.equal((await test({})).statusCode, 200);
        assert.equal((await test({ endpoint: `${origin}/dav`, username: draft.username })).statusCode, 200);
        assert.equal(authHeaders.length, 3);
        assert.deepEqual((await db.query("SELECT * FROM core.backup_targets")).rows, before);
      });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("guards every data endpoint and scopes configuration and history to the signed-in user", async () => {
    await withFixturePlatform({ database: db, manifests: [] }, async platform => {
      for (const url of ["/api/core/data/webdav", "/api/core/data/webdav/history", "/api/core/data/export?scope=own"]) {
        assert.equal((await platform.app.inject({ url })).statusCode, 401);
      }
      const aliceCookie = await loginCookie(platform, "dav-alice", "test-password-dav-alice");
      const bobCookie = await loginCookie(platform, "dav-bob", "test-password-dav-bob");
      assert.equal((await platform.app.inject({ url: "/api/core/data/export?scope=all", headers: { cookie: aliceCookie } })).statusCode, 403);
      const forbidden = await platform.app.inject({ method: "PUT", url: "/api/core/data/webdav", headers: { cookie: aliceCookie }, payload: { ...config, scope: "all" } });
      assert.equal(forbidden.statusCode, 403);
      const put = await platform.app.inject({ method: "PUT", url: "/api/core/data/webdav", headers: { cookie: aliceCookie }, payload: config });
      assert.equal(put.statusCode, 200, put.body);
      assert.equal(put.json().hasPassword, true); assert(!put.body.includes(config.password!));
      const other = await platform.app.inject({ url: "/api/core/data/webdav", headers: { cookie: bobCookie } });
      assert.equal(other.json().configured, false);
      const history = await platform.app.inject({ url: "/api/core/data/webdav/history", headers: { cookie: bobCookie } });
      assert.deepEqual(history.json().items, []);
      const badId = await platform.app.inject({ url: "/api/core/data/webdav/files/not-a-uuid", headers: { cookie: bobCookie } });
      assert.equal(badId.statusCode, 400);
    });
  });
});
