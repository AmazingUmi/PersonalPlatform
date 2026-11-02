import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { logout } from "../../src/core/auth/service.js";
import { canonicalJson } from "../../src/core/data-management/incremental.js";
import { digest } from "../../src/core/data-management/snapshot-schema.js";
import { syncObjectName } from "../../src/core/data-management/sync-document.js";
import { syncKeyOf } from "../../src/core/data-management/sync-protocol.js";
import { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { runAppMigrations } from "../../src/core/database/startup-migrations.js";
import type { InjectOptions } from "fastify";
import type { Response } from "light-my-request";
import type { Platform } from "../../src/core/platform.js";
import { createAppStorage } from "../../src/core/storage/local.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { buildFixturePlatform, createTestUser, loginCookie } from "../helpers/platform.js";

const repo = resolve(import.meta.dirname, "../../..");
const key = randomBytes(32).toString("base64");
const board = JSON.stringify([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
let db: Database;
let platform: Platform;
let root: string;
let alice: { id: string; username: string };
let bob: { id: string; username: string };
let aliceCookie: string;
let bobCookie: string;
const originalKey = process.env.DATA_BACKUP_ENCRYPTION_KEY;
const originalOrigins = process.env.DATA_BACKUP_ALLOWED_ORIGINS;

interface DavObject { body: Buffer; etag: string }
interface DavBox {
  endpoint: string;
  objects: Map<string, DavObject>;
  requests: { method: string; url: string }[];
  puts: string[];
  lastAuthorization: string;
  failStatus: number;
  dropHeadPut: boolean;
  poisonBin: boolean;
  raceCreate412: boolean;
  holdHead: Promise<void> | null;
  holdHeadGet: Promise<void> | null;
  holdContent: Promise<void> | null;
  contentStarted: (() => void) | null;
  onObjectGet: ((url: string) => Promise<void>) | null;
  close: () => Promise<void>;
}

before(async () => {
  process.env.DATA_BACKUP_ENCRYPTION_KEY = key;
  const setup = await resetDatabase();
  await runAppMigrations({ databaseUrl: TEST_DATABASE_URL, manifestsDir: join(repo, "apps") });
  alice = await createTestUser(setup, "sync-alice");
  bob = await createTestUser(setup, "sync-bob");
  await setup.close();
  db = new Database(TEST_DATABASE_URL, undefined, { max: 1 });
  const built = await buildFixturePlatform({ manifests: [], database: db, backendModules: {} });
  platform = built.platform;
  root = built.root;
  aliceCookie = await loginCookie(platform, alice.username, "test-password-sync-alice");
  bobCookie = await loginCookie(platform, bob.username, "test-password-sync-bob");
});

beforeEach(async () => {
  await db.query("TRUNCATE tasks.tasks, notes.notes, notes.tags, notes.note_tags, assets.categories, assets.items, assets.item_categories, assets.attachments, clock.settings, clock.alarms, clock.world_clocks, focus.settings, focus.sessions, mini_game.saves CASCADE");
  await db.query("DELETE FROM core.sync_remote_objects");
  await db.query("DELETE FROM core.sync_guards");
  await db.query("DELETE FROM core.sync_conflicts");
  await db.query("DELETE FROM core.sync_row_state");
  await db.query("DELETE FROM core.sync_bindings");
  await db.query("DELETE FROM core.backup_targets");
  await db.query("DELETE FROM core.backup_history");
  await db.query("DELETE FROM core.settings");
  await db.query("ALTER TABLE assets.attachments DROP CONSTRAINT IF EXISTS sync_test_reject");
  await rm(join(root, "storage", "users"), { recursive: true, force: true });
});

after(async () => {
  if (platform) await platform.stop().catch(() => undefined);
  if (db) await db.close().catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.DATA_BACKUP_ENCRYPTION_KEY;
  else process.env.DATA_BACKUP_ENCRYPTION_KEY = originalKey;
  if (originalOrigins === undefined) delete process.env.DATA_BACKUP_ALLOWED_ORIGINS;
  else process.env.DATA_BACKUP_ALLOWED_ORIGINS = originalOrigins;
});

function databaseNamed(name: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/" + name;
  return url.toString();
}

async function openDav(): Promise<DavBox> {
  const objects = new Map<string, DavObject>();
  const requests: { method: string; url: string }[] = [];
  const puts: string[] = [];
  let serial = 0;
  const box = {
    objects, requests, puts, lastAuthorization: "", failStatus: 0, dropHeadPut: false, poisonBin: false,
    raceCreate412: false, holdHead: null as Promise<void> | null, holdHeadGet: null as Promise<void> | null, holdContent: null as Promise<void> | null,
    contentStarted: null as (() => void) | null,
    onObjectGet: null as ((url: string) => Promise<void>) | null,
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = req.url ?? "/";
    requests.push({ method: req.method ?? "", url });
    box.lastAuthorization = String(req.headers.authorization ?? "");
    if (box.failStatus) {
      const status = box.failStatus;
      box.failStatus = 0;
      res.writeHead(status).end();
      return;
    }
    if (req.method === "PUT") {
      if (url.includes("-head.json") && box.holdHead) {
        const wait = box.holdHead;
        box.holdHead = null;
        await wait;
      }
      if (!url.includes("-head.json") && !url.includes("pps-probe-") && box.holdContent) {
        const wait = box.holdContent;
        box.holdContent = null;
        const started = box.contentStarted;
        box.contentStarted = null;
        started?.();
        await wait;
      }
      // Compare-and-swap uses the object present after the wait, not at request arrival.
      const current = objects.get(url);
      const match = req.headers["if-match"];
      const create = req.headers["if-none-match"] === "*";
      if (box.poisonBin && create && url.endsWith(".bin")) {
        box.poisonBin = false;
        objects.set(url, { body: Buffer.from("poison"), etag: `"poison${serial}"` });
        res.writeHead(412).end();
        return;
      }
      if (create && current) { res.writeHead(412).end(); return; }
      if (typeof match === "string" && (!current || match !== current.etag)) { res.writeHead(412).end(); return; }
      serial += 1;
      const stored = { body, etag: `"v${serial}"` };
      objects.set(url, stored);
      puts.push(url);
      if (box.raceCreate412 && create) {
        box.raceCreate412 = false;
        res.writeHead(412).end();
        return;
      }
      if (box.dropHeadPut && url.includes("-head.json")) {
        box.dropHeadPut = false;
        req.socket.destroy();
        return;
      }
      res.writeHead(current ? 204 : 201).end();
      return;
    }
    if (req.method === "GET" && url.includes("-head.json") && box.holdHeadGet) {
      const wait = box.holdHeadGet;
      box.holdHeadGet = null;
      await wait;
    }
    const current = objects.get(url);
    if (!current) { res.writeHead(404).end(); return; }
    if (req.method === "GET" && !url.includes("-head.json") && !url.includes("pps-probe-") && box.onObjectGet) await box.onObjectGet(url);
    const inm = req.headers["if-none-match"];
    if (req.method === "GET" && typeof inm === "string" && inm === current.etag) {
      res.writeHead(304).end();
      return;
    }
    res.setHeader("etag", current.etag);
    res.writeHead(200).end(current.body);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock dav did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.DATA_BACKUP_ALLOWED_ORIGINS = origin;
  const endpoint = `${origin}/dav/`;
  return Object.assign(box, { endpoint, close: () => new Promise<void>(resolveClose => { server.closeAllConnections(); server.close(() => resolveClose()); }) });
}

async function saveDestination(cookie: string, endpoint: string, password = "secret"): Promise<void> {
  const response = await platform.app.inject({
    method: "PUT", url: "/api/core/data/webdav", headers: { cookie },
    payload: { endpoint, username: "dav-user", password, scope: "own", intervalHours: 0 },
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: InjectOptions["payload"]): Promise<Response> {
  const options: InjectOptions = { method, url, headers: { cookie } };
  if (payload !== undefined) options.payload = payload;
  return platform.app.inject(options);
}

async function enable(cookie: string): Promise<void> {
  const response = await call("PUT", "/api/core/data/sync", cookie, { enabled: true, intervalSeconds: 0 });
  assert.equal(response.statusCode, 200, response.body);
}

async function linkNew(cookie: string, dav: DavBox): Promise<string> {
  await saveDestination(cookie, dav.endpoint);
  const created = await call("POST", "/api/core/data/sync", cookie, { action: "create" });
  assert.equal(created.statusCode, 200, created.body);
  const body = created.json();
  assert.equal(body.enabled, false);
  assert.equal(body.phase, "bootstrap");
  assert.equal("editorGuard" in body, false);
  assert.match(body.pairingCode, /^ppss1\./);
  await enable(cookie);
  return body.pairingCode as string;
}

async function joinSync(cookie: string, dav: DavBox, pairingCode: string): Promise<void> {
  await saveDestination(cookie, dav.endpoint);
  const response = await call("POST", "/api/core/data/sync", cookie, { action: "join", pairingCode });
  assert.equal(response.statusCode, 200, response.body);
  await enable(cookie);
}

async function cycle(cookie: string) {
  const response = await call("POST", "/api/core/data/sync/cycle", cookie);
  return { status: response.statusCode, body: response.json() as Record<string, unknown>, raw: response.body };
}

async function taskTitle(userId: string, id: string): Promise<string | undefined> {
  const row = (await db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE user_id=$1 AND id=$2", [userId, id])).rows[0];
  return row?.title;
}

async function syncFileNames(userId: string): Promise<string[]> {
  try { return (await readdir(join(root, "storage", "users", userId, "apps", "assets", "sync"))).sort(); }
  catch { return []; }
}

function assets(userId: string) {
  return createAppStorage(join(root, "storage"), "assets").forUser(userId);
}

async function attachmentKey(userId: string, id: string): Promise<string> {
  return String((await db.query<{ storage_key: string }>("SELECT storage_key FROM assets.attachments WHERE user_id=$1 AND id=$2", [userId, id])).rows[0]!.storage_key);
}

async function settle(cookie: string): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await cycle(cookie);
    assert.equal(result.status, 200, result.raw);
    last = result.body;
    if (result.body.result !== "partial") return result.body;
  }
  assert.fail("cycle remained partial: " + JSON.stringify(last));
}

async function currentPairing(cookie: string): Promise<string> {
  const revealed = await call("POST", "/api/core/data/sync/reveal", cookie);
  assert.equal(revealed.statusCode, 200, revealed.body);
  return revealed.json().pairingCode as string;
}

async function publishAttachment(dav: DavBox, attachment: string, filename: string, key: string, bytes: Buffer): Promise<void> {
  const item = randomUUID();
  await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'lens')", [item, alice.id]);
  await db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,$4,$5,$6)", [attachment, alice.id, item, filename, bytes.length, key]);
  await assets(alice.id).save(key, bytes);
  await linkNew(aliceCookie, dav);
  assert.equal((await settle(aliceCookie)).result, "published");
}

interface Replica {
  name: string;
  db: Database;
  platform: Platform;
  root: string;
  user: { id: string };
  cookie: string;
  close: () => Promise<void>;
}

async function openReplica(label: string): Promise<Replica> {
  const name = `pp_sync_${label}_${randomBytes(3).toString("hex")}`;
  await db.query(`CREATE DATABASE ${name}`);
  const url = databaseNamed(name);
  await runMigrations({ databaseUrl: url, targets: [{ scope: "core", schema: "core", dir: join(repo, "migrations", "core") }] });
  await runAppMigrations({ databaseUrl: url, manifestsDir: join(repo, "apps") });
  const peerDb = new Database(url, undefined, { max: 1 });
  const username = `sync-${label}`;
  const user = await createTestUser(peerDb, username);
  const built = await buildFixturePlatform({ manifests: [], database: peerDb, backendModules: {} });
  const cookie = await loginCookie(built.platform, user.username, `test-password-${username}`);
  return {
    name, db: peerDb, platform: built.platform, root: built.root, user, cookie,
    close: async () => {
      await built.platform.stop().catch(() => undefined);
      await peerDb.close().catch(() => undefined);
      await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()`, [name]).catch(() => undefined);
      await db.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    },
  };
}

function peerAssets(peer: Replica) {
  return createAppStorage(join(peer.root, "storage"), "assets").forUser(peer.user.id);
}

async function peerSyncNames(peer: Replica): Promise<string[]> {
  try { return (await readdir(join(peer.root, "storage", "users", peer.user.id, "apps", "assets", "sync"))).sort(); }
  catch { return []; }
}

async function peerKey(peer: Replica, id: string): Promise<string> {
  return String((await peer.db.query<{ storage_key: string }>("SELECT storage_key FROM assets.attachments WHERE user_id=$1 AND id=$2", [peer.user.id, id])).rows[0]!.storage_key);
}

async function peerCycle(peer: Replica) {
  const response = await peer.platform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: peer.cookie } });
  return { status: response.statusCode, body: response.json() as Record<string, unknown>, raw: response.body };
}

async function settlePeer(peer: Replica): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await peerCycle(peer);
    assert.equal(result.status, 200, result.raw);
    last = result.body;
    if (result.body.result !== "partial") return result.body;
  }
  assert.fail("cycle remained partial: " + JSON.stringify(last));
}

async function peerJoin(peer: Replica, endpoint: string, pairingCode: string): Promise<void> {
  await saveDestinationOn(peer.platform, peer.cookie, endpoint);
  const joined = await peer.platform.app.inject({ method: "POST", url: "/api/core/data/sync", headers: { cookie: peer.cookie }, payload: { action: "join", pairingCode } });
  assert.equal(joined.statusCode, 200, joined.body);
  const enabled = await peer.platform.app.inject({ method: "PUT", url: "/api/core/data/sync", headers: { cookie: peer.cookie }, payload: { enabled: true, intervalSeconds: 0 } });
  assert.equal(enabled.statusCode, 200, enabled.body);
}

async function peerItems(peer: Replica): Promise<{ id: string; syncKey: string }[]> {
  const response = await peer.platform.app.inject({ method: "GET", url: "/api/core/data/sync/conflicts", headers: { cookie: peer.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().items as { id: string; syncKey: string }[];
}

describe("continuous sync routes and cycles", () => {
  it("guards the own-session API and keeps the pairing secret out of status and the database", async () => {
    const dav = await openDav();
    try {
      assert.equal((await platform.app.inject({ method: "POST", url: "/api/core/data/sync", payload: { action: "create" } })).statusCode, 401);
      const extra = await call("POST", "/api/core/data/sync", aliceCookie, { action: "create", userId: alice.id });
      assert.equal(extra.statusCode, 400);
      assert.equal(extra.json().error.code, "validation_error");
      process.env.DATA_BACKUP_ALLOWED_ORIGINS = `${new URL(dav.endpoint).origin},http://127.0.0.1:1`;
      await saveDestination(aliceCookie, "http://127.0.0.1:1/dav/");
      const failed = await call("POST", "/api/core/data/sync", aliceCookie, { action: "create" });
      assert.notEqual(failed.statusCode, 200);
      assert.equal((await db.query("SELECT * FROM core.sync_bindings")).rowCount, 0);
      const code = await linkNew(aliceCookie, dav);
      const status = await call("GET", "/api/core/data/sync", aliceCookie);
      assert.equal(status.json().pairingCode, undefined);
      assert.equal(JSON.stringify(status.json()).includes("ppss1."), false);
      const stored = (await db.query<{ pairing_secret_ciphertext: string }>("SELECT pairing_secret_ciphertext FROM core.sync_bindings WHERE user_id=$1", [alice.id])).rows[0]!;
      assert.equal(stored.pairing_secret_ciphertext.includes(code), false);
      assert.equal(stored.pairing_secret_ciphertext.includes("ppss1."), false);
      const revealed = await call("POST", "/api/core/data/sync/reveal", aliceCookie);
      assert.equal(revealed.json().pairingCode, code);
      await saveDestination(bobCookie, dav.endpoint);
      const taken = await call("POST", "/api/core/data/sync", bobCookie, { action: "join", pairingCode: code });
      assert.equal(taken.statusCode, 409);
      assert.equal(taken.json().error.code, "sync_identity_taken");
      const moved = await call("PUT", "/api/core/data/webdav", aliceCookie, { endpoint: dav.endpoint + "other/", username: "dav-user", scope: "own", intervalHours: 0 });
      assert.equal(moved.statusCode, 409, moved.body);
      assert.equal(moved.json().error.code, "sync_destination_locked");
      const removed = await call("DELETE", "/api/core/data/webdav", aliceCookie);
      assert.equal(removed.statusCode, 409);
      const rotated = await call("PUT", "/api/core/data/webdav", aliceCookie, { endpoint: dav.endpoint, username: "dav-user", password: "rotated-secret", scope: "own", intervalHours: 0 });
      assert.equal(rotated.statusCode, 200, rotated.body);
      const task = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'kept')", [task, alice.id]);
      const published = await cycle(aliceCookie);
      assert.equal(published.status, 200, published.raw);
      assert.equal(published.body.result, "published");
      assert.equal(dav.lastAuthorization, `Basic ${Buffer.from("dav-user:rotated-secret").toString("base64")}`);
      const head = [...dav.objects.keys()].find(name => name.endsWith("-head.json"));
      assert.ok(head);
      const unlinked = await call("DELETE", "/api/core/data/sync", aliceCookie);
      assert.equal(unlinked.statusCode, 204);
      assert.equal(await taskTitle(alice.id, task), "kept");
      assert.ok(dav.objects.has(head!));
      assert.equal((await db.query("SELECT * FROM core.sync_bindings")).rowCount, 0);
    } finally { await dav.close(); }
  });

  it("publishes a local edit when the head is unchanged, retries a dropped head, and preserves data across a mid-upload edit", async () => {
    const dav = await openDav();
    try {
      const code = await linkNew(aliceCookie, dav);
      const task = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'one')", [task, alice.id]);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      const puts = dav.puts.length;
      const idle = await cycle(aliceCookie);
      assert.equal(idle.body.result, "idle");
      assert.equal(dav.puts.length, puts);
      const beforeObjects = dav.requests.length;
      const again = await cycle(aliceCookie);
      assert.equal(again.body.result, "idle");
      assert.ok(dav.requests.slice(beforeObjects).every(item => item.method === "GET" && item.url.includes("-head.json")));
      await db.query("UPDATE tasks.tasks SET title='two' WHERE id=$1", [task]);
      const edited = await cycle(aliceCookie);
      assert.equal(edited.body.result, "published");
      let releaseEdit = (): void => {};
      let contentEntered!: () => void;
      const contentEnteredPromise = new Promise<void>(resolveEntered => { contentEntered = resolveEntered; });
      dav.holdContent = new Promise<void>(resolveHold => { releaseEdit = resolveHold; });
      dav.contentStarted = contentEntered;
      await db.query("UPDATE tasks.tasks SET title='mid-before' WHERE id=$1", [task]);
      const headsBefore = dav.puts.filter(name => name.includes("-head.json")).length;
      const racing = cycle(aliceCookie);
      await contentEnteredPromise;
      await db.query("UPDATE tasks.tasks SET title='mid-after' WHERE id=$1", [task]);
      releaseEdit();
      const raced = await racing;
      assert.equal(raced.status, 200, raced.raw);
      assert.equal(raced.body.result, "retained");
      assert.equal(await taskTitle(alice.id, task), "mid-after");
      assert.equal(dav.puts.filter(name => name.includes("-head.json")).length, headsBefore);
      const drifted = (await db.query<{ baseline_hash: string | null; remote_content_hash: string | null }>(
        "SELECT baseline_hash, remote_content_hash FROM core.sync_bindings WHERE user_id=$1", [alice.id])).rows[0]!;
      assert.equal(drifted.baseline_hash, drifted.remote_content_hash);
      const continued = await cycle(aliceCookie);
      assert.equal(continued.status, 200, continued.raw);
      assert.equal(continued.body.result, "published");
      assert.equal(await taskTitle(alice.id, task), "mid-after");
      const peerName = `pp_sync_mid_${randomBytes(3).toString("hex")}`;
      await db.query(`CREATE DATABASE ${peerName}`);
      const peerDb = new Database(databaseNamed(peerName), undefined, { max: 1 });
      let peerPlatform: Platform | undefined;
      try {
        await runMigrations({ databaseUrl: databaseNamed(peerName), targets: [{ scope: "core", schema: "core", dir: join(repo, "migrations", "core") }] });
        await runAppMigrations({ databaseUrl: databaseNamed(peerName), manifestsDir: join(repo, "apps") });
        const peerUser = await createTestUser(peerDb, "sync-peer-mid");
        const built = await buildFixturePlatform({ manifests: [], database: peerDb, backendModules: {} });
        peerPlatform = built.platform;
        const peerCookie = await loginCookie(peerPlatform, peerUser.username, "test-password-sync-peer-mid");
        await saveDestinationOn(peerPlatform, peerCookie, dav.endpoint);
        const joined = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync", headers: { cookie: peerCookie }, payload: { action: "join", pairingCode: code } });
        assert.equal(joined.statusCode, 200, joined.body);
        await peerPlatform.app.inject({ method: "PUT", url: "/api/core/data/sync", headers: { cookie: peerCookie }, payload: { enabled: true, intervalSeconds: 0 } });
        const boot = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: peerCookie } });
        assert.equal(boot.statusCode, 200, boot.body);
        assert.equal(boot.json().result, "bootstrap");
        assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "mid-after");
        await peerDb.query("UPDATE tasks.tasks SET title='bob-edit' WHERE id=$1", [task]);
        dav.dropHeadPut = true;
        const dropped = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: peerCookie } });
        assert.equal(dropped.statusCode, 502, dropped.body);
        const binding = (await peerDb.query<{ phase: string; baseline_hash: string | null; pending_op_token: string | null; backoff_until: Date | null }>(
          "SELECT phase, baseline_hash, pending_op_token, backoff_until FROM core.sync_bindings WHERE user_id=$1", [peerUser.id])).rows[0]!;
        assert.equal(binding.phase, "publication_unknown");
        assert.ok(binding.baseline_hash);
        assert.ok(binding.pending_op_token);
        assert.equal(binding.backoff_until, null);
        assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "bob-edit");
        const recovered = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: peerCookie } });
        assert.equal(recovered.statusCode, 200, recovered.body);
        assert.equal(recovered.json().result, "committed");
        assert.equal(recovered.json().baseline, true);
      } finally {
        if (peerPlatform) await peerPlatform.stop().catch(() => undefined);
        await peerDb.close().catch(() => undefined);
        await db.query(`DROP DATABASE IF EXISTS ${peerName}`).catch(() => undefined);
      }
    } finally { await dav.close(); }
  });

  it("backs off without clearing the baseline, rejects a regressed or missing head, and verifies an immutable 412", async () => {
    const dav = await openDav();
    try {
      await linkNew(aliceCookie, dav);
      const task = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'stable')", [task, alice.id]);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      const before = (await db.query<{ baseline_hash: string }>("SELECT baseline_hash FROM core.sync_bindings WHERE user_id=$1", [alice.id])).rows[0]!.baseline_hash;
      dav.failStatus = 429;
      const limited = await cycle(aliceCookie);
      assert.equal(limited.status, 502);
      const backed = (await db.query<{ baseline_hash: string; backoff_until: Date | null }>("SELECT baseline_hash, backoff_until FROM core.sync_bindings WHERE user_id=$1", [alice.id])).rows[0]!;
      assert.equal(backed.baseline_hash, before);
      assert.ok(backed.backoff_until);
      const requests = dav.requests.length;
      const skipped = await cycle(aliceCookie);
      assert.equal(skipped.body.result, "backoff");
      assert.equal(dav.requests.length, requests);
      await db.query("UPDATE core.sync_bindings SET backoff_until=NULL WHERE user_id=$1", [alice.id]);
      const headName = [...dav.objects.keys()].find(name => name.endsWith("-head.json"))!;
      const head = JSON.parse(dav.objects.get(headName)!.body.toString("utf8")) as { generation: number };
      head.generation = 0;
      dav.objects.set(headName, { body: Buffer.from(JSON.stringify(head)), etag: `"regressed"` });
      const regressed = await cycle(aliceCookie);
      assert.equal(regressed.status, 409);
      assert.equal(regressed.body.error && (regressed.body.error as { code: string }).code, "sync_generation_regressed");
      assert.equal((await db.query<{ baseline_hash: string }>("SELECT baseline_hash FROM core.sync_bindings WHERE user_id=$1", [alice.id])).rows[0]!.baseline_hash, before);
      dav.objects.delete(headName);
      const missing = await cycle(aliceCookie);
      assert.equal(missing.status, 409);
      assert.equal((missing.body.error as { code: string }).code, "sync_remote_missing");
      assert.equal((await db.query<{ baseline_hash: string }>("SELECT baseline_hash FROM core.sync_bindings WHERE user_id=$1", [alice.id])).rows[0]!.baseline_hash, before);
      dav.objects.set(headName, { body: Buffer.from(JSON.stringify({ ...head, generation: 1 })), etag: `"back"` });
      await db.query("UPDATE core.sync_bindings SET head_etag=NULL, head_document=NULL WHERE user_id=$1", [alice.id]);
      const item = randomUUID();
      const attachment = randomUUID();
      const bytes = Buffer.from("picture-bytes");
      await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'camera')", [item, alice.id]);
      await db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,'a.bin',$4,'original/file')", [attachment, alice.id, item, bytes.length]);
      await createAppStorage(join(root, "storage"), "assets").forUser(alice.id).save("original/file", bytes);
      dav.poisonBin = true;
      const poisoned = await cycle(aliceCookie);
      assert.equal(poisoned.status, 422);
      assert.equal((poisoned.body.error as { code: string }).code, "invalid_sync");
      assert.equal((await db.query<{ baseline_hash: string }>("SELECT baseline_hash FROM core.sync_bindings WHERE user_id=$1", [alice.id])).rows[0]!.baseline_hash, before);
      for (const [name, object] of dav.objects) if (object.body.equals(Buffer.from("poison"))) dav.objects.delete(name);
      dav.raceCreate412 = true;
      const verified = await cycle(aliceCookie);
      assert.equal(verified.status, 200, verified.raw);
    } finally { await dav.close(); }
  });

  it("stops a revoked session before apply, keeps natural-key and focus conflicts, and raises the game score", async () => {
    const dav = await openDav();
    try {
      const code = await linkNew(aliceCookie, dav);
      const tagA = randomUUID();
      const sessionA = randomUUID();
      await db.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'work')", [tagA, alice.id]);
      await db.query(`INSERT INTO focus.sessions (id, user_id, kind, status, planned_duration_seconds, started_at)
        VALUES ($1,$2,'focus','running',60,now())`, [sessionA, alice.id]);
      await db.query("INSERT INTO mini_game.saves (user_id, id, score, board, high_score) VALUES ($1,'current',2,$2::jsonb,10)", [alice.id, board]);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      const puts = dav.puts.length;
      await db.query("UPDATE focus.sessions SET revision = revision + 1 WHERE id=$1", [sessionA]);
      assert.equal((await cycle(aliceCookie)).body.result, "idle");
      assert.equal(dav.puts.length, puts);
      await call("DELETE", "/api/core/data/sync", aliceCookie);
      await db.query("DELETE FROM notes.tags WHERE id=$1", [tagA]);
      await db.query("DELETE FROM focus.sessions WHERE id=$1", [sessionA]);
      await db.query("DELETE FROM mini_game.saves WHERE user_id=$1", [alice.id]);
      const tagB = randomUUID();
      const sessionB = randomUUID();
      await db.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'work')", [tagB, bob.id]);
      await db.query(`INSERT INTO focus.sessions (id, user_id, kind, status, planned_duration_seconds, started_at)
        VALUES ($1,$2,'focus','running',60,now())`, [sessionB, bob.id]);
      await db.query("INSERT INTO mini_game.saves (user_id, id, score, board, high_score) VALUES ($1,'current',2,$2::jsonb,4)", [bob.id, board]);
      await joinSync(bobCookie, dav, code);
      const token = bobCookie.split("=")[1]!;
      dav.onObjectGet = async () => { dav.onObjectGet = null; await logout(db.context(), token); };
      const revoked = await cycle(bobCookie);
      assert.equal(revoked.status, 401);
      assert.equal((await db.query("SELECT * FROM notes.tags WHERE user_id=$1 AND id=$2", [bob.id, tagA])).rowCount, 0);
      assert.equal((await db.query<{ status: string }>("SELECT status FROM focus.sessions WHERE id=$1", [sessionB])).rows[0]!.status, "running");
      bobCookie = await loginCookie(platform, bob.username, "test-password-sync-bob");
      const merged = await cycle(bobCookie);
      assert.equal(merged.status, 200, merged.raw);
      assert.equal(merged.body.result, "conflicted");
      const conflicts = await call("GET", "/api/core/data/sync/conflicts", bobCookie);
      const reasons = (conflicts.json().items as { reason: string; syncKey: string; id: string }[]).map(item => item.reason).sort();
      assert.deepEqual(reasons, ["focus-active", "natural-key"]);
      assert.equal((await db.query("SELECT id FROM notes.tags WHERE user_id=$1", [bob.id])).rows[0]!.id, tagB);
      assert.equal((await db.query("SELECT id FROM focus.sessions WHERE user_id=$1 AND status='running'", [bob.id])).rowCount, 1);
      assert.equal((await db.query<{ high_score: number }>("SELECT high_score FROM mini_game.saves WHERE user_id=$1", [bob.id])).rows[0]!.high_score, 10);
      const natural = (conflicts.json().items as { id: string; reason: string }[]).find(item => item.reason === "natural-key")!;
      await db.query("UPDATE notes.tags SET name='work-2' WHERE id=$1", [tagB]);
      const stale = await call("POST", `/api/core/data/sync/conflicts/${natural.id}`, bobCookie, { choice: "keep-local" });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error.code, "sync_stale");
      assert.equal((await db.query<{ name: string }>("SELECT name FROM notes.tags WHERE id=$1", [tagB])).rows[0]!.name, "work-2");
      assert.equal((await db.query<{ enabled: boolean }>("SELECT enabled FROM core.apps WHERE id='tasks'")).rows[0]?.enabled ?? false, false);
    } finally { await dav.close(); }
  });

  it("cleans a rejected new file and retains a file when the commit acknowledgement is lost", async () => {
    const dav = await openDav();
    try {
      const code = await linkNew(aliceCookie, dav);
      const item = randomUUID();
      const attachment = randomUUID();
      const bytes = Buffer.from([9, 8, 7, 6]);
      await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'lens')", [item, alice.id]);
      await db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,'explode.bin',$4,'original/file')", [attachment, alice.id, item, bytes.length]);
      await createAppStorage(join(root, "storage"), "assets").forUser(alice.id).save("original/file", bytes);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      await call("DELETE", "/api/core/data/sync", aliceCookie);
      await db.query("DELETE FROM assets.items WHERE id=$1", [item]);
      await joinSync(bobCookie, dav, code);
      await db.query("ALTER TABLE assets.attachments ADD CONSTRAINT sync_test_reject CHECK (filename <> 'explode.bin')");
      try {
        const rejected = await cycle(bobCookie);
        assert.notEqual(rejected.status, 200);
        assert.equal((await db.query("SELECT id FROM assets.attachments WHERE user_id=$1", [bob.id])).rowCount, 0);
        assert.deepEqual(await syncFileNames(bob.id), []);
      } finally {
        await db.query("ALTER TABLE assets.attachments DROP CONSTRAINT sync_test_reject");
      }
      await db.query("DELETE FROM core.sync_bindings WHERE user_id=$1", [bob.id]);
      await db.query("DELETE FROM core.sync_conflicts WHERE user_id=$1", [bob.id]);
      await db.query("DELETE FROM core.sync_row_state WHERE user_id=$1", [bob.id]);
      await db.query("DELETE FROM core.sync_remote_objects WHERE user_id=$1", [bob.id]);
      await joinSync(bobCookie, dav, code);
      const original = db.withTransaction.bind(db);
      let lose = true;
      db.withTransaction = async function loseCommit(fn) {
        let locked = false;
        const result = await original(async tx => {
          const query = tx.query.bind(tx);
          tx.query = (async (text: string, params?: unknown[]) => {
            const out = await query(text, params);
            if (text.includes("LOCK TABLE")) locked = true;
            return out;
          }) as typeof tx.query;
          return fn(tx);
        });
        if (locked && lose) { lose = false; throw new Error("commit acknowledgement lost"); }
        return result;
      };
      try {
        const uncertain = await cycle(bobCookie);
        assert.equal(uncertain.status, 503, uncertain.raw);
        assert.equal((uncertain.body.error as { code: string }).code, "sync_outcome_unknown");
      } finally {
        db.withTransaction = original;
      }
      assert.equal((await db.query("SELECT id FROM assets.attachments WHERE user_id=$1 AND id=$2", [bob.id, attachment])).rowCount, 1);
      assert.equal((await syncFileNames(bob.id)).length, 1);
      const phase = (await db.query<{ phase: string; baseline_hash: string | null }>("SELECT phase, baseline_hash FROM core.sync_bindings WHERE user_id=$1", [bob.id])).rows[0]!;
      assert.equal(phase.phase, "publication_unknown");
      assert.equal(phase.baseline_hash, null);
    } finally { await dav.close(); }
  });

  it("continues a large upload on the next cycle without repeating finished objects", async () => {
    const dav = await openDav();
    try {
      await linkNew(aliceCookie, dav);
      const bytesFor = (index: number) => Buffer.from(`budget-file-${index}-${"x".repeat(index + 1)}`);
      const storage = createAppStorage(join(root, "storage"), "assets").forUser(alice.id);
      for (let index = 0; index < 80; index += 1) {
        const item = randomUUID();
        const attachment = randomUUID();
        await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,$3)", [item, alice.id, `item-${index}`]);
        const bytes = bytesFor(index);
        await db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,$4,$5,$6)", [attachment, alice.id, item, `${index}.bin`, bytes.length, `original/${index}`]);
        await storage.save(`original/${index}`, bytes);
      }
      const first = await cycle(aliceCookie);
      assert.equal(first.body.result, "partial");
      assert.equal(first.body.baseline, false);
      assert.equal([...dav.objects.keys()].some(name => name.endsWith("-head.json")), false);
      const cut = dav.puts.length;
      const second = await cycle(aliceCookie);
      assert.notEqual(second.body.result, "partial");
      const immutable = (name: string) => !name.includes("-head.json") && !name.includes("pps-probe-");
      const seen = new Set(dav.puts.slice(0, cut).filter(immutable));
      assert.ok(dav.puts.slice(cut).filter(immutable).every(name => !seen.has(name)));
      assert.ok([...dav.objects.keys()].some(name => name.endsWith("-head.json")));
    } finally { await dav.close(); }
  });
});

