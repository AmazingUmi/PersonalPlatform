import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

/**
 * P7A2 migration coverage (worklist §6.1): 20260831000007-item-categories.sql
 * must move every legacy single-category assignment into item_categories and
 * drop the column, leaving uncategorized items untouched. Progress is staged
 * through a temp directory holding only the migrations before it (the legacy
 * model), filenames copied verbatim so the recorded names match the real
 * directory; the real apps/assets/migrations directory then applies the rest.
 */

const log = createLogger("fatal");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const realMigrationsDir = join(repoRoot, "apps", "assets", "migrations");
const ITEM_CATEGORIES_MIGRATION = "20260831000007-item-categories.sql";

// Fixed ids make the backfill assertions exact.
const CATEGORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CATEGORIZED_ONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CATEGORIZED_TWO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNCATEGORIZED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const tmpRoot = mkdtempSync(join(tmpdir(), "pp-assets-migrate-"));
let db: Database;
let legacyDir: string;
let migrationFiles: string[];

before(async () => {
  db = await resetDatabase();

  migrationFiles = readdirSync(realMigrationsDir).sort();
  const boundary = migrationFiles.indexOf(ITEM_CATEGORIES_MIGRATION);
  assert.ok(boundary > 0, `${ITEM_CATEGORIES_MIGRATION} is preceded by the legacy migrations`);
  legacyDir = join(tmpRoot, "legacy-migrations");
  mkdirSync(legacyDir, { recursive: true });
  // Copy verbatim, never rename: the second runMigrations pass must recognize
  // 01–06 as already applied (checkOrder compares recorded names).
  for (const file of migrationFiles.slice(0, boundary)) {
    copyFileSync(join(realMigrationsDir, file), join(legacyDir, file));
  }
});

after(async () => {
  // resetDatabase() may have failed; teardown must stay safe.
  if (db) await db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("item-categories migration backfill (P7A2)", () => {
  it("applies the legacy migrations and stops before item_categories", async () => {
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: [{ scope: "assets", schema: "assets", dir: legacyDir }],
      log,
    });

    const legacyColumn = await db.context().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
       WHERE table_schema = 'assets' AND table_name = 'items' AND column_name = 'category_id'`,
    );
    assert.equal(legacyColumn.rows[0]!.count, 1, "the legacy model still carries items.category_id");

    const relationTable = await db.context().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'assets' AND table_name = 'item_categories'`,
    );
    assert.equal(relationTable.rows[0]!.count, 0, "item_categories does not exist yet");
  });

  it("seeds legacy rows: two categorized items and one uncategorized", async () => {
    await db.context().query(
      `INSERT INTO assets.categories (id, name) VALUES ('${CATEGORY_ID}', 'Migration Legacy Cat')`,
    );
    await db.context().query(
      `INSERT INTO assets.items (id, category_id, name) VALUES
         ('${CATEGORIZED_ONE}', '${CATEGORY_ID}', 'Legacy Categorized One'),
         ('${CATEGORIZED_TWO}', '${CATEGORY_ID}', 'Legacy Categorized Two')`,
    );
    await db.context().query(
      `INSERT INTO assets.items (id, name) VALUES ('${UNCATEGORIZED}', 'Legacy Uncategorized')`,
    );

    const items = await db.context().query<{ id: string }>("SELECT id FROM assets.items ORDER BY id");
    assert.deepEqual(
      items.rows.map((row) => row.id),
      [CATEGORIZED_ONE, CATEGORIZED_TWO, UNCATEGORIZED],
    );
  });

  it("backfills relation rows, keeps uncategorized items and drops the legacy column", async () => {
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: [{ scope: "assets", schema: "assets", dir: realMigrationsDir }],
      log,
    });

    const relations = await db.context().query<{ item_id: string; category_id: string }>(
      "SELECT item_id, category_id FROM assets.item_categories ORDER BY item_id",
    );
    assert.deepEqual(
      relations.rows,
      [
        { item_id: CATEGORIZED_ONE, category_id: CATEGORY_ID },
        { item_id: CATEGORIZED_TWO, category_id: CATEGORY_ID },
      ],
      "each legacy category_id became exactly one relation row",
    );

    const uncategorizedLinks = await db.context().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM assets.item_categories WHERE item_id = $1",
      [UNCATEGORIZED],
    );
    assert.equal(uncategorizedLinks.rows[0]!.count, 0, "the uncategorized item gets no relation row");

    const uncategorizedRow = await db.context().query<{ name: string }>(
      "SELECT name FROM assets.items WHERE id = $1",
      [UNCATEGORIZED],
    );
    assert.equal(uncategorizedRow.rows[0]!.name, "Legacy Uncategorized", "the item row itself is intact");

    const droppedColumn = await db.context().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
       WHERE table_schema = 'assets' AND table_name = 'items' AND column_name = 'category_id'`,
    );
    assert.equal(droppedColumn.rows[0]!.count, 0, "items.category_id is gone");

    const itemIndexes = await db.context().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'assets' AND tablename = 'items'`,
    );
    assert.ok(
      !itemIndexes.rows.some((row) => row.indexname === "items_category_idx"),
      "the legacy category index dropped together with the column",
    );

    const relationIndexes = await db.context().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'assets' AND tablename = 'item_categories'`,
    );
    assert.ok(
      relationIndexes.rows.some((row) => row.indexname === "item_categories_category_idx"),
      "the reverse lookup index for per-category counts exists",
    );
  });

  it("is a safe no-op when migrations run again", async () => {
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: [{ scope: "assets", schema: "assets", dir: realMigrationsDir }],
      log,
    });

    const applied = await db.context().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM assets.migrations",
    );
    assert.equal(applied.rows[0]!.count, migrationFiles.length, "no migration was re-applied");

    const relations = await db.context().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM assets.item_categories",
    );
    assert.equal(relations.rows[0]!.count, 2, "the backfill did not duplicate rows");
  });
});
