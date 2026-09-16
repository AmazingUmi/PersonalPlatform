import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform, ensureTestAdmin, prepareFixtureRoot } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { createLogger } from "../../src/core/logging/index.js";
import { migrateLegacyAppStorage, userScopeMigrationDone } from "../../src/core/storage/legacy-move.js";

/**
 * AUTH-GATE-07 acceptance: upgrading an existing single-user deployment.
 * Each app is set up at its PRE-multi-user schema, seeded with legacy rows,
 * then the user-ownership migration runs and every row must be owned by the
 * bootstrap admin with the per-user constraints in place. Plus the one-time
 * legacy storage file relocation.
 */

const log = createLogger("fatal");

const repoRoot = (() => {
  let dir = import.meta.dirname;
  for (let i = 0; i < 3; i += 1) dir = join(dir, "..");
  return dir;
})();

const OWNERSHIP_FILE = "20260916100000-user-ownership.sql";
const ADMIN_USERNAME = "admin";

function migrationSources(appId: string): Array<{ file: string; sql: string }> {
  const dir = join(repoRoot, "apps", appId, "migrations");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(dir, file), "utf8") }));
}

type Ctx = ReturnType<Database["context"]>;

async function ownerOf(ctx: Ctx, table: string): Promise<string[]> {
  const result = await ctx.query<{ owner: string }>(`SELECT user_id::text AS owner FROM ${table}`);
  return result.rows.map((row) => row.owner);
}

/** A second, non-bootstrap user to prove per-user constraint behavior. */
async function secondUserId(ctx: Ctx): Promise<string> {
  const { rows } = await ctx.query<{ id: string }>(
    `INSERT INTO core.users (id, username, password_hash, role)
     VALUES (gen_random_uuid(), 'second', '$argon2id$placeholder-not-verifiable', 'user')
     RETURNING id::text`,
  );
  return rows[0]!.id;
}

interface AppCase {
  appId: string;
  seed: (ctx: Ctx) => Promise<void>;
  verify: (ctx: Ctx, adminId: string, otherId: string) => Promise<void>;
}

