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
  readFileSync(join(repoRoot, "apps/assets/migrations/20260829000002-target-location.sql"), "utf8"),
  readFileSync(join(repoRoot, "apps/assets/migrations/20260829000003-acquired-at-index.sql"), "utf8"),
  readFileSync(join(repoRoot, "apps/assets/migrations/20260829000004-seed-default-categories.sql"), "utf8"),
  readFileSync(join(repoRoot, "apps/assets/migrations/20260829000005-category-color.sql"), "utf8"),
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

describe("items query API (FP-3.4)", () => {
  let categoryId: string;
  const created: Array<{ id: string; name: string; target_location: string | null; acquired_at: string | null }> = [];

  before(async () => {
    const category = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Query Cat" });
    categoryId = category.body.id;

    const specs = [
      { name: "Q-Alpha", quantity: 5, targetLocation: "shelf-a", acquiredAt: "2026-01-01" },
      { name: "Q-Beta", quantity: 1, targetLocation: "shelf-b", acquiredAt: "2026-03-01", categoryId },
      { name: "Q-Gamma", quantity: 3 },
    ];
    for (const spec of specs) {
      const response = await json<{ id: string; name: string; target_location: string | null; acquired_at: string | null }>(
        "POST",
        "/api/apps/assets/items",
        spec,
      );
      assert.equal(response.status, 201, `fixture ${spec.name} created`);
      created.push(response.body);
    }
  });

  // All fixtures here are prefixed "Q-" so assertions stay isolated from
  // items created by the other suites sharing this database.
  async function names(query: string): Promise<string[]> {
    const extra = query.replace(/^\?/, "");
    const suffix = extra ? `&${extra}` : "";
    const { status, body } = await json<{ items: Array<{ name: string }> }>(
      "GET",
      `/api/apps/assets/items?q=Q-${suffix}`,
    );
    assert.equal(status, 200);
    return body.items.map((item) => item.name);
  }

  it("filters by target location substring", async () => {
    const result = await names("?targetLocation=shelf");
    assert.deepEqual(result.sort(), ["Q-Alpha", "Q-Beta"]);
  });

  it("filters by acquired date range", async () => {
    const inRange = await names("?acquiredAfter=2026-01-15&acquiredBefore=2026-06-01");
    assert.deepEqual(inRange, ["Q-Beta"]);
  });

  it("combines q with category filter server-side", async () => {
    const { status, body } = await json<{ items: Array<{ name: string }> }>(
      "GET",
      `/api/apps/assets/items?q=Q-Beta&categoryId=${categoryId}`,
    );
    assert.equal(status, 200);
    assert.deepEqual(
      body.items.map((item) => item.name),
      ["Q-Beta"],
    );
  });

  it("sorts by name ascending and descending via the allowlist", async () => {
    assert.deepEqual(await names("?sortBy=name&order=asc"), [
      "Q-Alpha",
      "Q-Beta",
      "Q-Gamma",
    ]);
    assert.deepEqual(await names("?sortBy=name&order=desc"), [
      "Q-Gamma",
      "Q-Beta",
      "Q-Alpha",
    ]);
  });

  it("sorts by quantity with a deterministic fallback", async () => {
    assert.deepEqual(await names("?sortBy=quantity&order=asc"), [
      "Q-Beta",
      "Q-Gamma",
      "Q-Alpha",
    ]);
  });

  it("places null acquired dates last regardless of direction", async () => {
    const asc = await json<{ items: Array<{ name: string; acquired_at: string | null }> }>(
      "GET",
      "/api/apps/assets/items?q=Q-&sortBy=acquiredAt&order=asc",
    );
    assert.equal(asc.body.items.find((i) => i.name === "Q-Gamma")!.acquired_at, null);
    assert.equal(asc.body.items.at(-1)!.name, "Q-Gamma");

    const desc = await json<{ items: Array<{ name: string }> }>(
      "GET",
      "/api/apps/assets/items?q=Q-&sortBy=acquiredAt&order=desc",
    );
    assert.equal(desc.body.items.at(-1)!.name, "Q-Gamma");
  });

  it("rejects unknown sort fields and orders", async () => {
    const badSort = await json("GET", "/api/apps/assets/items?sortBy=name;DROP TABLE items");
    assert.equal(badSort.status, 400);
    const badOrder = await json("GET", "/api/apps/assets/items?order=sideways");
    assert.equal(badOrder.status, 400);
  });

  it("filters by created date window", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const none = await names(`?createdAfter=${encodeURIComponent(future)}`);
    assert.deepEqual(none, []);
    const past = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
    const all = await names(`?createdAfter=${encodeURIComponent(past)}`);
    assert.equal(all.length, created.length);
  });

  it("supports target location on create and clear via PATCH", async () => {
    const { body } = await json<{ target_location: string | null }>(
      "PATCH",
      `/api/apps/assets/items/${created[0]!.id}`,
      { targetLocation: null },
    );
    assert.equal(body.target_location, null);
  });
});