describe("attachment file lifecycle", () => {
  it("drops a staged keep-remote file when resolve rolls back and keeps the previous file", async () => {
    const dav = await openDav();
    const peer = await openReplica("roll");
    try {
      const attachment = randomUUID();
      await publishAttachment(dav, attachment, "a.bin", "original/resolve", Buffer.from("resolve-old"));
      await peerJoin(peer, dav.endpoint, await currentPairing(aliceCookie));
      assert.equal((await settlePeer(peer)).result, "bootstrap");
      const before = await peerKey(peer, attachment);
      const localBytes = Buffer.from("peer-local");
      await peerAssets(peer).save(before, localBytes);
      await peer.db.query("UPDATE assets.attachments SET filename='local.bin', size=$2 WHERE id=$1", [attachment, localBytes.length]);
      const remoteBytes = Buffer.from("alice-next");
      await assets(alice.id).save("original/resolve", remoteBytes);
      await db.query("UPDATE assets.attachments SET size=$2 WHERE id=$1", [attachment, remoteBytes.length]);
      assert.equal((await settle(aliceCookie)).result, "published");
      assert.equal((await peerCycle(peer)).status, 200);
      const conflictId = (await peerItems(peer)).find(item => item.syncKey.includes(attachment))!.id;
      const namesBefore = await peerSyncNames(peer);
      await peer.db.query("ALTER TABLE assets.attachments ADD CONSTRAINT sync_test_reject CHECK (filename <> 'a.bin')");
      try {
        const rejected = await peer.platform.app.inject({ method: "POST", url: `/api/core/data/sync/conflicts/${conflictId}`, headers: { cookie: peer.cookie }, payload: { choice: "keep-remote" } });
        assert.notEqual(rejected.statusCode, 200);
      } finally {
        await peer.db.query("ALTER TABLE assets.attachments DROP CONSTRAINT sync_test_reject");
      }
      assert.equal((await peer.db.query<{ storage_key: string }>("SELECT storage_key FROM assets.attachments WHERE id=$1", [attachment])).rows[0]!.storage_key, before);
      assert.deepEqual(await peerSyncNames(peer), namesBefore);
      assert.deepEqual(await peerAssets(peer).read(before), localBytes);
      assert.equal((await peer.db.query<{ state: string }>("SELECT state FROM core.sync_conflicts WHERE id=$1", [conflictId])).rows[0]!.state, "open");
    } finally {
      await peer.close();
      await dav.close();
    }
  });

  it("keeps the new and old keep-remote files when the resolve commit acknowledgement is lost", async () => {
    const dav = await openDav();
    const peer = await openReplica("unk");
    try {
      const attachment = randomUUID();
      await publishAttachment(dav, attachment, "a.bin", "original/unknown", Buffer.from("unknown-old"));
      await peerJoin(peer, dav.endpoint, await currentPairing(aliceCookie));
      assert.equal((await settlePeer(peer)).result, "bootstrap");
      const previous = await peerKey(peer, attachment);
      const localBytes = Buffer.from("peer-unknown");
      await peerAssets(peer).save(previous, localBytes);
      await peer.db.query("UPDATE assets.attachments SET filename='local.bin', size=$2 WHERE id=$1", [attachment, localBytes.length]);
      const remoteBytes = Buffer.from("alice-unknown");
      await assets(alice.id).save("original/unknown", remoteBytes);
      await db.query("UPDATE assets.attachments SET size=$2 WHERE id=$1", [attachment, remoteBytes.length]);
      assert.equal((await settle(aliceCookie)).result, "published");
      assert.equal((await peerCycle(peer)).status, 200);
      const conflictId = (await peerItems(peer)).find(item => item.syncKey.includes(attachment))!.id;
      const original = peer.db.withTransaction.bind(peer.db);
      let lose = true;
      peer.db.withTransaction = async function loseCommit(fn) {
        let locked = false;
        const result = await original(async tx => {
          const query = tx.query.bind(tx);
          tx.query = (async (text: string, params?: unknown[]) => {
            const out = await query(text, params);
            if (text.includes("LOCK TABLE")) locked = true;
            return out;
          }) as typeof tx.query;
          return fn(tx);
        });
        if (locked && lose) { lose = false; throw new Error("commit acknowledgement lost"); }
        return result;
      };
      try {
        const uncertain = await peer.platform.app.inject({ method: "POST", url: `/api/core/data/sync/conflicts/${conflictId}`, headers: { cookie: peer.cookie }, payload: { choice: "keep-remote" } });
        assert.equal(uncertain.statusCode, 503, uncertain.body);
        assert.equal(uncertain.json().error.code, "sync_outcome_unknown");
      } finally {
        peer.db.withTransaction = original;
      }
      const stored = (await peer.db.query<{ storage_key: string }>("SELECT storage_key FROM assets.attachments WHERE id=$1", [attachment])).rows[0]!.storage_key;
      assert.notEqual(stored, previous);
      assert.deepEqual(await peerAssets(peer).read(stored), remoteBytes);
      assert.deepEqual(await peerAssets(peer).read(previous), localBytes);
      const unknown = (await peer.db.query<{ phase: string; pending_op_token: string | null }>("SELECT phase, pending_op_token FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!;
      assert.equal(unknown.phase, "publication_unknown");
      assert.equal(unknown.pending_op_token, null);
      const recovered = await settlePeer(peer);
      assert.equal(recovered.phase, "linked");
      assert.equal(recovered.pending, false);
      const headName = [...dav.objects.keys()].find(name => name.endsWith("-head.json"))!;
      const committedHead = JSON.parse(dav.objects.get(headName)!.body.toString("utf8")) as { generation: number; contentHash: string };
      const after = (await peer.db.query<{ phase: string; pending_op_token: string | null; storage_key: string; baseline_hash: string; baseline_generation: string }>(
        "SELECT b.phase, b.pending_op_token, b.baseline_hash, b.baseline_generation::text, a.storage_key FROM core.sync_bindings b JOIN assets.attachments a ON a.user_id=b.user_id WHERE b.user_id=$1 AND a.id=$2",
        [peer.user.id, attachment])).rows[0]!;
      assert.equal(after.phase, "linked");
      assert.equal(after.pending_op_token, null);
      assert.equal(after.baseline_hash, committedHead.contentHash);
      assert.equal(Number(after.baseline_generation), committedHead.generation);
      assert.equal(after.storage_key, stored);
      assert.deepEqual(await peerAssets(peer).read(stored), remoteBytes);
      assert.deepEqual(await peerAssets(peer).read(previous), localBytes);
    } finally {
      await peer.close();
      await dav.close();
    }
  });

  it("removes original attachment bytes after a committed remote delete and keeps them when that delete rolls back", async () => {
    const dav = await openDav();
    const peer = await openReplica("del");
    try {
      const item = randomUUID();
      const attachment = randomUUID();
      const cascadedItem = randomUUID();
      const cascaded = randomUUID();
      const bytes = Buffer.from("original-delete");
      const cascadedBytes = Buffer.from("original-cascade");
      await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'solo'),($3,$2,'parent')", [item, alice.id, cascadedItem]);
      await db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,'solo.bin',$4,'original/solo'),($5,$2,$6,'child.bin',$7,'original/child')", [attachment, alice.id, item, bytes.length, cascaded, cascadedItem, cascadedBytes.length]);
      await assets(alice.id).save("original/solo", bytes);
      await assets(alice.id).save("original/child", cascadedBytes);
      const code = await linkNew(aliceCookie, dav);
      assert.equal((await settle(aliceCookie)).result, "published");
      await peerJoin(peer, dav.endpoint, code);
      assert.equal((await settlePeer(peer)).result, "bootstrap");
      await peer.db.query("DELETE FROM assets.attachments WHERE id=$1", [attachment]);
      assert.equal((await settlePeer(peer)).result, "published");
      const originalTx = db.withTransaction.bind(db);
      db.withTransaction = function rollBackDelete(fn) {
        return originalTx(async tx => {
          const query = tx.query.bind(tx);
          let deleted = false;
          tx.query = (async (text: string, params?: unknown[]) => {
            const out = await query(text, params);
            if (text.includes('DELETE FROM "assets"."attachments"') || text.includes('DELETE FROM "assets"."items"')) deleted = true;
            if (deleted && text.includes("sync_row_state")) throw new Error("forced rollback");
            return out;
          }) as typeof tx.query;
          return fn(tx);
        });
      };
      try {
        const rolled = await cycle(aliceCookie);
        assert.notEqual(rolled.status, 200);
      } finally {
        db.withTransaction = originalTx;
      }
      assert.equal((await db.query("SELECT id FROM assets.attachments WHERE id=$1", [attachment])).rowCount, 1);
      assert.deepEqual(await assets(alice.id).read("original/solo"), bytes);
      assert.notEqual((await settle(aliceCookie)).result, "partial");
      assert.equal((await db.query("SELECT id FROM assets.attachments WHERE id=$1", [attachment])).rowCount, 0);
      await assert.rejects(() => assets(alice.id).read("original/solo"));
      await peer.db.query("DELETE FROM assets.items WHERE id=$1", [cascadedItem]);
      assert.equal((await settlePeer(peer)).result, "published");
      db.withTransaction = function rollBackCascade(fn) {
        return originalTx(async tx => {
          const query = tx.query.bind(tx);
          let deleted = false;
          tx.query = (async (text: string, params?: unknown[]) => {
            const out = await query(text, params);
            if (text.includes('DELETE FROM "assets"."items"') || text.includes('DELETE FROM "assets"."attachments"')) deleted = true;
            if (deleted && text.includes("sync_row_state")) throw new Error("forced rollback");
            return out;
          }) as typeof tx.query;
          return fn(tx);
        });
      };
      try {
        const rolledItem = await cycle(aliceCookie);
        assert.notEqual(rolledItem.status, 200);
      } finally {
        db.withTransaction = originalTx;
      }
      assert.equal((await db.query("SELECT id FROM assets.items WHERE id=$1", [cascadedItem])).rowCount, 1);
      assert.deepEqual(await assets(alice.id).read("original/child"), cascadedBytes);
      assert.notEqual((await settle(aliceCookie)).result, "partial");
      assert.equal((await db.query("SELECT id FROM assets.attachments WHERE id=$1", [cascaded])).rowCount, 0);
      await assert.rejects(() => assets(alice.id).read("original/child"));
    } finally {
      await peer.close();
      await dav.close();
    }
  });

  it("retires every replaced storage key past the old 32-file cap", async () => {
    const dav = await openDav();
    const peer = await openReplica("cap");
    try {
      const code = await linkNew(aliceCookie, dav);
      const storage = assets(alice.id);
      const ids: string[] = [];
      for (let index = 0; index < 33; index += 1) {
        const item = randomUUID();
        const attachment = randomUUID();
        ids.push(attachment);
        const bytes = Buffer.from(`cap-${index}`);
        await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,$3)", [item, alice.id, `cap-${index}`]);
        await db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,$4,$5,$6)", [attachment, alice.id, item, `${index}.bin`, bytes.length, `original/${index}`]);
        await storage.save(`original/${index}`, bytes);
      }
      assert.equal((await settle(aliceCookie)).result, "published");
      await peerJoin(peer, dav.endpoint, code);
      assert.equal((await settlePeer(peer)).result, "bootstrap");
      const previous = new Set<string>();
      for (const id of ids) previous.add(await peerKey(peer, id));
      assert.equal(previous.size, 33);
      for (let index = 0; index < ids.length; index += 1) {
        const next = Buffer.from(`cap-next-${index}-bytes`);
        const key = await attachmentKey(alice.id, ids[index]!);
        await storage.save(key, next);
        await db.query("UPDATE assets.attachments SET size=$2 WHERE id=$1", [ids[index], next.length]);
      }
      assert.equal((await settle(aliceCookie)).result, "published");
      const applied = await settlePeer(peer);
      assert.notEqual(applied.result, "partial");
      const names = await peerSyncNames(peer);
      assert.equal(names.length, 33);
      assert.equal(names.some(name => previous.has(`sync/${name}`)), false);
      const acceptedCap = Number((await peer.db.query<{ baseline_generation: string }>("SELECT baseline_generation::text FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!.baseline_generation);
      assert.ok(acceptedCap >= 1);
      for (const id of ids) {
        const key = await peerKey(peer, id);
        assert.equal(previous.has(key), false);
        assert.ok((await peerAssets(peer).read(key)).length > 0);
      }
    } finally {
      await peer.close();
      await dav.close();
    }
  });

  it("keeps an inbound fast-forward when an older head returns with a new etag", async () => {
    const dav = await openDav();
    const peer = await openReplica("gen");
    try {
      const task = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'v1')", [task, alice.id]);
      const code = await linkNew(aliceCookie, dav);
      assert.equal((await settle(aliceCookie)).result, "published");
      const headName = [...dav.objects.keys()].find(name => name.endsWith("-head.json"))!;
      const v1 = Buffer.from(dav.objects.get(headName)!.body);
      await peerJoin(peer, dav.endpoint, code);
      assert.equal((await settlePeer(peer)).result, "bootstrap");
      const first = (await peer.db.query<{ baseline_generation: string; baseline_hash: string }>(
        "SELECT baseline_generation::text, baseline_hash FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!;
      await db.query("UPDATE tasks.tasks SET title='v2' WHERE id=$1", [task]);
      assert.equal((await settle(aliceCookie)).result, "published");
      const pulled = await settlePeer(peer);
      assert.notEqual(pulled.result, "published");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      const accepted = (await peer.db.query<{ baseline_generation: string; baseline_hash: string; head_generation: string }>(
        "SELECT baseline_generation::text, baseline_hash, head_generation::text FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!;
      const v2 = Buffer.from(dav.objects.get(headName)!.body);
      const v2Head = JSON.parse(v2.toString("utf8")) as { generation: number; contentHash: string };
      assert.equal(Number(accepted.baseline_generation), v2Head.generation);
      assert.ok(Number(accepted.baseline_generation) > Number(first.baseline_generation));
      assert.equal(accepted.baseline_hash, v2Head.contentHash);
      assert.equal(accepted.head_generation, accepted.baseline_generation);
      dav.objects.set(headName, { body: v1, etag: `"restored-v1"` });
      const regressed = await peerCycle(peer);
      assert.equal(regressed.status, 409, regressed.raw);
      assert.equal((regressed.body.error as { code: string }).code, "sync_generation_regressed");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      assert.equal((await peer.db.query<{ baseline_generation: string }>("SELECT baseline_generation::text FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!.baseline_generation, accepted.baseline_generation);
      const sameGeneration = JSON.parse(v1.toString("utf8")) as { generation: number };
      sameGeneration.generation = v2Head.generation;
      dav.objects.set(headName, { body: Buffer.from(JSON.stringify(sameGeneration)), etag: `"same-generation"` });
      const rewritten = await peerCycle(peer);
      assert.equal(rewritten.status, 409, rewritten.raw);
      assert.equal((rewritten.body.error as { code: string }).code, "sync_generation_regressed");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
    } finally {
      await peer.close();
      await dav.close();
    }
  });

  it("keeps the v2 high-water when the inbound commit acknowledgement is lost", async () => {
    const dav = await openDav();
    const peer = await openReplica("crash");
    try {
      const task = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'v1')", [task, alice.id]);
      const code = await linkNew(aliceCookie, dav);
      assert.equal((await settle(aliceCookie)).result, "published");
      const headName = [...dav.objects.keys()].find(name => name.endsWith("-head.json"))!;
      const v1 = Buffer.from(dav.objects.get(headName)!.body);
      await peerJoin(peer, dav.endpoint, code);
      assert.equal((await settlePeer(peer)).result, "bootstrap");
      const acceptedV1 = Number((await peer.db.query<{ baseline_generation: string }>("SELECT baseline_generation::text FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!.baseline_generation);
      await db.query("UPDATE tasks.tasks SET title='v2' WHERE id=$1", [task]);
      assert.equal((await settle(aliceCookie)).result, "published");
      const v2 = Buffer.from(dav.objects.get(headName)!.body);
      await peer.db.query("ALTER TABLE tasks.tasks ADD CONSTRAINT sync_test_reject CHECK (title <> 'v2')");
      try {
        const rolled = await peerCycle(peer);
        assert.notEqual(rolled.status, 200);
      } finally {
        await peer.db.query("ALTER TABLE tasks.tasks DROP CONSTRAINT sync_test_reject");
      }
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v1");
      assert.equal(Number((await peer.db.query<{ baseline_generation: string }>("SELECT baseline_generation::text FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!.baseline_generation), acceptedV1);
      const original = peer.db.withTransaction.bind(peer.db);
      let lose = true;
      peer.db.withTransaction = async function loseCommit(fn) {
        let locked = false;
        const result = await original(async tx => {
          const query = tx.query.bind(tx);
          tx.query = (async (text: string, params?: unknown[]) => {
            const out = await query(text, params);
            if (text.includes("LOCK TABLE")) locked = true;
            return out;
          }) as typeof tx.query;
          return fn(tx);
        });
        if (locked && lose) { lose = false; throw new Error("lost commit ack"); }
        return result;
      };
      try {
        const unknown = await peerCycle(peer);
        assert.equal(unknown.status, 503, unknown.raw);
      } finally {
        peer.db.withTransaction = original;
      }
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      const marked = (await peer.db.query<{ baseline_generation: string; head_generation: string }>(
        "SELECT baseline_generation::text, head_generation::text FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!;
      assert.ok(Number(marked.baseline_generation) > acceptedV1);
      assert.equal(marked.head_generation, marked.baseline_generation);
      dav.objects.set(headName, { body: v1, etag: `"restored-after-unknown"` });
      const regressed = await peerCycle(peer);
      assert.equal(regressed.status, 409, regressed.raw);
      assert.equal((regressed.body.error as { code: string }).code, "sync_generation_regressed");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      dav.objects.set(headName, { body: v2, etag: `"v2-again"` });
      const recovered = await peerCycle(peer);
      assert.equal(recovered.status, 200, recovered.raw);
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
    } finally {
      await peer.close();
      await dav.close();
    }
  });

  it("keeps a first bootstrap high-water when apply commits and the acknowledgement is lost", async () => {
    const dav = await openDav();
    const peer = await openReplica("boot");
    try {
      const task = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'v1')", [task, alice.id]);
      const code = await linkNew(aliceCookie, dav);
      assert.equal((await settle(aliceCookie)).result, "published");
      const headName = [...dav.objects.keys()].find(name => name.endsWith("-head.json"))!;
      const v1 = Buffer.from(dav.objects.get(headName)!.body);
      await db.query("UPDATE tasks.tasks SET title='v2' WHERE id=$1", [task]);
      assert.equal((await settle(aliceCookie)).result, "published");
      const v2 = Buffer.from(dav.objects.get(headName)!.body);
      const v2Head = JSON.parse(v2.toString("utf8")) as { generation: number; contentHash: string };
      await peerJoin(peer, dav.endpoint, code);
      const original = peer.db.withTransaction.bind(peer.db);
      let lose = true;
      peer.db.withTransaction = async function loseCommit(fn) {
        let locked = false;
        const result = await original(async tx => {
          const query = tx.query.bind(tx);
          tx.query = (async (text: string, params?: unknown[]) => {
            const out = await query(text, params);
            if (text.includes("LOCK TABLE")) locked = true;
            return out;
          }) as typeof tx.query;
          return fn(tx);
        });
        if (locked && lose) { lose = false; throw new Error("lost commit ack"); }
        return result;
      };
      try {
        const unknown = await peerCycle(peer);
        assert.equal(unknown.status, 503, unknown.raw);
      } finally {
        peer.db.withTransaction = original;
      }
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      const marked = (await peer.db.query<{ baseline_hash: string | null; head_generation: string; remote_content_hash: string }>(
        "SELECT baseline_hash, head_generation::text, remote_content_hash FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!;
      assert.equal(marked.baseline_hash, null);
      assert.equal(Number(marked.head_generation), v2Head.generation);
      assert.equal(marked.remote_content_hash, v2Head.contentHash);
      dav.objects.set(headName, { body: v1, etag: `"boot-restored-v1"` });
      const regressed = await peerCycle(peer);
      assert.equal(regressed.status, 409, regressed.raw);
      assert.equal((regressed.body.error as { code: string }).code, "sync_generation_regressed");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      assert.equal((await peer.db.query<{ baseline_hash: string | null }>("SELECT baseline_hash FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!.baseline_hash, null);
      dav.objects.set(headName, { body: v2, etag: `"boot-v2-again"` });
      const recovered = await settlePeer(peer);
      assert.equal(recovered.result, "bootstrap");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      assert.ok((await peer.db.query<{ baseline_hash: string | null }>("SELECT baseline_hash FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!.baseline_hash);
    } finally {
      await peer.close();
      await dav.close();
    }
  });

  it("keeps an applied v2 head when the following outbound upload is partial", async () => {
    const dav = await openDav();
    const peer = await openReplica("part");
    try {
      const task = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'v1')", [task, alice.id]);
      const code = await linkNew(aliceCookie, dav);
      assert.equal((await settle(aliceCookie)).result, "published");
      const headName = [...dav.objects.keys()].find(name => name.endsWith("-head.json"))!;
      const v1 = Buffer.from(dav.objects.get(headName)!.body);
      await peerJoin(peer, dav.endpoint, code);
      assert.equal((await settlePeer(peer)).result, "bootstrap");
      const storage = peerAssets(peer);
      for (let index = 0; index < 30; index += 1) {
        const item = randomUUID();
        const attachment = randomUUID();
        const bytes = Buffer.from(`local-${index}`);
        await peer.db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,$3)", [item, peer.user.id, `local-${index}`]);
        await peer.db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,$4,$5,$6)", [attachment, peer.user.id, item, `${index}.bin`, bytes.length, `original/local-${index}`]);
        await storage.save(`original/local-${index}`, bytes);
      }
      await db.query("UPDATE tasks.tasks SET title='v2' WHERE id=$1", [task]);
      assert.equal((await settle(aliceCookie)).result, "published");
      const v2 = Buffer.from(dav.objects.get(headName)!.body);
      const v2Head = JSON.parse(v2.toString("utf8")) as { generation: number };
      const partial = await peerCycle(peer);
      assert.equal(partial.status, 200, partial.raw);
      assert.equal(partial.body.result, "partial");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      assert.equal(Number((await peer.db.query<{ count: string }>("SELECT count(*)::text FROM assets.attachments WHERE user_id=$1", [peer.user.id])).rows[0]!.count), 30);
      assert.equal(Number((await peer.db.query<{ head_generation: string }>("SELECT head_generation::text FROM core.sync_bindings WHERE user_id=$1", [peer.user.id])).rows[0]!.head_generation), v2Head.generation);
      dav.objects.set(headName, { body: v1, etag: `"partial-restored-v1"` });
      const regressed = await peerCycle(peer);
      assert.equal(regressed.status, 409, regressed.raw);
      assert.equal((regressed.body.error as { code: string }).code, "sync_generation_regressed");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      assert.equal(Number((await peer.db.query<{ count: string }>("SELECT count(*)::text FROM assets.attachments WHERE user_id=$1", [peer.user.id])).rows[0]!.count), 30);
      dav.objects.set(headName, { body: v2, etag: `"partial-v2-again"` });
      const published = await settlePeer(peer);
      assert.equal(published.result, "published");
      assert.equal((await peer.db.query<{ title: string }>("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "v2");
      assert.equal(Number((await peer.db.query<{ count: string }>("SELECT count(*)::text FROM assets.attachments WHERE user_id=$1", [peer.user.id])).rows[0]!.count), 30);
    } finally {
      await peer.close();
      await dav.close();
    }
  });
});

describe("two isolated sync deployments", () => {
  it("merges both directions across different local accounts without wiping either database", async () => {
    const dav = await openDav();
    const peerName = `pp_sync_${randomBytes(4).toString("hex")}`;
    let peerDb: Database | undefined;
    let peerPlatform: Platform | undefined;
    try {
      await db.query(`CREATE DATABASE ${peerName}`);
      const peerUrl = databaseNamed(peerName);
      await runMigrations({ databaseUrl: peerUrl, targets: [{ scope: "core", schema: "core", dir: join(repo, "migrations", "core") }] });
      await runAppMigrations({ databaseUrl: peerUrl, manifestsDir: join(repo, "apps") });
      peerDb = new Database(peerUrl, undefined, { max: 1 });
      const carol = await createTestUser(peerDb, "sync-carol");
      const built = await buildFixturePlatform({ manifests: [], database: peerDb, backendModules: {} });
      peerPlatform = built.platform;
      const carolCookie = await loginCookie(peerPlatform, carol.username, "test-password-sync-carol");
      const peerRoot = built.root;
      const task = randomUUID();
      const note = randomUUID();
      const tag = randomUUID();
      const item = randomUUID();
      const category = randomUUID();
      const attachment = randomUUID();
      const alarm = randomUUID();
      const clockId = randomUUID();
      const focusSession = randomUUID();
      const bytes = Buffer.from("round-trip");
      await db.query("INSERT INTO core.settings (key, value) VALUES ('dashboard.widgets', '{}')");
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'shared')", [task, alice.id]);
      await db.query("INSERT INTO notes.notes (id, user_id, content, occurred_at) VALUES ($1,$2,'note',now())", [note, alice.id]);
      await db.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'home')", [tag, alice.id]);
      await db.query("INSERT INTO notes.note_tags (note_id, tag_id) VALUES ($1,$2)", [note, tag]);
      await db.query("INSERT INTO assets.categories (id, user_id, name) VALUES ($1,$2,'gear')", [category, alice.id]);
      await db.query("INSERT INTO assets.items (id, user_id, name, acquired_at) VALUES ($1,$2,'camera','2026-03-29')", [item, alice.id]);
      await db.query("INSERT INTO assets.item_categories (item_id, category_id) VALUES ($1,$2)", [item, category]);
      await db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,'shot.bin',$4,'original/file')", [attachment, alice.id, item, bytes.length]);
      await createAppStorage(join(root, "storage"), "assets").forUser(alice.id).save("original/file", bytes);
      await db.query("INSERT INTO clock.settings (user_id, id, value) VALUES ($1,'prefs','{\"h\":1}'::jsonb)", [alice.id]);
      await db.query("INSERT INTO clock.alarms (id, user_id, time) VALUES ($1,$2,'08:00')", [alarm, alice.id]);
      await db.query("INSERT INTO clock.world_clocks (id, user_id, city, timezone, sort_order) VALUES ($1,$2,'UTC City','UTC',0)", [clockId, alice.id]);
      await db.query(`INSERT INTO focus.settings (user_id, id, value) VALUES ($1,'prefs','{\"m\":25}'::jsonb)`, [alice.id]);
      await db.query(`INSERT INTO focus.sessions (id, user_id, kind, status, planned_duration_seconds, started_at, ended_at, end_reason, actual_duration_seconds)
        VALUES ($1,$2,'focus','completed',60,now(),now(),'natural',60)`, [focusSession, alice.id]);
      await db.query("INSERT INTO mini_game.saves (user_id, id, score, board, high_score) VALUES ($1,'current',2,$2::jsonb,10)", [alice.id, board]);
      const code = await linkNew(aliceCookie, dav);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      const headEntry = [...dav.objects.entries()].find(([name]) => name.endsWith("-head.json"));
      const head = JSON.parse(headEntry![1].body.toString("utf8")) as { schema: Record<string, string> };
      assert.ok(!Object.keys(head.schema).some(name => name.startsWith("core.")));
      const localOnly = randomUUID();
      await peerDb.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'local-only')", [localOnly, carol.id]);
      await saveDestinationOn(peerPlatform, carolCookie, dav.endpoint);
      const joined = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync", headers: { cookie: carolCookie }, payload: { action: "join", pairingCode: code } });
      assert.equal(joined.statusCode, 200, joined.body);
      assert.notEqual(carol.id, alice.id);
      const enabled = await peerPlatform.app.inject({ method: "PUT", url: "/api/core/data/sync", headers: { cookie: carolCookie }, payload: { enabled: true, intervalSeconds: 0 } });
      assert.equal(enabled.statusCode, 200, enabled.body);
      const first = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().result, "bootstrap");
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "shared");
      assert.equal((await peerDb.query("SELECT user_id FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.user_id, carol.id);
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [localOnly])).rows[0]!.title, "local-only");
      assert.equal((await db.query("SELECT id FROM tasks.tasks WHERE id=$1 AND user_id=$2", [localOnly, alice.id])).rowCount, 0);
      assert.equal((await peerDb.query("SELECT content FROM notes.notes WHERE id=$1", [note])).rows[0]!.content, "note");
      assert.equal((await peerDb.query("SELECT tag_id FROM notes.note_tags WHERE note_id=$1", [note])).rows[0]!.tag_id, tag);
      const storedKey = String((await peerDb.query("SELECT storage_key FROM assets.attachments WHERE id=$1", [attachment])).rows[0]!.storage_key);
      assert.ok(storedKey.startsWith("sync/"));
      assert.deepEqual(await createAppStorage(join(peerRoot, "storage"), "assets").forUser(carol.id).read(storedKey), bytes);
      assert.equal((await peerDb.query("SELECT high_score FROM mini_game.saves WHERE user_id=$1", [carol.id])).rows[0]!.high_score, 10);
      assert.equal((await peerDb.query("SELECT key FROM core.settings")).rowCount, 0);
      assert.equal((await peerDb.query<{ enabled: boolean }>("SELECT enabled FROM core.apps WHERE id='tasks'")).rows[0]?.enabled ?? false, false);
      const second = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(second.statusCode, 200, second.body);
      assert.equal((await cycle(aliceCookie)).status, 200);
      assert.equal(await taskTitle(alice.id, localOnly), "local-only");
      await db.query("UPDATE tasks.tasks SET title='from-alice' WHERE id=$1", [task]);
      await peerDb.query("UPDATE tasks.tasks SET title='from-carol' WHERE id=$1", [task]);
      let release = (): void => {};
      dav.holdHead = new Promise<void>(resolveHold => { release = resolveHold; });
      const aliceRace = cycle(aliceCookie);
      await new Promise(resolveWait => setTimeout(resolveWait, 30));
      const carolWin = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(carolWin.statusCode, 200, carolWin.body);
      release();
      const aliceLost = await aliceRace;
      assert.equal(aliceLost.status, 200, aliceLost.raw);
      assert.equal(await taskTitle(alice.id, task), "from-alice");
      const open = await call("GET", "/api/core/data/sync/conflicts", aliceCookie);
      const conflict = (open.json().items as { id: string; syncKey: string; reason: string }[]).find(item => item.syncKey.startsWith("tasks.tasks:"));
      assert.ok(conflict);
      assert.equal(conflict!.reason, "diverged");
      await db.query("UPDATE tasks.tasks SET title='stale-local' WHERE id=$1", [task]);
      const stale = await call("POST", `/api/core/data/sync/conflicts/${conflict!.id}`, aliceCookie, { choice: "keep-local" });
      assert.equal(stale.statusCode, 409);
      await db.query("UPDATE tasks.tasks SET title='from-alice' WHERE id=$1", [task]);
      const kept = await call("POST", `/api/core/data/sync/conflicts/${conflict!.id}`, aliceCookie, { choice: "keep-local" });
      assert.equal(kept.statusCode, 200, kept.body);
      assert.equal((await cycle(aliceCookie)).status, 200);
      const carolSees = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(carolSees.statusCode, 200, carolSees.body);
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.title, "from-alice");
      await db.query("DELETE FROM notes.notes WHERE id=$1", [note]);
      assert.equal((await cycle(aliceCookie)).status, 200);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      assert.equal((await peerDb.query("SELECT id FROM notes.notes WHERE id=$1", [note])).rowCount, 0);
      await peerDb.query("DELETE FROM tasks.tasks WHERE id=$1", [localOnly]);
      const deletedLocal = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(deletedLocal.statusCode, 200, deletedLocal.body);
      assert.equal((await cycle(aliceCookie)).status, 200);
      assert.equal((await db.query("SELECT id FROM tasks.tasks WHERE id=$1", [localOnly])).rowCount, 0);
      const replacement = Buffer.from("replaced-bytes");
      const carolKey = String((await peerDb.query("SELECT storage_key FROM assets.attachments WHERE id=$1", [attachment])).rows[0]!.storage_key);
      await createAppStorage(join(peerRoot, "storage"), "assets").forUser(carol.id).save(carolKey, replacement);
      await peerDb.query("UPDATE assets.attachments SET size=$2 WHERE id=$1", [attachment, replacement.length]);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      assert.equal((await cycle(aliceCookie)).status, 200);
      const aliceKey = String((await db.query("SELECT storage_key FROM assets.attachments WHERE id=$1", [attachment])).rows[0]!.storage_key);
      assert.deepEqual(await createAppStorage(join(root, "storage"), "assets").forUser(alice.id).read(aliceKey), replacement);
      await peerDb.query("UPDATE mini_game.saves SET high_score=4 WHERE user_id=$1", [carol.id]);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      assert.equal((await peerDb.query<{ high_score: number }>("SELECT high_score FROM mini_game.saves WHERE user_id=$1", [carol.id])).rows[0]!.high_score, 10);
      await peerDb.query("UPDATE mini_game.saves SET high_score=12, score=12 WHERE user_id=$1", [carol.id]);
      await peerDb.query("UPDATE mini_game.saves SET board=$2::jsonb WHERE user_id=$1", [carol.id, board]);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      const aliceGame = await cycle(aliceCookie);
      assert.equal(aliceGame.status, 200, aliceGame.raw);
      assert.equal((await db.query<{ high_score: number }>("SELECT high_score FROM mini_game.saves WHERE user_id=$1", [alice.id])).rows[0]!.high_score, 12);
      const parentNote = randomUUID();
      const childTag = randomUUID();
      await db.query("INSERT INTO notes.notes (id, user_id, content, occurred_at) VALUES ($1,$2,'parent',now())", [parentNote, alice.id]);
      assert.equal((await cycle(aliceCookie)).status, 200);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      await peerDb.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'child')", [childTag, carol.id]);
      await peerDb.query("INSERT INTO notes.note_tags (note_id, tag_id) VALUES ($1,$2)", [parentNote, childTag]);
      await db.query("DELETE FROM notes.notes WHERE id=$1", [parentNote]);
      assert.equal((await cycle(aliceCookie)).status, 200);
      const parentConflict = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(parentConflict.statusCode, 200, parentConflict.body);
      assert.ok((parentConflict.json().openConflicts as number) > 0);
      assert.equal((await peerDb.query("SELECT id FROM notes.notes WHERE id=$1", [parentNote])).rowCount, 1);
      const reasons = (await peerDb.query<{ reason: string }>("SELECT reason FROM core.sync_conflicts WHERE user_id=$1 AND state='open'", [carol.id])).rows.map(row => row.reason);
      assert.ok(reasons.includes("parent-child"));
      const foreign = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'owned-by-bob')", [foreign, bob.id]);
      await peerDb.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'from-carol')", [foreign, carol.id]);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      const blocked = await cycle(aliceCookie);
      assert.equal(blocked.status, 409, blocked.raw);
      assert.equal((blocked.body.error as { code: string }).code, "sync_foreign_owner");
      assert.equal(await taskTitle(bob.id, foreign), "owned-by-bob");
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [foreign])).rows[0]!.title, "from-carol");
    } finally {
      await dav.close();
      if (peerPlatform) await peerPlatform.stop().catch(() => undefined);
      if (peerDb) await peerDb.close().catch(() => undefined);
      await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()`, [peerName]).catch(() => undefined);
      await db.query(`DROP DATABASE IF EXISTS ${peerName}`).catch(() => undefined);
    }
  });
});

function davPath(filename: string): string {
  return filename.startsWith("/dav/") ? filename : "/dav/" + filename;
}

function resealHead(dav: DavBox): void {
  const name = [...dav.objects.keys()].find(item => item.endsWith("-head.json"));
  if (!name) throw new Error("missing head");
  const head = JSON.parse(dav.objects.get(name)!.body.toString("utf8")) as {
    identityId: string; contentHash: string; schema: unknown; tables: unknown; files: unknown; tombstones: { filename: string; sha256: string; size: number; kind: string };
  };
  const body = { schema: head.schema, tables: head.tables, files: head.files, tombstones: head.tombstones };
  head.contentHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  dav.objects.set(name, { body: Buffer.from(JSON.stringify(head)), etag: `"seal-${head.contentHash.slice(0, 8)}"` });
}

describe("sync review regressions", () => {
  it("rejects a rehashed forged owner and a cross-user relation tombstone through the API", async () => {
    const dav = await openDav();
    try {
      const code = await linkNew(aliceCookie, dav);
      const task = randomUUID();
      const note = randomUUID();
      const tag = randomUUID();
      const bobNote = randomUUID();
      const bobTag = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'owned')", [task, alice.id]);
      await db.query("INSERT INTO notes.notes (id, user_id, content, occurred_at) VALUES ($1,$2,'n',now())", [note, alice.id]);
      await db.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'t')", [tag, alice.id]);
      await db.query("INSERT INTO notes.note_tags (note_id, tag_id) VALUES ($1,$2)", [note, tag]);
      await db.query("INSERT INTO notes.notes (id, user_id, content, occurred_at) VALUES ($1,$2,'bob',now())", [bobNote, bob.id]);
      await db.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'bob-tag')", [bobTag, bob.id]);
      await db.query("INSERT INTO notes.note_tags (note_id, tag_id) VALUES ($1,$2)", [bobNote, bobTag]);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      const headName = [...dav.objects.keys()].find(item => item.endsWith("-head.json"))!;
      const head = JSON.parse(dav.objects.get(headName)!.body.toString("utf8")) as {
        identityId: string; generation: number; opToken: string; parentOpToken: string | null;
        tables: Record<string, { bucket: number; object: { filename: string; sha256: string; size: number; kind: string } }[]>;
        tombstones: { filename: string; sha256: string; size: number; kind: "tombstones" };
      };
      const bucket = head.tables["tasks.tasks"]![0]!;
      const previousName = davPath(bucket.object.filename);
      const rows = JSON.parse(dav.objects.get(previousName)!.body.toString("utf8")) as { user_id: string }[];
      rows[0]!.user_id = bob.id;
      const forged = Buffer.from(canonicalJson(rows));
      const sha = digest(forged);
      const filename = syncObjectName(head.identityId, sha, "rows");
      bucket.object = { filename, sha256: sha, size: forged.length, kind: "rows" };
      dav.objects.set(davPath(filename), { body: forged, etag: `"forged"` });
      head.parentOpToken = head.opToken;
      head.opToken = randomUUID();
      head.generation += 1;
      dav.objects.set(headName, { body: Buffer.from(JSON.stringify(head)), etag: `"forged-head"` });
      resealHead(dav);
      const rejected = await cycle(aliceCookie);
      assert.equal(rejected.status, 422, rejected.raw);
      assert.equal((rejected.body.error as { code: string }).code, "invalid_sync");
      assert.equal((await db.query("SELECT user_id FROM tasks.tasks WHERE id=$1", [task])).rows[0]!.user_id, alice.id);
      const tombName = davPath(head.tombstones.filename);
      const tombstones = JSON.parse(dav.objects.get(tombName)!.body.toString("utf8")) as string[];
      tombstones.push(syncKeyOf("notes.note_tags", { note_id: bobNote, tag_id: bobTag }));
      const tombBytes = Buffer.from(canonicalJson(tombstones));
      const tombSha = digest(tombBytes);
      head.tombstones = { filename: syncObjectName(head.identityId, tombSha, "tombstones"), sha256: tombSha, size: tombBytes.length, kind: "tombstones" };
      dav.objects.set(davPath(head.tombstones.filename), { body: tombBytes, etag: `"tomb"` });
      head.parentOpToken = head.opToken;
      head.opToken = randomUUID();
      head.generation += 1;
      dav.objects.set(headName, { body: Buffer.from(JSON.stringify(head)), etag: `"tomb-head"` });
      resealHead(dav);
      const blocked = await cycle(aliceCookie);
      assert.notEqual(blocked.status, 200, blocked.raw);
      assert.equal((await db.query("SELECT tag_id FROM notes.note_tags WHERE note_id=$1 AND tag_id=$2", [bobNote, bobTag])).rowCount, 1);
      assert.equal(code.length > 0, true);
    } finally { await dav.close(); }
  });

  it("publishes keep-local resurrection and keep-remote deletion without repeating the conflict", async () => {
    const dav = await openDav();
    const peerName = `pp_sync_rev_${randomBytes(3).toString("hex")}`;
    let peerDb: Database | undefined;
    let peerPlatform: Platform | undefined;
    try {
      await db.query(`CREATE DATABASE ${peerName}`);
      const peerUrl = databaseNamed(peerName);
      await runMigrations({ databaseUrl: peerUrl, targets: [{ scope: "core", schema: "core", dir: join(repo, "migrations", "core") }] });
      await runAppMigrations({ databaseUrl: peerUrl, manifestsDir: join(repo, "apps") });
      peerDb = new Database(peerUrl, undefined, { max: 1 });
      const carol = await createTestUser(peerDb, "sync-carol-revive");
      const built = await buildFixturePlatform({ manifests: [], database: peerDb, backendModules: {} });
      peerPlatform = built.platform;
      const carolCookie = await loginCookie(peerPlatform, carol.username, "test-password-sync-carol-revive");
      const kept = randomUUID();
      const dropped = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'keep-me'),($3,$2,'drop-me')", [kept, alice.id, dropped]);
      const code = await linkNew(aliceCookie, dav);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      await saveDestinationOn(peerPlatform, carolCookie, dav.endpoint);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync", headers: { cookie: carolCookie }, payload: { action: "join", pairingCode: code } })).statusCode, 200);
      assert.equal((await peerPlatform.app.inject({ method: "PUT", url: "/api/core/data/sync", headers: { cookie: carolCookie }, payload: { enabled: true, intervalSeconds: 0 } })).statusCode, 200);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).json().result, "bootstrap");
      await db.query("UPDATE tasks.tasks SET title='kept-local' WHERE id=$1", [kept]);
      await db.query("UPDATE tasks.tasks SET title='drop-local' WHERE id=$1", [dropped]);
      await peerDb.query("DELETE FROM tasks.tasks WHERE id=$1 OR id=$2", [kept, dropped]);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      const conflicted = await cycle(aliceCookie);
      assert.equal(conflicted.status, 200, conflicted.raw);
      const open = await call("GET", "/api/core/data/sync/conflicts", aliceCookie);
      const items = open.json().items as { id: string; syncKey: string }[];
      const keep = items.find(item => item.syncKey.includes(kept));
      const drop = items.find(item => item.syncKey.includes(dropped));
      assert.ok(keep && drop);
      assert.equal((await call("POST", `/api/core/data/sync/conflicts/${keep!.id}`, aliceCookie, { choice: "keep-local" })).statusCode, 200);
      assert.equal((await call("POST", `/api/core/data/sync/conflicts/${drop!.id}`, aliceCookie, { choice: "keep-remote" })).statusCode, 200);
      assert.equal(await taskTitle(alice.id, kept), "kept-local");
      assert.equal(await taskTitle(alice.id, dropped), undefined);
      const published = await cycle(aliceCookie);
      assert.equal(published.status, 200, published.raw);
      const again = await cycle(aliceCookie);
      assert.equal(again.body.openConflicts, 0);
      assert.equal(await taskTitle(alice.id, kept), "kept-local");
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [kept])).rows[0]!.title, "kept-local");
      assert.equal((await peerDb.query("SELECT id FROM tasks.tasks WHERE id=$1", [dropped])).rowCount, 0);
    } finally {
      if (peerPlatform) await peerPlatform.stop().catch(() => undefined);
      if (peerDb) await peerDb.close().catch(() => undefined);
      await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()`, [peerName]).catch(() => undefined);
      await db.query(`DROP DATABASE IF EXISTS ${peerName}`).catch(() => undefined);
      await dav.close();
    }
  });

  it("publishes unrelated rows around a divergence, keeps a natural-key choice, and conflicts a newer remote delete", async () => {
    const dav = await openDav();
    const peerName = `pp_sync_choice_${randomBytes(3).toString("hex")}`;
    let peerDb: Database | undefined;
    let peerPlatform: Platform | undefined;
    try {
      await db.query(`CREATE DATABASE ${peerName}`);
      const peerUrl = databaseNamed(peerName);
      await runMigrations({ databaseUrl: peerUrl, targets: [{ scope: "core", schema: "core", dir: join(repo, "migrations", "core") }] });
      await runAppMigrations({ databaseUrl: peerUrl, manifestsDir: join(repo, "apps") });
      peerDb = new Database(peerUrl, undefined, { max: 1 });
      const carol = await createTestUser(peerDb, "sync-carol-choice");
      const built = await buildFixturePlatform({ manifests: [], database: peerDb, backendModules: {} });
      peerPlatform = built.platform;
      const carolCookie = await loginCookie(peerPlatform, carol.username, "test-password-sync-carol-choice");
      const peerRoot = built.root;
      const shared = randomUUID();
      const tag = randomUUID();
      const carolTag = randomUUID();
      const item = randomUUID();
      const attachment = randomUUID();
      const bytes = Buffer.from("choice-bytes");
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'base')", [shared, alice.id]);
      await db.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'shared-name')", [tag, alice.id]);
      await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'lens')", [item, alice.id]);
      await db.query("INSERT INTO assets.attachments (id, user_id, item_id, filename, size, storage_key) VALUES ($1,$2,$3,'a.bin',$4,'original/file')", [attachment, alice.id, item, bytes.length]);
      await createAppStorage(join(root, "storage"), "assets").forUser(alice.id).save("original/file", bytes);
      const code = await linkNew(aliceCookie, dav);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      await peerDb.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'shared-name')", [carolTag, carol.id]);
      await saveDestinationOn(peerPlatform, carolCookie, dav.endpoint);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync", headers: { cookie: carolCookie }, payload: { action: "join", pairingCode: code } })).statusCode, 200);
      assert.equal((await peerPlatform.app.inject({ method: "PUT", url: "/api/core/data/sync", headers: { cookie: carolCookie }, payload: { enabled: true, intervalSeconds: 0 } })).statusCode, 200);
      const boot = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(boot.statusCode, 200, boot.body);
      assert.equal(boot.json().result, "conflicted");
      const extra = randomUUID();
      await peerDb.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'unrelated')", [extra, carol.id]);
      const publishedExtra = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(publishedExtra.statusCode, 200, publishedExtra.body);
      assert.equal((await cycle(aliceCookie)).status, 200);
      const aliceNames = (await db.query<{ name: string }>("SELECT name FROM notes.tags WHERE user_id=$1 ORDER BY name", [alice.id])).rows.map(row => row.name);
      assert.deepEqual(aliceNames, ["shared-name", "unrelated"]);
      assert.equal((await db.query("SELECT id FROM notes.tags WHERE user_id=$1 AND name='shared-name'", [alice.id])).rows[0]!.id, tag);
      const natural = (await peerPlatform.app.inject({ method: "GET", url: "/api/core/data/sync/conflicts", headers: { cookie: carolCookie } })).json().items as { id: string; reason: string }[];
      const naturalId = natural.find(item => item.reason === "natural-key")!.id;
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: `/api/core/data/sync/conflicts/${naturalId}`, headers: { cookie: carolCookie }, payload: { choice: "keep-local" } })).statusCode, 200);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      assert.equal((await cycle(aliceCookie)).status, 200);
      assert.equal((await db.query("SELECT id FROM notes.tags WHERE id=$1", [tag])).rowCount, 0);
      assert.equal((await db.query<{ name: string }>("SELECT name FROM notes.tags WHERE id=$1", [carolTag])).rows[0]!.name, "shared-name");
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      assert.equal((await peerDb.query("SELECT id FROM notes.tags WHERE id=$1", [tag])).rowCount, 0);
      assert.equal((await peerDb.query("SELECT id FROM notes.tags WHERE id=$1", [carolTag])).rowCount, 1);
      await db.query("UPDATE tasks.tasks SET title='from-alice' WHERE id=$1", [shared]);
      await peerDb.query("UPDATE tasks.tasks SET title='from-carol' WHERE id=$1", [shared]);
      const side = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'side')", [side, alice.id]);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      const diverged = await cycle(aliceCookie);
      assert.equal(diverged.status, 200, diverged.raw);
      assert.equal(await taskTitle(alice.id, shared), "from-alice");
      const carolSide = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(carolSide.statusCode, 200, carolSide.body);
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [side])).rows[0]!.title, "side");
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [shared])).rows[0]!.title, "from-carol");
      await db.query("UPDATE tasks.tasks SET title='side-2' WHERE id=$1", [side]);
      dav.dropHeadPut = true;
      const dropped = await cycle(aliceCookie);
      assert.equal(dropped.status, 502, dropped.raw);
      const recovered = await cycle(aliceCookie);
      assert.equal(recovered.status, 200, recovered.raw);
      assert.equal(recovered.body.result, "committed");
      assert.equal(await taskTitle(alice.id, shared), "from-alice");
      const still = await call("GET", "/api/core/data/sync/conflicts", aliceCookie);
      assert.ok((still.json().items as { syncKey: string }[]).some(item => item.syncKey.includes(shared)));
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [side])).rows[0]!.title, "side-2");
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [shared])).rows[0]!.title, "from-carol");
      const removed = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'gone')", [removed, alice.id]);
      assert.equal((await cycle(aliceCookie)).status, 200);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      await peerDb.query("DELETE FROM tasks.tasks WHERE id=$1", [removed]);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      await db.query("UPDATE tasks.tasks SET title='kept-gone' WHERE id=$1", [removed]);
      const deletion = await cycle(aliceCookie);
      assert.equal(deletion.status, 200, deletion.raw);
      const deletionItems = (await call("GET", "/api/core/data/sync/conflicts", aliceCookie)).json().items as { id: string; syncKey: string }[];
      const deletionId = deletionItems.find(item => item.syncKey.includes(removed))!.id;
      assert.equal((await call("POST", `/api/core/data/sync/conflicts/${deletionId}`, aliceCookie, { choice: "keep-local" })).statusCode, 200);
      await peerDb.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'remote-new')", [removed, carol.id]);
      const peerResurrection = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(peerResurrection.statusCode, 200, peerResurrection.body);
      const peerOpen = await peerPlatform.app.inject({ method: "GET", url: "/api/core/data/sync/conflicts", headers: { cookie: carolCookie } });
      const peerItems = peerOpen.json().items as { id: string; syncKey: string; reason: string }[];
      const peerRevive = peerItems.find(item => item.syncKey.includes(removed));
      assert.equal(peerRevive?.reason, "resurrection");
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: `/api/core/data/sync/conflicts/${peerRevive!.id}`, headers: { cookie: carolCookie }, payload: { choice: "keep-local" } })).statusCode, 200);
      const peerPublished = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
      assert.equal(peerPublished.statusCode, 200, peerPublished.body);
      assert.equal((await peerDb.query("SELECT title FROM tasks.tasks WHERE id=$1", [removed])).rows[0]!.title, "remote-new");
      assert.equal(await taskTitle(alice.id, removed), "kept-gone");
      const newer = await cycle(aliceCookie);
      assert.equal(newer.status, 200, newer.raw);
      assert.equal(await taskTitle(alice.id, removed), "kept-gone");
      assert.ok(((await call("GET", "/api/core/data/sync/conflicts", aliceCookie)).json().items as { syncKey: string }[]).some(item => item.syncKey.includes(removed)));
      const carolKey = String((await peerDb.query("SELECT storage_key FROM assets.attachments WHERE id=$1", [attachment])).rows[0]!.storage_key);
      const replaced = Buffer.from("carol-bytes-1");
      await createAppStorage(join(peerRoot, "storage"), "assets").forUser(carol.id).save(carolKey, replaced);
      await peerDb.query("UPDATE assets.attachments SET size=$2 WHERE id=$1", [attachment, replaced.length]);
      assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } })).statusCode, 200);
      const aliceKey = String((await db.query("SELECT storage_key FROM assets.attachments WHERE id=$1", [attachment])).rows[0]!.storage_key);
      await createAppStorage(join(root, "storage"), "assets").forUser(alice.id).save(aliceKey, Buffer.from("alice-bytes-1"));
      await db.query("UPDATE assets.attachments SET size=$2 WHERE id=$1", [attachment, Buffer.from("alice-bytes-1").length]);
      const fileConflict = await cycle(aliceCookie);
      assert.equal(fileConflict.status, 200, fileConflict.raw);
      await createAppStorage(join(root, "storage"), "assets").forUser(alice.id).save(aliceKey, Buffer.from("alice-bytes-2"));
      await db.query("UPDATE assets.attachments SET size=$2 WHERE id=$1", [attachment, Buffer.from("alice-bytes-2").length]);
      const fileItems = (await call("GET", "/api/core/data/sync/conflicts", aliceCookie)).json().items as { id: string; syncKey: string }[];
      const fileId = fileItems.find(item => item.syncKey.includes(attachment))!.id;
      const fileStale = await call("POST", `/api/core/data/sync/conflicts/${fileId}`, aliceCookie, { choice: "keep-local" });
      assert.equal(fileStale.statusCode, 409, fileStale.body);
      assert.equal(fileStale.json().error.code, "sync_stale");
    } finally {
      if (peerPlatform) await peerPlatform.stop().catch(() => undefined);
      if (peerDb) await peerDb.close().catch(() => undefined);
      await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()`, [peerName]).catch(() => undefined);
      await db.query(`DROP DATABASE IF EXISTS ${peerName}`).catch(() => undefined);
      await dav.close();
    }
  });

  it("retargets note and asset links for both natural-key choices", async () => {
    for (const choice of ["keep-local", "keep-remote"] as const) {
      for (const kind of ["notes", "assets"] as const) await assertNaturalLinks(choice, kind);
    }
  });

  it("refuses resolve and destination changes while a cycle holds the lease", async () => {
    const dav = await openDav();
    try {
      await linkNew(aliceCookie, dav);
      const task = randomUUID();
      await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'race')", [task, alice.id]);
      assert.equal((await cycle(aliceCookie)).body.result, "published");
      await db.query("UPDATE tasks.tasks SET title='next' WHERE id=$1", [task]);
      let release = (): void => {};
      dav.holdHead = new Promise<void>(resolveHold => { release = resolveHold; });
      const running = cycle(aliceCookie);
      await new Promise(resolveWait => setTimeout(resolveWait, 40));
      const paused = await call("PUT", "/api/core/data/sync", aliceCookie, { enabled: false });
      assert.equal(paused.statusCode, 409);
      assert.equal(paused.json().error.code, "sync_busy");
      const moved = await call("PUT", "/api/core/data/webdav", aliceCookie, { endpoint: dav.endpoint + "other/", username: "dav-user", password: "secret", scope: "own", intervalHours: 0 });
      assert.equal(moved.statusCode, 409);
      release();
      assert.equal((await running).status, 200);
    } finally { await dav.close(); }
  });
});

async function assertNaturalLinks(choice: "keep-local" | "keep-remote", kind: "notes" | "assets"): Promise<void> {
  const label = kind + " " + choice;
  await db.query("TRUNCATE tasks.tasks, notes.notes, notes.tags, notes.note_tags, assets.categories, assets.items, assets.item_categories, assets.attachments, clock.settings, clock.alarms, clock.world_clocks, focus.settings, focus.sessions, mini_game.saves CASCADE");
  await db.query("DELETE FROM core.sync_conflicts");
  await db.query("DELETE FROM core.sync_row_state");
  await db.query("DELETE FROM core.sync_bindings");
  await db.query("DELETE FROM core.backup_targets");
  const dav = await openDav();
  const peerName = `pp_sync_link_${randomBytes(3).toString("hex")}`;
  let peerDb: Database | undefined;
  let peerPlatform: Platform | undefined;
  try {
    await db.query(`CREATE DATABASE ${peerName}`);
    const peerUrl = databaseNamed(peerName);
    await runMigrations({ databaseUrl: peerUrl, targets: [{ scope: "core", schema: "core", dir: join(repo, "migrations", "core") }] });
    await runAppMigrations({ databaseUrl: peerUrl, manifestsDir: join(repo, "apps") });
    peerDb = new Database(peerUrl, undefined, { max: 1 });
    const carol = await createTestUser(peerDb, "sync-carol-" + kind + "-" + choice);
    const built = await buildFixturePlatform({ manifests: [], database: peerDb, backendModules: {} });
    peerPlatform = built.platform;
    const carolCookie = await loginCookie(peerPlatform, carol.username, "test-password-sync-carol-" + kind + "-" + choice);
    const remoteParent = randomUUID();
    const localParent = randomUUID();
    const remoteChild = randomUUID();
    const localChild = randomUUID();
    const task = randomUUID();
    if (kind === "notes") {
      await db.query("INSERT INTO notes.notes (id, user_id, content, occurred_at) VALUES ($1,$2,'remote-note',now())", [remoteChild, alice.id]);
      await db.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'shared-name')", [remoteParent, alice.id]);
      await db.query("INSERT INTO notes.note_tags (note_id, tag_id) VALUES ($1,$2)", [remoteChild, remoteParent]);
      await peerDb.query("INSERT INTO notes.notes (id, user_id, content, occurred_at) VALUES ($1,$2,'local-note',now())", [localChild, carol.id]);
      await peerDb.query("INSERT INTO notes.tags (id, user_id, name) VALUES ($1,$2,'shared-name')", [localParent, carol.id]);
      await peerDb.query("INSERT INTO notes.note_tags (note_id, tag_id) VALUES ($1,$2)", [localChild, localParent]);
    } else {
      await db.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'remote-item')", [remoteChild, alice.id]);
      await db.query("INSERT INTO assets.categories (id, user_id, name) VALUES ($1,$2,'shared-name')", [remoteParent, alice.id]);
      await db.query("INSERT INTO assets.item_categories (item_id, category_id) VALUES ($1,$2)", [remoteChild, remoteParent]);
      await peerDb.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'local-item')", [localChild, carol.id]);
      await peerDb.query("INSERT INTO assets.categories (id, user_id, name) VALUES ($1,$2,'shared-name')", [localParent, carol.id]);
      await peerDb.query("INSERT INTO assets.item_categories (item_id, category_id) VALUES ($1,$2)", [localChild, localParent]);
    }
    await db.query("INSERT INTO tasks.tasks (id, user_id, title) VALUES ($1,$2,'unrelated')", [task, alice.id]);
    const code = await linkNew(aliceCookie, dav);
    assert.equal((await cycle(aliceCookie)).body.result, "published", label);
    await saveDestinationOn(peerPlatform, carolCookie, dav.endpoint);
    assert.equal((await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync", headers: { cookie: carolCookie }, payload: { action: "join", pairingCode: code } })).statusCode, 200, label);
    await peerPlatform.app.inject({ method: "PUT", url: "/api/core/data/sync", headers: { cookie: carolCookie }, payload: { enabled: true, intervalSeconds: 0 } });
    const boot = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
    assert.equal(boot.statusCode, 200, label + " " + boot.body);
    assert.equal(boot.json().result, "conflicted", label);
    const link = kind === "notes" ? "notes.note_tags" : "assets.item_categories";
    const parentColumn = kind === "notes" ? "tag_id" : "category_id";
    const childColumn = kind === "notes" ? "note_id" : "item_id";
    assert.equal((await peerDb.query(`SELECT ${parentColumn} FROM ${link} WHERE ${childColumn}=$1`, [remoteChild])).rowCount, 0, label);
    assert.equal((await peerDb.query(`SELECT ${parentColumn} FROM ${link} WHERE ${childColumn}=$1`, [localChild])).rows[0]![parentColumn], localParent, label);
    const open = (await peerPlatform.app.inject({ method: "GET", url: "/api/core/data/sync/conflicts", headers: { cookie: carolCookie } })).json().items as { id: string; reason: string }[];
    const naturalId = open.find(item => item.reason === "natural-key")!.id;
    assert.equal((await peerPlatform.app.inject({ method: "POST", url: `/api/core/data/sync/conflicts/${naturalId}`, headers: { cookie: carolCookie }, payload: { choice } })).statusCode, 200, label);
    const published = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
    assert.equal(published.statusCode, 200, label + " " + published.body);
    const pulled = await cycle(aliceCookie);
    assert.equal(pulled.status, 200, label + " " + pulled.raw);
    const survivor = choice === "keep-local" ? localParent : remoteParent;
    const loser = choice === "keep-local" ? remoteParent : localParent;
    for (const database of [db, peerDb]) {
      assert.equal((await database.query(`SELECT id FROM ${kind === "notes" ? "notes.tags" : "assets.categories"} WHERE id=$1`, [loser])).rowCount, 0, label);
      assert.equal((await database.query(`SELECT id FROM ${kind === "notes" ? "notes.tags" : "assets.categories"} WHERE id=$1`, [survivor])).rowCount, 1, label);
      assert.equal((await database.query(`SELECT ${parentColumn} FROM ${link} WHERE ${childColumn}=$1`, [remoteChild])).rows[0]![parentColumn], survivor, label);
      assert.equal((await database.query(`SELECT ${parentColumn} FROM ${link} WHERE ${childColumn}=$1`, [localChild])).rows[0]![parentColumn], survivor, label);
    }
    const again = await peerPlatform.app.inject({ method: "POST", url: "/api/core/data/sync/cycle", headers: { cookie: carolCookie } });
    assert.equal(again.statusCode, 200, label + " " + again.body);
    assert.equal((await peerDb.query<{ count: number }>("SELECT count(*)::int AS count FROM core.sync_conflicts WHERE user_id=$1 AND state='open'", [carol.id])).rows[0]!.count, 0, label);
  } finally {
    if (peerPlatform) await peerPlatform.stop().catch(() => undefined);
    if (peerDb) await peerDb.close().catch(() => undefined);
    await dav.close();
    await db.query(`DROP DATABASE IF EXISTS ${peerName}`).catch(() => undefined);
  }
}

async function saveDestinationOn(target: Platform, cookie: string, endpoint: string): Promise<void> {
  const response = await target.app.inject({
    method: "PUT", url: "/api/core/data/webdav", headers: { cookie },
    payload: { endpoint, username: "dav-user", password: "secret", scope: "own", intervalHours: 0 },
  });
  assert.equal(response.statusCode, 200, response.body);
}
