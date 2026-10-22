import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assetsApp from "../../src/apps/assets/index.js";
import type { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { Platform } from "../../src/core/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { multipartBody } from "../helpers/multipart.js";
import { buildFixturePlatform, createTestUser, ensureTestAdmin, loginCookie } from "../helpers/platform.js";

const migrationsDir = resolve(import.meta.dirname, "../../../apps/assets/migrations");
const migrations = readdirSync(migrationsDir).sort().map((file) => readFileSync(join(migrationsDir, file), "utf8"));
let db: Database;
let platform: Platform;
let cleanup: (() => void) | undefined;
let cookie: string;
let itemId: string;

before(async () => {
  db = await resetDatabase();
  await ensureTestAdmin(db);
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "assets", migrations }],
    // This suite exercises the real download route, without unrelated timers.
    backendModules: { assets: { ...assetsApp, registerJobs: async () => [] } },
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [
    { scope: "assets", schema: "assets", dir: join(fixture.root, "apps/assets/migrations") },
  ] });
  cookie = await loginCookie(platform);
  const created = await platform.app.inject({ method: "POST", url: "/api/apps/assets/items", headers: { cookie }, payload: { name: "Download safety" } });
  assert.equal(created.statusCode, 201);
  itemId = created.json().id;
});

after(async () => {
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

async function upload(filename: string, contentType: string, data: Buffer) {
  const body = multipartBody([{ name: "file", filename, contentType, data }]);
  const response = await platform.app.inject({ method: "POST", url: `/api/apps/assets/items/${itemId}/attachments`, headers: { cookie, ...body.headers }, payload: body.payload });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { id: string; contentType: string };
}

function download(id: string, ownerCookie = cookie) {
  return platform.app.inject({ method: "GET", url: `/api/apps/assets/items/${itemId}/attachments/${id}`, headers: { cookie: ownerCookie } });
}

describe("attachment responses isolate untrusted file content", () => {
  for (const contentType of ["text/html", "image/svg+xml", "image/png"]) {
    it(`downloads ${contentType} as inert bytes regardless of the claimed MIME`, async () => {
      const bytes = Buffer.from("<html><script>window.downloadContentExecuted = true</script></html>");
      const attachment = await upload("untrusted.html", contentType, bytes);
      assert.equal(attachment.contentType, contentType, "metadata keeps the original MIME for display");
      const response = await download(attachment.id);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "application/octet-stream");
      assert.match(String(response.headers["content-disposition"]), /^attachment;/);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      const csp = String(response.headers["content-security-policy"]);
      assert.match(csp, /(?:^|;)\s*default-src 'none'(?:;|$)/);
      assert.match(csp, /(?:^|;)\s*sandbox(?:;|$)/);
      assert.deepEqual(response.rawPayload, bytes);
    });
  }

  for (const entry of [
    { name: "报告😀.html", expected: "报告😀.html" },
    { name: 'bad"\\name\r\nX-Injected: yes\u0001.html', expected: "bad__name__X-Injected: yes_.html" },
    { name: "a".repeat(299) + "\ud83d", expected: "a".repeat(299) + "�" },
  ]) {
    it(`encodes a safe filename for ${entry.name.startsWith("a".repeat(20)) ? "a truncated surrogate" : entry.expected}`, async () => {
      const attachment = await upload("seed.txt", "text/plain", Buffer.from("filename payload"));
      // Exercise legacy metadata too; PostgreSQL normalizes lone surrogates to U+FFFD.
      await db.context().query("UPDATE assets.attachments SET filename = $2 WHERE id = $1", [attachment.id, entry.name]);
      const response = await download(attachment.id);
      assert.equal(response.statusCode, 200, response.body);
      const disposition = String(response.headers["content-disposition"]);
      assert.match(disposition, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
      const fallback = disposition.match(/filename="([^"]+)";/)?.[1];
      assert.ok(fallback && !/[\\\r\n\x00-\x1f\x7f]/.test(fallback));
      const encoded = disposition.split("filename*=UTF-8''")[1]!;
      assert.equal(decodeURIComponent(encoded), entry.expected);
      assert.equal(response.headers["x-injected"], undefined);
    });
  }

  it("retains owner isolation and authentication for downloads", async () => {
    const attachment = await upload("private.txt", "text/plain", Buffer.from("private"));
    const other = await createTestUser(db, "download-other");
    const otherCookie = await loginCookie(platform, other.username, "test-password-download-other");
    assert.equal((await download(attachment.id, otherCookie)).statusCode, 404);
    assert.equal((await download(attachment.id, "")).statusCode, 401);
    assert.equal((await download(attachment.id)).body, "private");
  });
});