describe("category CRUD (FP-3.2)", () => {
  it("renames a category", async () => {
    const created = await json<{ id: string; name: string }>("POST", "/api/apps/assets/categories", {
      name: "Rename Me",
    });
    const renamed = await json<{ id: string; name: string }>(
      "PATCH",
      `/api/apps/assets/categories/${created.body.id}`,
      { name: "Renamed" },
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Renamed");
  });

  it("returns a clean error for duplicate names", async () => {
    await json("POST", "/api/apps/assets/categories", { name: "Dup" });
    const duplicate = await json<{ error: { code: string } }>("POST", "/api/apps/assets/categories", {
      name: "Dup",
    });
    assert.equal(duplicate.status, 422);
    assert.equal(duplicate.body.error.code, "category_name_taken");

    const renameDup = await json<{ error: { code: string } }>(
      "PATCH",
      "/api/apps/assets/categories/66666666-6666-6666-6666-666666666666",
      { name: "Dup" },
    );
    assert.equal(renameDup.status, 404, "rename on unknown category still 404s");
  });

  it("rename to an existing name returns category_name_taken", async () => {
    const a = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Solo-A" });
    await json("POST", "/api/apps/assets/categories", { name: "Solo-B" });
    const clash = await json<{ error: { code: string } }>(
      "PATCH",
      `/api/apps/assets/categories/${a.body.id}`,
      { name: "Solo-B" },
    );
    assert.equal(clash.status, 422);
    assert.equal(clash.body.error.code, "category_name_taken");
  });

  it("deleting a category nulls item categories (ON DELETE SET NULL)", async () => {
    const category = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Doomed" });
    const item = await json<{ id: string; category_id: string | null }>("POST", "/api/apps/assets/items", {
      name: "Attached Item",
      categoryId: category.body.id,
    });
    assert.equal(item.body.category_id, category.body.id);

    const removed = await json("DELETE", `/api/apps/assets/categories/${category.body.id}`);
    assert.equal(removed.status, 204);

    const after = await json<{ category_id: string | null }>("GET", `/api/apps/assets/items/${item.body.id}`);
    assert.equal(after.body.category_id, null, "item survives with a null category");

    const unknown = await json("DELETE", "/api/apps/assets/categories/55555555-5555-5555-5555-555555555555");
    assert.equal(unknown.status, 404);
  });
});

describe("preset categories and category-name search", () => {
  it("ships preset categories out of the box", async () => {
    const { status, body } = await json<{ items: Array<{ name: string }> }>("GET", "/api/apps/assets/categories");
    assert.equal(status, 200);
    const names = body.items.map((category) => category.name);
    for (const expected of ["电子设备", "工具", "服饰配件", "书籍资料", "文件证件", "其他"]) {
      assert.ok(names.includes(expected), `preset category "${expected}" seeded`);
    }
  });

  it("search q matches the assigned category name", async () => {
    const categories = await json<{ items: Array<{ id: string; name: string }> }>("GET", "/api/apps/assets/categories");
    const electronics = categories.body.items.find((category) => category.name === "电子设备")!;
    await json("POST", "/api/apps/assets/items", { name: "Noise-Cancelling Headphones", categoryId: electronics.id });

    const byCategoryName = await json<{ items: Array<{ name: string }> }>(
      "GET",
      `/api/apps/assets/items?q=${encodeURIComponent("电子")}`,
    );
    assert.ok(
      byCategoryName.body.items.some((item) => item.name === "Noise-Cancelling Headphones"),
      "q matches the category name",
    );

    // The explicit category filter still works server-side.
    const byFilter = await json<{ items: Array<{ name: string }> }>(
      "GET",
      `/api/apps/assets/items?categoryId=${electronics.id}`,
    );
    assert.deepEqual(byFilter.body.items.map((item) => item.name), ["Noise-Cancelling Headphones"]);
  });

  it("acquired date stays optional while intake time is automatic", async () => {
    const created = await json<{ id: string; acquired_at: string | null; created_at: string }>(
      "POST",
      "/api/apps/assets/items",
      { name: "No-Acquire Item" },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.acquired_at, null, "acquired time optional");
    assert.ok(created.body.created_at, "intake time auto-populated");

    const listed = await json<{ items: Array<{ name: string }> }>(
      "GET",
      "/api/apps/assets/items?sortBy=createdAt&order=desc",
    );
    assert.equal(listed.body.items[0]!.name, "No-Acquire Item");
  });
});

describe("category color management", () => {
  it("sets a color on create and updates it via PATCH", async () => {
    const created = await json<{ id: string; color: string | null }>("POST", "/api/apps/assets/categories", {
      name: "Colored",
      color: "mint",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.color, "mint");

    const renamed = await json<{ name: string; color: string | null }>(
      "PATCH",
      `/api/apps/assets/categories/${created.body.id}`,
      { name: "Colored Renamed" },
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Colored Renamed");
    assert.equal(renamed.body.color, "mint", "absent color stays unchanged");

    const recolored = await json<{ color: string | null }>(
      "PATCH",
      `/api/apps/assets/categories/${created.body.id}`,
      { color: "coral" },
    );
    assert.equal(recolored.body.color, "coral");
  });

  it("clears the color with explicit null and rejects unknown values", async () => {
    const created = await json<{ id: string }>("POST", "/api/apps/assets/categories", {
      name: "Clearable Color",
      color: "violet",
    });
    const cleared = await json<{ color: string | null }>(
      "PATCH",
      `/api/apps/assets/categories/${created.body.id}`,
      { color: null },
    );
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.color, null);

    const invalid = await json("PATCH", `/api/apps/assets/categories/${created.body.id}`, { color: "hot-pink" });
    assert.equal(invalid.status, 400);

    const badCreate = await json("POST", "/api/apps/assets/categories", { name: "Bad Color", color: "neon" });
    assert.equal(badCreate.status, 400);
  });

  it("lists categories with their colors", async () => {
    const { body } = await json<{ items: Array<{ name: string; color: string | null }> }>(
      "GET",
      "/api/apps/assets/categories",
    );
    const colored = body.items.find((category) => category.name === "Colored Renamed");
    assert.equal(colored!.color, "coral");
    assert.equal(body.items.every((category) => "color" in category), true);
  });
});