const CASES: AppCase[] = [
  {
    appId: "notes",
    async seed(ctx) {
      await ctx.query(
        "INSERT INTO notes.notes (id, title, content, occurred_at) VALUES ('11111111-1111-4111-8111-111111111101', 'legacy note', 'body', now())",
      );
      await ctx.query("INSERT INTO notes.tags (id, name) VALUES ('11111111-1111-4111-8111-111111111102', 'Work')");
      await ctx.query(
        "INSERT INTO notes.note_tags (note_id, tag_id) VALUES ('11111111-1111-4111-8111-111111111101', '11111111-1111-4111-8111-111111111102')",
      );
    },
    async verify(ctx, adminId, otherId) {
      assert.deepEqual(await ownerOf(ctx, "notes.notes"), [adminId]);
      assert.deepEqual(await ownerOf(ctx, "notes.tags"), [adminId]);
      // Per-user names: another user may own the same tag name.
      const second = await ctx.query(
        "INSERT INTO notes.tags (id, user_id, name) VALUES (gen_random_uuid(), $1, 'Work')",
        [otherId],
      );
      assert.equal(second.rowCount, 1);
    },
  },
  {
    appId: "tasks",
    async seed(ctx) {
      await ctx.query(
        "INSERT INTO tasks.tasks (id, title) VALUES ('22222222-2222-4222-8222-222222222201', 'legacy task')",
      );
    },
    async verify(ctx, adminId) {
      assert.deepEqual(await ownerOf(ctx, "tasks.tasks"), [adminId]);
    },
  },
  {
    appId: "assets",
    async seed(ctx) {
      await ctx.query("INSERT INTO assets.categories (id, name) VALUES ('33333333-3333-4333-8333-333333333301', 'legacy-cat')");
      await ctx.query("INSERT INTO assets.items (id, name) VALUES ('33333333-3333-4333-8333-333333333302', 'legacy item')");
      await ctx.query(
        `INSERT INTO assets.attachments (id, item_id, filename, size, storage_key)
         VALUES ('33333333-3333-4333-8333-333333333303', '33333333-3333-4333-8333-333333333302', 'a.bin', 1, 'attachments/legacy/legacy')`,
      );
      await ctx.query(
        "INSERT INTO assets.cleanup_jobs (id, kind, reason) VALUES ('33333333-3333-4333-8333-333333333304', 'delete_storage', 'legacy reason')",
      );
    },
    async verify(ctx, adminId) {
      // categories includes the seeded defaults (fresh replay inserts them
      // during the legacy phase); every row must be the admin's.
      for (const table of ["assets.categories", "assets.items", "assets.attachments", "assets.cleanup_jobs"]) {
        const owners = await ownerOf(ctx, table);
        assert.ok(owners.length >= 1, `${table} has rows`);
        assert.ok(owners.every((owner) => owner === adminId), `${table} fully owned by the bootstrap admin`);
      }
    },
  },
  {
    appId: "focus",
    async seed(ctx) {
      await ctx.query(
        `INSERT INTO focus.sessions (id, kind, status, planned_duration_seconds, started_at, ended_at, end_reason, actual_duration_seconds)
         VALUES ('44444444-4444-4444-8444-444444444401', 'focus', 'completed', 1500, now() - interval '1 hour', now() - interval '30 minutes', 'natural', 1500)`,
      );
      await ctx.query("INSERT INTO focus.settings (id, value) VALUES ('current', '{}')");
    },
    async verify(ctx, adminId, otherId) {
      assert.deepEqual(await ownerOf(ctx, "focus.sessions"), [adminId]);
      assert.deepEqual(await ownerOf(ctx, "focus.settings"), [adminId]);
      // Per-user one-active: the admin's completed row is untouched, and a
      // different user may hold a running session without any conflict.
      await ctx.query(
        `INSERT INTO focus.sessions (id, user_id, kind, status, planned_duration_seconds, started_at)
         VALUES (gen_random_uuid(), $1, 'focus', 'running', 1500, now())`,
        [otherId],
      );
      const running = await ctx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM focus.sessions WHERE status = 'running'",
      );
      assert.equal(running.rows[0]!.count, "1");
    },
  },
  {
    appId: "clock",
    async seed(ctx) {
      await ctx.query("INSERT INTO clock.alarms (id, time) VALUES ('55555555-5555-4555-8555-555555555501', '07:00')");
      await ctx.query(
        "INSERT INTO clock.world_clocks (id, city, timezone, sort_order) VALUES ('55555555-5555-4555-8555-555555555502', 'Shanghai', 'Asia/Shanghai', 1)",
      );
      await ctx.query("INSERT INTO clock.settings (id, value) VALUES ('current', '{}')");
    },
    async verify(ctx, adminId) {
      assert.deepEqual(await ownerOf(ctx, "clock.alarms"), [adminId]);
      assert.deepEqual(await ownerOf(ctx, "clock.world_clocks"), [adminId]);
      assert.deepEqual(await ownerOf(ctx, "clock.settings"), [adminId]);
    },
  },
  {
    appId: "mini_game",
    async seed(ctx) {
      await ctx.query("INSERT INTO mini_game.saves (id, score, high_score, revision) VALUES ('current', 120, 200, 3)");
    },
    async verify(ctx, adminId, otherId) {
      assert.deepEqual(await ownerOf(ctx, "mini_game.saves"), [adminId]);
      // Per-user slot: another user gets their own 'current' row.
      await ctx.query(
        "INSERT INTO mini_game.saves (id, user_id, score, high_score, revision) VALUES ('current', $1, 0, 0, 0)",
        [otherId],
      );
    },
  },
];

describe("single-user → multi-user upgrade path (AUTH-GATE-07)", () => {
  for (const testCase of CASES) {
    it(`${testCase.appId}: legacy rows migrate to the bootstrap owner with per-user constraints`, async () => {
      let db: Database | undefined;
      try {
        db = await resetDatabase();
        await ensureTestAdmin(db);
        const ctx = db.context();
        const otherId = await secondUserId(ctx);

        const sources = migrationSources(testCase.appId);
        const legacy = sources.filter((m) => m.file !== OWNERSHIP_FILE);
        const ownership = sources.find((m) => m.file === OWNERSHIP_FILE);
        assert.ok(ownership, `${testCase.appId} has a user-ownership migration`);

        // 1. Legacy shape: apply every migration except the ownership one.
        const legacyFixture = prepareFixtureRoot([
          { id: testCase.appId, migrations: legacy.map((m) => m.sql) },
        ]);
        // 2. Upgrade shape: same steps plus the ownership migration as a new step.
        const upgradeFixture = prepareFixtureRoot([
          { id: testCase.appId, migrations: [...legacy.map((m) => m.sql), ownership.sql] },
        ]);
        try {
          await runMigrations({
            databaseUrl: TEST_DATABASE_URL,
            targets: [
              { scope: testCase.appId, schema: testCase.appId, dir: join(legacyFixture.root, "apps", testCase.appId, "migrations") },
            ],
          });

          await testCase.seed(ctx);

          await runMigrations({
            databaseUrl: TEST_DATABASE_URL,
            targets: [
              { scope: testCase.appId, schema: testCase.appId, dir: join(upgradeFixture.root, "apps", testCase.appId, "migrations") },
            ],
          });

          const admin = await ctx.query<{ id: string }>("SELECT id FROM core.users WHERE username = $1", [
            ADMIN_USERNAME,
          ]);
          await testCase.verify(ctx, admin.rows[0]!.id, otherId);
        } finally {
          legacyFixture.cleanup();
          upgradeFixture.cleanup();
        }
      } finally {
        await db?.close().catch(() => undefined);
      }
    });
  }
});

