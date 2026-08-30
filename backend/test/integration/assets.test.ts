import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import assetsApp from "../../src/apps/assets/index.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { multipartBody } from "../helpers/multipart.js";
import { runMigrations } from "../../src/core/database/migrate.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const assetsMigrationDir = join(repoRoot, "apps", "assets", "migrations");
// Full directory read (assets-consistency precedent): new migrations join the
// suite automatically instead of relying on a hand-maintained file list.
const assetsMigrations = readdirSync(assetsMigrationDir)
  .sort()
  .map((file) => readFileSync(join(assetsMigrationDir, file), "utf8"));

/** Embedded category in an item view (name-ordered, P7A2 §2.2). */
interface ItemCategoryView {
  id: string;
  name: string;
  color: string | null;
}

/** camelCase item view (P7A2 §2.1): responses no longer leak snake_case. */
interface ItemView {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  acquiredAt: string | null;
  targetLocation: string | null;
  createdAt: string;
  updatedAt: string;
  categories: ItemCategoryView[];
}

/** GET /items response (P7A2 §2.4): items plus faceted counts. */
interface ItemsListBody {
  items: ItemView[];
  counts: { all: number; categories: Record<string, number> };
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface ItemCreatedPayload {
  id: string;
  name: string;
  categoryIds: string[];
}

/** Captured envelopes for the assets item-created events (v1 and v2). */
const itemCreatedEvents: Array<{ type: string; source: string; payload: ItemCreatedPayload }> = [];

/** Fixture app observing the item-created events (tasks-event spy in apps.test.ts precedent). */
const eventSpyApp: BackendAppModule = {
  id: "assets_event_spy",
  async registerApi() {},
  async registerEvents(ctx) {
    return [
      ctx.events.subscribe("assets.item.created.v1", (event) => {
        itemCreatedEvents.push({ type: event.type, source: event.source, payload: event.payload as ItemCreatedPayload });
      }),
      ctx.events.subscribe("assets.item.created.v2", (event) => {
        itemCreatedEvents.push({ type: event.type, source: event.source, payload: event.payload as ItemCreatedPayload });
      }),
    ];
  },
};

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
    manifests: [
      { id: "assets", migrations: assetsMigrations },
      { id: "assets_event_spy" },
    ],
    backendModules: { assets: assetsApp, assets_event_spy: eventSpyApp },
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
  // Setup may have failed partway; teardown must never turn that into a
  // secondary "cannot read properties of undefined" error.
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

describe("items PATCH nullable semantics (FP-2B.1)", () => {
  let itemId: string;
  let categoryId: string;

  it("creates a category and a fully populated item", async () => {
    const category = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Books" });
    assert.equal(category.status, 201);
    categoryId = category.body.id;

    const item = await json<ItemView>(
      "POST",
      "/api/apps/assets/items",
      { name: "SICP", description: "Classic", quantity: 2, acquiredAt: "2026-01-15", categoryIds: [categoryId] },
    );
    assert.equal(item.status, 201);
    itemId = item.body.id;
    assert.equal(item.body.description, "Classic");
    assert.deepEqual(item.body.categories, [{ id: categoryId, name: "Books", color: null }]);
  });

  it("missing properties leave fields unchanged", async () => {
    const { status, body } = await json<ItemView>(
      "PATCH",
      `/api/apps/assets/items/${itemId}`,
      { name: "SICP 2nd ed" },
    );
    assert.equal(status, 200);
    assert.equal(body.name, "SICP 2nd ed");
    assert.equal(body.description, "Classic", "absent description stays unchanged");
    assert.deepEqual(body.categories.map((category) => category.id), [categoryId], "absent categoryIds keeps the set");
  });

  it("explicit null clears nullable fields", async () => {
    const { status, body } = await json<ItemView>(
      "PATCH",
      `/api/apps/assets/items/${itemId}`,
      { description: null, categoryIds: [], acquiredAt: null },
    );
    assert.equal(status, 200);
    assert.equal(body.description, null, "description cleared");
    assert.deepEqual(body.categories, [], "category set cleared via the empty list");
    assert.equal(body.acquiredAt, null, "acquired date cleared");
  });

  it("re-assigns values after clearing", async () => {
    const { body } = await json<ItemView>(
      "PATCH",
      `/api/apps/assets/items/${itemId}`,
      { description: "Back", categoryIds: [categoryId], acquiredAt: "2026-02-20" },
    );
    assert.equal(body.description, "Back");
    assert.deepEqual(body.categories.map((category) => category.id), [categoryId]);
    assert.ok(String(body.acquiredAt).startsWith("2026-02-20"));
  });

  it("rejects unknown category references with a clean error", async () => {
    const { status, body } = await json<ErrorBody>(
      "PATCH",
      `/api/apps/assets/items/${itemId}`,
      { categoryIds: ["11111111-1111-1111-1111-111111111111"] },
    );
    assert.equal(status, 422);
    assert.equal(body.error.code, "category_not_found");
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
    const upload = await platform.app.inject({
      method: "POST",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      ...multipartBody([{ name: "file", filename: "receipt.txt", contentType: "text/plain", data: "receipt-data" }]),
    });
    assert.equal(upload.statusCode, 201);
    attachmentId = upload.json().id;
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
    const upload1 = await platform.app.inject({
      method: "POST",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      ...multipartBody([{ name: "file", filename: "a.txt", data: "a" }]),
    });
    const upload2 = await platform.app.inject({
      method: "POST",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      ...multipartBody([{ name: "file", filename: "b.txt", data: "b" }]),
    });
    assert.ok(existsSync(attachmentPath(itemId, upload1.json().id)));
    assert.ok(existsSync(attachmentPath(itemId, upload2.json().id)));

    const { status } = await json("DELETE", `/api/apps/assets/items/${itemId}`);
    assert.equal(status, 204);

    const items = await db.context().query("SELECT id FROM assets.items WHERE id = $1", [itemId]);
    assert.equal(items.rows.length, 0, "item row gone");
    const attachments = await db.context().query(
      "SELECT id FROM assets.attachments WHERE item_id = $1",
      [itemId],
    );
    assert.equal(attachments.rows.length, 0, "attachment metadata gone");
    assert.ok(!existsSync(attachmentPath(itemId, upload1.json().id)), "first file gone");
    assert.ok(!existsSync(attachmentPath(itemId, upload2.json().id)), "second file gone");
  });

  it("deleting an unknown item returns 404 without side effects", async () => {
    const { status } = await json("DELETE", "/api/apps/assets/items/44444444-4444-4444-4444-444444444444");
    assert.equal(status, 404);
  });
});

describe("items query API (FP-3.4)", () => {
  let categoryId: string;
  const created: Array<{ id: string; name: string; targetLocation: string | null; acquiredAt: string | null }> = [];

  before(async () => {
    const category = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Query Cat" });
    categoryId = category.body.id;

    const specs = [
      { name: "Q-Alpha", quantity: 5, targetLocation: "shelf-a", acquiredAt: "2026-01-01" },
      { name: "Q-Beta", quantity: 1, targetLocation: "shelf-b", acquiredAt: "2026-03-01", categoryIds: [categoryId] },
      { name: "Q-Gamma", quantity: 3 },
    ];
    for (const spec of specs) {
      const response = await json<ItemView>(
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
    const { status, body } = await json<ItemsListBody>(
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
    const { status, body } = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?q=Q-Beta&categories=${categoryId}`,
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
    const asc = await json<ItemsListBody>(
      "GET",
      "/api/apps/assets/items?q=Q-&sortBy=acquiredAt&order=asc",
    );
    assert.equal(asc.body.items.find((i) => i.name === "Q-Gamma")!.acquiredAt, null);
    assert.equal(asc.body.items.at(-1)!.name, "Q-Gamma");

    const desc = await json<ItemsListBody>(
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
    const { body } = await json<ItemView>(
      "PATCH",
      `/api/apps/assets/items/${created[0]!.id}`,
      { targetLocation: null },
    );
    assert.equal(body.targetLocation, null);
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
    const duplicate = await json<ErrorBody>("POST", "/api/apps/assets/categories", {
      name: "Dup",
    });
    assert.equal(duplicate.status, 422);
    assert.equal(duplicate.body.error.code, "category_name_taken");

    const renameDup = await json<ErrorBody>(
      "PATCH",
      "/api/apps/assets/categories/66666666-6666-6666-6666-666666666666",
      { name: "Dup" },
    );
    assert.equal(renameDup.status, 404, "rename on unknown category still 404s");
  });

  it("rename to an existing name returns category_name_taken", async () => {
    const a = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Solo-A" });
    await json("POST", "/api/apps/assets/categories", { name: "Solo-B" });
    const clash = await json<ErrorBody>(
      "PATCH",
      `/api/apps/assets/categories/${a.body.id}`,
      { name: "Solo-B" },
    );
    assert.equal(clash.status, 422);
    assert.equal(clash.body.error.code, "category_name_taken");
  });

  it("deleting a category unlinks its items but keeps them and their other categories", async () => {
    const doomed = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Doomed" });
    const keeper = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Keeper" });
    const item = await json<ItemView>("POST", "/api/apps/assets/items", {
      name: "Attached Item",
      categoryIds: [doomed.body.id, keeper.body.id],
    });
    assert.deepEqual(
      item.body.categories.map((category) => category.id),
      [doomed.body.id, keeper.body.id],
    );

    const removed = await json("DELETE", `/api/apps/assets/categories/${doomed.body.id}`);
    assert.equal(removed.status, 204);

    const after = await json<ItemView>("GET", `/api/apps/assets/items/${item.body.id}`);
    assert.deepEqual(
      after.body.categories.map((category) => category.id),
      [keeper.body.id],
      "the item survives with its remaining categories",
    );

    const relations = await db
      .context()
      .query("SELECT item_id FROM assets.item_categories WHERE category_id = $1", [doomed.body.id]);
    assert.equal(relations.rows.length, 0, "the relation rows cascade away with the category");

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
    await json("POST", "/api/apps/assets/items", { name: "Noise-Cancelling Headphones", categoryIds: [electronics.id] });

    const byCategoryName = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?q=${encodeURIComponent("电子")}`,
    );
    assert.ok(
      byCategoryName.body.items.some((item) => item.name === "Noise-Cancelling Headphones"),
      "q matches the category name",
    );

    // The explicit category filter still works server-side.
    const byFilter = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?categories=${electronics.id}`,
    );
    assert.deepEqual(byFilter.body.items.map((item) => item.name), ["Noise-Cancelling Headphones"]);
  });

  it("acquired date stays optional while intake time is automatic", async () => {
    const created = await json<ItemView>(
      "POST",
      "/api/apps/assets/items",
      { name: "No-Acquire Item" },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.acquiredAt, null, "acquired time optional");
    assert.ok(created.body.createdAt, "intake time auto-populated");

    const listed = await json<ItemsListBody>(
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

// ---------------------------------------------------------------------------
// P7A2 §6.2: the item <-> category relation matrix end to end.
// ---------------------------------------------------------------------------

describe("item categories API matrix (P7A2)", () => {
  let catA: string;
  let catB: string;
  let catC: string;
  let catEmpty: string;

  let soloId: string;
  let dualId: string;

  before(async () => {
    const makeCategory = async (name: string): Promise<string> => {
      const response = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name });
      assert.equal(response.status, 201, `fixture category "${name}" created`);
      return response.body.id;
    };
    catA = await makeCategory("Matrix Alpha");
    catB = await makeCategory("Matrix Beta");
    catC = await makeCategory("Matrix Gamma");
    catEmpty = await makeCategory("Matrix Delta");
  });

  it("creates items with zero, one and many categories, embedded by name order", async () => {
    const plain = await json<ItemView>("POST", "/api/apps/assets/items", { name: "Matrix Plain" });
    assert.equal(plain.status, 201);
    assert.deepEqual(plain.body.categories, [], "no categoryIds means uncategorized");

    const solo = await json<ItemView>("POST", "/api/apps/assets/items", {
      name: "Matrix Solo",
      categoryIds: [catA],
    });
    assert.equal(solo.status, 201);
    assert.deepEqual(solo.body.categories.map((category) => category.id), [catA]);
    soloId = solo.body.id;

    // Request order [B, A] on purpose: the embed follows name order.
    const dual = await json<ItemView>("POST", "/api/apps/assets/items", {
      name: "Matrix Dual",
      categoryIds: [catB, catA],
    });
    assert.equal(dual.status, 201);
    assert.deepEqual(dual.body.categories.map((category) => category.id), [catA, catB], "categories embed in name order");
    dualId = dual.body.id;

    const fetched = await json<ItemView>("GET", `/api/apps/assets/items/${dualId}`);
    assert.deepEqual(
      fetched.body.categories.map((category) => category.name),
      ["Matrix Alpha", "Matrix Beta"],
    );

    const list = await json<ItemsListBody>("GET", "/api/apps/assets/items?q=Matrix Dual");
    assert.deepEqual(list.body.items[0]!.categories.map((category) => category.id), [catA, catB]);
  });

  it("dedupes repeated categoryIds in a request", async () => {
    const created = await json<ItemView>("POST", "/api/apps/assets/items", {
      name: "Matrix Dupe",
      categoryIds: [catA, catA, catA],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(
      created.body.categories.map((category) => category.id),
      [catA],
      "duplicate ids collapse into one relation",
    );
  });

  it("rejects nonexistent category ids with 422 category_not_found on create and PATCH", async () => {
    const ghost = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

    const create = await json<ErrorBody>("POST", "/api/apps/assets/items", {
      name: "Matrix Ghost",
      categoryIds: [catA, ghost],
    });
    assert.equal(create.status, 422);
    assert.equal(create.body.error.code, "category_not_found");

    const patch = await json<ErrorBody>(
      "PATCH",
      `/api/apps/assets/items/${soloId}`,
      { categoryIds: [ghost] },
    );
    assert.equal(patch.status, 422);
    assert.equal(patch.body.error.code, "category_not_found");

    const after = await json<ItemView>("GET", `/api/apps/assets/items/${soloId}`);
    assert.deepEqual(
      after.body.categories.map((category) => category.id),
      [catA],
      "the failed replacement rolls back to the previous set",
    );
  });

  it("rejects categoryIds null with 400 on create and PATCH", async () => {
    const create = await json<ErrorBody>("POST", "/api/apps/assets/items", {
      name: "Matrix Null",
      categoryIds: null,
    });
    assert.equal(create.status, 400);
    assert.equal(create.body.error.code, "validation_error");

    const patch = await json<ErrorBody>(
      "PATCH",
      `/api/apps/assets/items/${soloId}`,
      { categoryIds: null },
    );
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.code, "validation_error");
  });

  it("q matches items via any assigned category name", async () => {
    const viaAlpha = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?q=${encodeURIComponent("Matrix Alpha")}`,
    );
    const viaAlphaNames = viaAlpha.body.items.map((item) => item.name);
    assert.ok(viaAlphaNames.includes("Matrix Solo"), "single-category item matches its category name");
    assert.ok(viaAlphaNames.includes("Matrix Dual"), "multi-category item matches via one assigned category");
    assert.ok(!viaAlphaNames.includes("Matrix Plain"), "uncategorized items only match via name or description");

    const viaBeta = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?q=${encodeURIComponent("Matrix Beta")}`,
    );
    assert.deepEqual(
      viaBeta.body.items.map((item) => item.name),
      ["Matrix Dual"],
      "the multi-category item also matches via its second category",
    );
  });

  it("PATCH categoryIds tri-state: absent keeps, list replaces, empty list clears", async () => {
    const untouched = await json<ItemView>("PATCH", `/api/apps/assets/items/${soloId}`, { quantity: 7 });
    assert.equal(untouched.status, 200);
    assert.equal(untouched.body.quantity, 7);
    assert.deepEqual(untouched.body.categories.map((category) => category.id), [catA], "absent keeps the current set");

    const replaced = await json<ItemView>("PATCH", `/api/apps/assets/items/${soloId}`, { categoryIds: [catC] });
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.body.categories.map((category) => category.id), [catC], "a non-empty list replaces the set");

    const cleared = await json<ItemView>("PATCH", `/api/apps/assets/items/${soloId}`, { categoryIds: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.categories, [], "the empty list clears the set");

    // Restore [A, B] for the filter and counts cases below.
    const restored = await json<ItemView>("PATCH", `/api/apps/assets/items/${soloId}`, { categoryIds: [catA, catB] });
    assert.deepEqual(restored.body.categories.map((category) => category.id), [catA, catB]);
  });

  it("filters by one category, several categories (AND) and rejects malformed ids", async () => {
    const single = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?q=Matrix&categories=${catA}&sortBy=name&order=asc`,
    );
    assert.equal(single.status, 200);
    assert.deepEqual(
      single.body.items.map((item) => item.name),
      ["Matrix Dual", "Matrix Dupe", "Matrix Solo"],
      "single selection with the sort allowlist still deterministic",
    );

    const intersection = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?q=Matrix&categories=${catA},${catB}&sortBy=name&order=asc`,
    );
    assert.equal(intersection.status, 200);
    assert.deepEqual(
      intersection.body.items.map((item) => item.name),
      ["Matrix Dual", "Matrix Solo"],
      "comma-separated ids intersect (AND)",
    );

    const malformed = await json<ErrorBody>("GET", "/api/apps/assets/items?categories=definitely-not-a-uuid");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "validation_error");

    // A well-formed but nonexistent id simply matches nothing.
    const nonexistent = await json<ItemsListBody>(
      "GET",
      "/api/apps/assets/items?categories=eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    );
    assert.equal(nonexistent.status, 200);
    assert.deepEqual(nonexistent.body.items, []);
  });

  it("combines categories with q, targetLocation and an acquired range", async () => {
    const widget = await json<ItemView>("POST", "/api/apps/assets/items", {
      name: "Matrix Widget",
      targetLocation: "matrix-shelf",
      acquiredAt: "2026-04-01",
      categoryIds: [catA],
    });
    assert.equal(widget.status, 201);

    const cross = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?q=Matrix&categories=${catA}&targetLocation=shelf`
        + "&acquiredAfter=2026-03-01&acquiredBefore=2026-05-01&sortBy=name&order=asc",
    );
    assert.equal(cross.status, 200);
    assert.deepEqual(
      cross.body.items.map((item) => item.name),
      ["Matrix Widget"],
    );
  });

  it("returns faceted counts that ignore the categories facet but follow the rest", async () => {
    // Selecting A must not zero out B's count: counts drop only the categories
    // facet, every other filter still applies (worklist §2.4).
    const withA = await json<ItemsListBody>("GET", `/api/apps/assets/items?q=Matrix&categories=${catA}`);
    assert.equal(withA.status, 200);
    assert.ok(withA.body.counts.categories[catB]! > 0, "category B keeps a truthy count while A is selected");
    assert.equal(
      withA.body.counts.categories[catB],
      2,
      "the two multi-category items (Solo, Dual) each count once per category",
    );

    // counts.all is unaffected by the category selection itself.
    const withoutA = await json<ItemsListBody>("GET", "/api/apps/assets/items?q=Matrix");
    assert.equal(withA.body.counts.all, withoutA.body.counts.all, "counts.all ignores the categories facet");
    assert.equal(withoutA.body.counts.all, 5, "five matrix items match q");
    assert.equal(withoutA.body.counts.categories[catA], 4, "Solo, Dual, Dupe and Widget are in A");
    assert.equal(withoutA.body.counts.categories[catB], 2, "Solo and Dual are in B");
    assert.equal(withoutA.body.counts.categories[catC], 0, "an emptied category is present with a zero count");
    assert.equal(withoutA.body.counts.categories[catEmpty], 0, "a never-used category is present with a zero count");

    // Every existing category has a counts entry, even under a narrow q.
    const narrowed = await json<ItemsListBody>(
      "GET",
      `/api/apps/assets/items?q=${encodeURIComponent("Matrix Widget")}`,
    );
    const categoriesList = await json<{ items: Array<{ id: string }> }>("GET", "/api/apps/assets/categories");
    for (const category of categoriesList.body.items) {
      assert.ok(category.id in narrowed.body.counts.categories, `counts cover category ${category.id}`);
    }
    assert.equal(narrowed.body.counts.all, 1, "q narrows counts.all");
    assert.equal(narrowed.body.counts.categories[catA], 1);
    assert.equal(narrowed.body.counts.categories[catB], 0, "q narrows per-category counts down to zero");
  });
});

describe("item created event (P7A2 v2)", () => {
  it("publishes assets.item.created.v2 after commit and no longer publishes v1", async () => {
    itemCreatedEvents.length = 0;
    const catOne = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Eventful One" });
    const catTwo = await json<{ id: string }>("POST", "/api/apps/assets/categories", { name: "Eventful Two" });
    assert.equal(catOne.status, 201);
    assert.equal(catTwo.status, 201);

    const created = await json<ItemView>("POST", "/api/apps/assets/items", {
      name: "Matrix Eventful",
      categoryIds: [catOne.body.id, catTwo.body.id],
    });
    assert.equal(created.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const v2 = itemCreatedEvents.filter((event) => event.type === "assets.item.created.v2");
    assert.equal(v2.length, 1, "exactly one v2 event per create");
    assert.equal(v2[0]!.source, "assets");
    assert.equal(v2[0]!.payload.id, created.body.id);
    assert.equal(v2[0]!.payload.name, "Matrix Eventful");
    assert.deepEqual(v2[0]!.payload.categoryIds, [catOne.body.id, catTwo.body.id]);

    assert.equal(
      itemCreatedEvents.filter((event) => event.type === "assets.item.created.v1").length,
      0,
      "the v1 event is no longer published",
    );
  });
});
