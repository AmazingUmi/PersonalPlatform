import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { backupKey, decryptPassword, encryptPassword } from "../../src/core/data-management/credentials.js";
import { davRequest, DAV_MAX_BYTES, normalizeEndpoint, publicAddress, resolveWithTimeout } from "../../src/core/data-management/webdav-http.js";

const originalKey = process.env.DATA_BACKUP_ENCRYPTION_KEY;
const originalOrigins = process.env.DATA_BACKUP_ALLOWED_ORIGINS;
it("bounds stalled DNS resolution before any socket can be opened", { timeout: 1000 }, async () => {
  await assert.rejects(resolveWithTimeout("example.com", 10, () => new Promise(() => {})), /could not be resolved/);
  const address = [{ address: "93.184.216.34", family: 4 }];
  assert.deepEqual(await resolveWithTimeout("example.com", 1000, async () => address), address);
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.DATA_BACKUP_ENCRYPTION_KEY; else process.env.DATA_BACKUP_ENCRYPTION_KEY = originalKey;
  if (originalOrigins === undefined) delete process.env.DATA_BACKUP_ALLOWED_ORIGINS; else process.env.DATA_BACKUP_ALLOWED_ORIGINS = originalOrigins;
});

describe("WebDAV credential storage", () => {
  it("encrypts with random nonces, authenticates the owner and rejects corruption/wrong keys", () => {
    const key = randomBytes(32), owner = randomUUID(), secret = "网盘 app password";
    const first = encryptPassword(secret, key, owner), second = encryptPassword(secret, key, owner);
    assert.notEqual(first, second);
    assert.equal(decryptPassword(first, key, owner), secret);
    assert.throws(() => decryptPassword(first, key, randomUUID()), /decrypt/);
    assert.throws(() => decryptPassword(first, randomBytes(32), owner), /decrypt/);
    const damaged = Buffer.from(first, "base64"); damaged[15] = damaged[15]! ^ 1;
    assert.throws(() => decryptPassword(damaged.toString("base64"), key, owner), /decrypt/);
    assert(!first.includes(secret));
  });

  it("persists one private key across reloads and concurrent first use", async () => {
    delete process.env.DATA_BACKUP_ENCRYPTION_KEY;
    const root = await mkdtemp(join(tmpdir(), "pp-dav-key-"));
    try {
      const keys = await Promise.all(Array.from({ length: 8 }, () => backupKey(root)));
      assert.equal(keys[0]!.length, 32);
      for (const key of keys) assert.deepEqual(key, keys[0]);
      assert.deepEqual(await backupKey(root), keys[0]);
      assert.equal((await stat(join(root, ".core", "backup.key"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, ".core"))).mode & 0o777, 0o700);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts only exact 32-byte environment keys and rejects a linked key directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pp-dav-key-"));
    try {
      const key = randomBytes(32);
      process.env.DATA_BACKUP_ENCRYPTION_KEY = key.toString("base64");
      assert.deepEqual(await backupKey(root), key);
      process.env.DATA_BACKUP_ENCRYPTION_KEY = "invalid";
      await assert.rejects(backupKey(root), /base64/);
      delete process.env.DATA_BACKUP_ENCRYPTION_KEY;
      await mkdir(join(root, "other"));
      await symlink(join(root, "other"), join(root, ".core"));
      await assert.rejects(backupKey(root), /symlink/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a damaged key instead of replacing a saved encryption identity", async () => {
    delete process.env.DATA_BACKUP_ENCRYPTION_KEY;
    const root = await mkdtemp(join(tmpdir(), "pp-dav-key-"));
    try {
      await backupKey(root);
      await writeFile(join(root, ".core", "backup.key"), "damaged");
      await assert.rejects(backupKey(root), /invalid/);
      assert.equal((await stat(join(root, ".core", "backup.key"))).size, 7);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("WebDAV network boundary", () => {
  it("permits global addresses and rejects private, mapped, metadata and reserved destinations", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(publicAddress(address), true, address);
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.2.3", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1", "2002:7f00:1::"]) assert.equal(publicAddress(address), false, address);
  });

  it("normalizes collection URLs but does not accept credentials, arbitrary protocols or non-allowlisted HTTP", () => {
    delete process.env.DATA_BACKUP_ALLOWED_ORIGINS;
    assert.equal(normalizeEndpoint("https://cloud.example/dav"), "https://cloud.example/dav/");
    for (const endpoint of ["file:///tmp/secret", "https://user:secret@cloud.example/dav", "https://cloud.example/dav?a=1", "https://cloud.example/dav#x", "http://localhost/dav", "https://cloud.example/dav/%2fsecret"]) assert.throws(() => normalizeEndpoint(endpoint));
    process.env.DATA_BACKUP_ALLOWED_ORIGINS = "http://127.0.0.1:1234";
    assert.equal(normalizeEndpoint("http://127.0.0.1:1234/dav"), "http://127.0.0.1:1234/dav/");
    assert.throws(() => normalizeEndpoint("http://127.0.0.1:1235/dav"));
  });

  it("blocks resolved private HTTPS addresses before attempting the connection", async () => {
    delete process.env.DATA_BACKUP_ALLOWED_ORIGINS;
    await assert.rejects(davRequest({ endpoint: "https://127.0.0.1:1/dav/", username: "u", password: "secret", method: "PROPFIND" }), /Private WebDAV/);
  });

  it("round-trips bytes through an authenticated local DAV server with non-overwriting PUT", async () => {
    const objects = new Map<string, Buffer>();
    let puts = 0;
    const server = http.createServer(async (req, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from("user:secret").toString("base64")}`) { res.writeHead(401).end("private diagnostic"); return; }
      if (req.method === "PROPFIND") { assert.equal(req.headers.depth, "0"); res.writeHead(207).end('<d:multistatus xmlns:d="DAV:"/>'); return; }
      if (req.method === "PUT") {
        assert.equal(req.headers["if-none-match"], "*");
        if (objects.has(req.url!)) { res.writeHead(412).end(); return; }
        const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        objects.set(req.url!, Buffer.concat(chunks)); puts++; res.writeHead(201).end(); return;
      }
      const data = objects.get(req.url!); res.writeHead(data ? 200 : 404).end(data);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      process.env.DATA_BACKUP_ALLOWED_ORIGINS = origin;
      const base = { endpoint: `${origin}/dav/`, username: "user", password: "secret" };
      await davRequest({ ...base, method: "PROPFIND" });
      const filename = `pp-${randomUUID()}-own-${randomUUID()}.json`;
      const bytes = Buffer.from('{"content":"测试"}');
      await davRequest({ ...base, method: "PUT", filename, body: bytes });
      assert.deepEqual(await davRequest({ ...base, method: "GET", filename }), bytes);
      await assert.rejects(davRequest({ ...base, method: "PUT", filename, body: Buffer.from("overwrite") }), /412/);
      assert.equal(puts, 1);
      await assert.rejects(davRequest({ ...base, method: "GET", filename: "../secrets" }), /filename/);
      await assert.rejects(davRequest({ ...base, password: "wrong", method: "PROPFIND" }), (error: Error) => error.message.includes("401") && !error.message.includes("private diagnostic"));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("does not follow credential-bearing redirects and bounds hanging/oversized responses", async () => {
    let redirected = 0;
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/redirect/")) { res.writeHead(302, { location: "/stolen/" }).end(); return; }
      if (req.url?.startsWith("/stolen/")) { redirected++; res.writeHead(200).end(); return; }
      if (req.url?.startsWith("/oversized/")) { res.writeHead(200).end(Buffer.alloc(DAV_MAX_BYTES + 1)); return; }
      // /hang deliberately never responds; the client deadline must abort it.
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      process.env.DATA_BACKUP_ALLOWED_ORIGINS = origin;
      const base = { username: "u", password: "secret", method: "GET" as const };
      await assert.rejects(davRequest({ ...base, endpoint: `${origin}/redirect/` }), /302/);
      assert.equal(redirected, 0);
      await assert.rejects(davRequest({ ...base, endpoint: `${origin}/hang/`, timeoutMs: 30 }), /timed out/);
      await assert.rejects(davRequest({ ...base, endpoint: `${origin}/oversized/` }), /allowed size/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