describe("legacy storage relocation (AUTH-GATE-04/07)", () => {
  it("moves legacy app files into the bootstrap owner's user-scoped root, idempotently", async () => {
    let db: Database | undefined;
    let platform: Platform | undefined;
    let cleanupRoot: (() => void) | undefined;
    try {
      db = await resetDatabase();
      await ensureTestAdmin(db);
      const fixture = await buildFixturePlatform({ manifests: [], database: db });
      platform = fixture.platform;
      cleanupRoot = fixture.cleanup;
      const storageRoot = join(fixture.root, "storage");

      // Legacy layout: a pre-multi-user attachment on disk.
      const legacyFile = join(storageRoot, "apps", "assets", "attachments", "legacy-item", "legacy-att");
      mkdirSync(join(storageRoot, "apps", "assets", "attachments", "legacy-item"), { recursive: true });
      writeFileSync(legacyFile, "legacy-bytes");

      const admin = await db.context().query<{ id: string }>("SELECT id FROM core.users WHERE username = 'admin'");
      const adminId = admin.rows[0]!.id;

      const first = await migrateLegacyAppStorage({ database: db, storageRoot, log });
      assert.equal(first.movedFiles, 1);
      const targetPath = join(storageRoot, "users", adminId, "apps", "assets", "attachments", "legacy-item", "legacy-att");
      assert.ok(existsSync(targetPath), "file now lives under the owner's user root");
      assert.ok(!existsSync(join(storageRoot, "apps")), "legacy tree removed");
      assert.ok(await userScopeMigrationDone(db.context()), "marker recorded");

      // Idempotent: the second run is a no-op.
      const second = await migrateLegacyAppStorage({ database: db, storageRoot, log });
      assert.equal(second.movedFiles, 0);
      assert.ok(existsSync(targetPath), "file untouched by the second run");
    } finally {
      await platform?.stop().catch(() => undefined);
      cleanupRoot?.();
      await db?.close().catch(() => undefined);
    }
  });

  it("propagates failures without setting the marker, then recovers on rerun", async () => {
    let db: Database | undefined;
    let platform: Platform | undefined;
    let cleanupRoot: (() => void) | undefined;
    try {
      db = await resetDatabase();
      await ensureTestAdmin(db);
      const fixture = await buildFixturePlatform({ manifests: [], database: db });
      platform = fixture.platform;
      cleanupRoot = fixture.cleanup;
      const storageRoot = join(fixture.root, "storage");

      const legacyFile = join(storageRoot, "apps", "assets", "attachments", "item-x", "att-y");
      mkdirSync(join(storageRoot, "apps", "assets", "attachments", "item-x"), { recursive: true });
      writeFileSync(legacyFile, "bytes");

      const admin = await db.context().query<{ id: string }>("SELECT id FROM core.users WHERE username = 'admin'");
      const targetPath = join(storageRoot, "users", admin.rows[0]!.id, "apps", "assets", "attachments", "item-x", "att-y");
      // Obstruct the target with a directory so the per-file rename fails.
      mkdirSync(targetPath, { recursive: true });

      await assert.rejects(() => migrateLegacyAppStorage({ database: db!, storageRoot, log }));
      assert.ok(!(await userScopeMigrationDone(db.context())), "failure must not set the marker");

      // Clearing the obstruction lets the idempotent rerun converge.
      rmSync(targetPath, { recursive: true, force: true });
      const recovered = await migrateLegacyAppStorage({ database: db!, storageRoot, log });
      assert.equal(recovered.movedFiles, 1);
      assert.ok(existsSync(targetPath), "file landed after recovery");
      assert.ok(await userScopeMigrationDone(db.context()));
    } finally {
      await platform?.stop().catch(() => undefined);
      cleanupRoot?.();
      await db?.close().catch(() => undefined);
    }
  });

  it("is a no-op on a fresh install with no legacy tree", async () => {
    let db: Database | undefined;
    let platform: Platform | undefined;
    let cleanupRoot: (() => void) | undefined;
    try {
      db = await resetDatabase();
      await ensureTestAdmin(db);
      const fixture = await buildFixturePlatform({ manifests: [], database: db });
      platform = fixture.platform;
      cleanupRoot = fixture.cleanup;
      const result = await migrateLegacyAppStorage({
        database: db,
        storageRoot: join(fixture.root, "storage"),
        log,
      });
      assert.equal(result.movedFiles, 0);
      assert.ok(await userScopeMigrationDone(db.context()), "marker recorded even with nothing to move");
    } finally {
      await platform?.stop().catch(() => undefined);
      cleanupRoot?.();
      await db?.close().catch(() => undefined);
    }
  });
});

// after/before imported for symmetry with sibling suites; this file manages
// its own lifecycle per test.
void after;
void before;
