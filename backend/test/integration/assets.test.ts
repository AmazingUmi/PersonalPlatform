import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import assetsApp from "../../src/apps/assets/index.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { runMigrations } from "../../src/core/database/migrate.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const assetsMigrations = [
  readFileSync(join(repoRoot, "apps/assets/migrations/20260101000001-init.sql"), "utf8"),
];

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;

function attachmentPath(itemId: string, attachmentId: string): string {
  return join(root, "storage", "apps", "assets", "attachments", itemId, attachmentId);
}

async function json<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object): Promise<{ status: number; body: T }> {
  const response = await platform.app.inject({ method, url, payload });
  const raw = response.body;
  return { status: response.statusCode, body: (raw ? JSON.parse(raw) : null) as T };
}

before(async () => {
  db = await resetDatabase();
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "assets", migrations: assetsMigrations }],
    backendModules: { assets: assetsApp },
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "assets", schema: "assets", dir: join(root, "apps", "assets", "migrations") }],
  });
});

after(async () => {
  await platform.stop();
  cleanup();
  await db.close();
});

describe("items PATCH nullable semantics (FP-2B.1)", () => {
  let itemId: string;
  let categoryId: string;

  it("creates a category and a fully populated item", async () => {
    const category = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Books" });
    assert.equal(category.status, 201);
    categoryId = category.body.id;

    const item = await json<{ id: string; description: string | null; category_id: string | null; acquired_at: string | null }>(
      "POST",
      "/api/apps/assets/items",
      { name: "SICP", description: "Classic", quantity: 2, acquiredAt: "2026-01-15", categoryId },
    );
    assert.equal(item.status, 201);
    itemId = item.body.id;
    assert.equal(item.body.description, "Classic");
    assert.equal(item.body.category_id, categoryId);
  });

  it("missing properties leave fields unchanged", async () => {
    const { status, body } = await json<{ name: string; description: string | null }>(
      "PATCH",
      `/api/apps/assets/items/${itemId}`,
      { name: "SICP 2nd ed" },
    );
    assert.equal(status, 200);
    assert.equal(body.name, "SICP 2nd ed");
    assert.equal(body.description, "Classic", "absent description stays unchanged");
  });

  it("explicit null clears nullable fields", async () => {
    const { status, body } = await json<{ description: string | null; category_id: string | null; acquired_at: string | null }>(
      "PATCH",
      `/api/apps/assets/items/${itemId}`,
      { description: null, categoryId: null, acquiredAt: null },
    );
    assert.equal(status, 200);
    assert.equal(body.description, null, "description cleared");
    assert.equal(body.category_id, null, "category cleared");
    assert.equal(body.acquired_at, null, "acquired date cleared");
  });

  it("re-assigns values after clearing", async () => {
    const { body } = await json<{ description: string | null; category_id: string | null; acquired_at: string | null }>(
      "PATCH",
      `/api/apps/assets/items/${itemId}`,
      { description: "Back", categoryId, acquiredAt: "2026-02-20" },
    );
    assert.equal(body.description, "Back");
    assert.equal(body.category_id, categoryId);
    assert.ok(String(body.acquired_at).startsWith("2026-02-20"));
  });

  it("rejects unknown category references with a clean error", async () => {
    const { status, body } = await json<{ error: { code: string } }>(
      "PATCH",
      `/api/apps/assets/items/${itemId}`,
      { categoryId: "11111111-1111-1111-1111-111111111111" },
    );
    assert.equal(status, 422);
    assert.equal(body.error.code, "invalid_reference");
  });

  it("returns 404 for unknown items", async () => {
    const { status } = await json("PATCH", "/api/apps/assets/items/22222222-2222-2222-2222-222222222222", { name: "x" });
    assert.equal(status, 404);
  });
});

describe("attachment lifecycle and orphan cleanup (FP-2B.2)", () => {
  let itemId: string;
  let attachmentId: string;

  before(async () => {
    const item = await json<{ id: string }>("POST", "/api/apps/assets/items", { name: "Cleanup target" });
    itemId = item.body.id;
  });

  it("uploads an attachment with a physical storage object", async () => {
    const upload = await json<{ id: string }>("POST", `/api/apps/assets/items/${itemId}/attachments`, {
      filename: "receipt.txt",
      contentType: "text/plain",
      dataBase64: Buffer.from("receipt-data").toString("base64"),
    });
    assert.equal(upload.status, 201);
    attachmentId = upload.body.id;
    assert.ok(existsSync(attachmentPath(itemId, attachmentId)), "physical file exists");
  });

  it("deleting the attachment removes metadata and storage object", async () => {
    const { status } = await json("DELETE", `/api/apps/assets/items/${itemId}/attachments/${attachmentId}`);
    assert.equal(status, 204);

    const meta = await db
      .context()
      .query("SELECT id FROM assets.attachments WHERE id = $1", [attachmentId]);
    assert.equal(meta.rows.length, 0, "metadata gone");
    assert.ok(!existsSync(attachmentPath(itemId, attachmentId)), "physical file gone");
  });

  it("deleting unknown attachments returns 404", async () => {
    const { status } = await json("DELETE", `/api/apps/assets/items/${itemId}/attachments/33333333-3333-3333-3333-333333333333`);
    assert.equal(status, 404);
  });

  it("deleting the item removes row, attachment metadata and storage objects", async () => {
    const upload1 = await json<{ id: string }>("POST", `/api/apps/assets/items/${itemId}/attachments`, {
      filename: "a.txt",
      dataBase64: Buffer.from("a").toString("base64"),
    });
    const upload2 = await json<{ id: string }>("POST", `/api/apps/assets/items/${itemId}/attachments`, {
      filename: "b.txt",
      dataBase64: Buffer.from("b").toString("base64"),
    });
    assert.ok(existsSync(attachmentPath(itemId, upload1.body.id)));
    assert.ok(existsSync(attachmentPath(itemId, upload2.body.id)));

    const { status } = await json("DELETE", `/api/apps/assets/items/${itemId}`);
    assert.equal(status, 204);

    const items = await db.context().query("SELECT id FROM assets.items WHERE id = $1", [itemId]);
    assert.equal(items.rows.length, 0, "item row gone");
    const attachments = await db.context().query(
      "SELECT id FROM assets.attachments WHERE item_id = $1",
      [itemId],
    );
    assert.equal(attachments.rows.length, 0, "attachment metadata gone");
    assert.ok(!existsSync(attachmentPath(itemId, upload1.body.id)), "first file gone");
    assert.ok(!existsSync(attachmentPath(itemId, upload2.body.id)), "second file gone");
  });

  it("deleting an unknown item returns 404 without side effects", async () => {
    const { status } = await json("DELETE", "/api/apps/assets/items/44444444-4444-4444-4444-444444444444");
    assert.equal(status, 404);
  });
});
