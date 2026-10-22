import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import assetsApp from "../../src/apps/assets/index.js";
import type { AppContext, BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Platform } from "../../src/core/platform.js";
import { StorageError, type Storage } from "../../src/core/storage/index.js";
import { buildFixturePlatform, createTestUser, ensureTestAdmin, loginCookie } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { multipartBody } from "../helpers/multipart.js";
import { runMigrations } from "../../src/core/database/migrate.js";

/**
 * FP-12: storage/DB consistency compensation and multipart uploads.
 *
 * PostgreSQL and the filesystem cannot be updated atomically, so every
 * cross-store step that fails enqueues an idempotent cleanup job; a
 * reconciliation pass drains the queue and drops metadata whose file
 * vanished.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const assetsMigrations = readdirSync(join(repoRoot, "apps", "assets", "migrations"))
  .sort()
  .map((file) => readFileSync(join(repoRoot, "apps", "assets", "migrations", file), "utf8"));

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;
/** Owning user for user-scoped attachment storage (AUTH-4). */
let adminId: string;
/** Session cookie for the app APIs (every /api/apps/* route needs one). */
let cookie: string;
let assetsContext: AppContext;
const scheduledJobs = new Map<string, () => Promise<void>>();

const fixtureAssets: BackendAppModule = {
  ...assetsApp,
  async registerApi(ctx) {
    assetsContext = ctx;
    await assetsApp.registerApi(ctx);
  },
  async registerJobs(ctx) {
    // Capture the real callbacks without starting timers: API cases must not
    // race the onceAfterMs boot sweep. The scheduler-log case runs one directly.
    return assetsApp.registerJobs!({
      ...ctx,
      scheduler: {
        register(spec) {
          scheduledJobs.set(spec.id, spec.run);
          return { id: spec.id, stop: () => { scheduledJobs.delete(spec.id); } };
        },
      },
    });
  },
};

before(async () => {
  db = await resetDatabase();
  adminId = await ensureTestAdmin(db);
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "assets", migrations: assetsMigrations }],
    backendModules: { assets: fixtureAssets },
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;
  cookie = await loginCookie(platform);
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "assets", schema: "assets", dir: join(root, "apps", "assets", "migrations") }],
  });
});

after(async () => {
  if (platform) await platform.stop();
  scheduledJobs.clear();
  cleanup?.();
  if (db) await db.close();
});

async function createItem(name: string, ownerCookie = cookie): Promise<string> {
  const response = await platform.app.inject({
    method: "POST",
    url: "/api/apps/assets/items",
    payload: { name },
    headers: { cookie: ownerCookie },
  });
  assert.equal(response.statusCode, 201);
  return response.json().id as string;
}

function upload(itemId: string, filename: string, data: Buffer | string, contentType?: string, ownerCookie = cookie) {
  const body = multipartBody([{ name: "file", filename, contentType, data }]);
  return platform.app.inject({
    method: "POST",
    url: `/api/apps/assets/items/${itemId}/attachments`,
    payload: body.payload,
    // Merge instead of spread-override: multipartBody sets the content-type.
    headers: { ...body.headers, cookie: ownerCookie },
  });
}

function attachmentFile(itemId: string, attachmentId: string): string {
  // AUTH-4: attachments live in the owner's user-scoped storage root.
  return join(root, "storage", "users", adminId, "apps", "assets", "attachments", itemId, attachmentId);
}

async function reconcile(): Promise<{
  queue: { processed: number; failed: number };
  danglingDropped: number;
  probeFailed: number;
}> {
  const response = await platform.app.inject({
    method: "POST",
    url: "/api/apps/assets/maintenance/reconcile",
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

interface ProbeAttachment {
  id: string;
  itemId: string;
  userId: string;
  storageKey: string;
  file: string;
  content: string;
}

async function createProbeAttachment(
  name: string,
  owner = { id: adminId, cookie },
): Promise<ProbeAttachment> {
  const itemId = await createItem(name, owner.cookie);
  const content = `probe payload: ${name}`;
  const uploaded = await upload(itemId, `${name}.txt`, content, undefined, owner.cookie);
  assert.equal(uploaded.statusCode, 201);
  const id = uploaded.json().id as string;
  const { rows } = await db.context().query<{ storage_key: string }>(
    "SELECT storage_key FROM assets.attachments WHERE id = $1",
    [id],
  );
  const storageKey = rows[0]!.storage_key;
  return {
    id, itemId, userId: owner.id, storageKey, content,
    file: join(root, "storage", "users", owner.id, "apps", "assets", storageKey),
  };
}

async function attachmentMetadata(id: string) {
  const { rows } = await db.context().query<{ id: string; user_id: string; storage_key: string }>(
    "SELECT id, user_id, storage_key FROM assets.attachments WHERE id = $1",
    [id],
  );
  return rows[0];
}

function storageFacade(driver: Storage, overrides: Partial<Storage>): Storage {
  return {
    save: driver.save.bind(driver), read: driver.read.bind(driver),
    delete: driver.delete.bind(driver), list: driver.list.bind(driver),
    exists: driver.exists.bind(driver), ...overrides,
  };
}

async function withStorageFacade(
  decorate: (userId: string, driver: Storage) => Storage,
  run: () => Promise<void>,
): Promise<void> {
  const original = assetsContext.storage.forUser;
  assetsContext.storage.forUser = (userId) => decorate(userId, original.call(assetsContext.storage, userId));
  try {
    await run();
  } finally {
    assetsContext.storage.forUser = original;
  }
}

function assertProbeWarning(warnings: unknown[], attachment: ProbeAttachment, code: string): void {
  assert.ok(warnings.some((warning) => {
    if (typeof warning !== "object" || warning === null) return false;
    const fields = warning as Record<string, unknown>;
    return fields.attachmentId === attachment.id && fields.userId === attachment.userId && fields.code === code;
  }), `probe warning identifies attachment, owner and ${code}`);
}

async function assertDownloadRestored(attachment: ProbeAttachment): Promise<void> {
  const response = await platform.app.inject({
    method: "GET",
    url: `/api/apps/assets/items/${attachment.itemId}/attachments/${attachment.id}`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, attachment.content);
}

describe("multipart upload validation (FP-12.2)", () => {
  let itemId: string;

  before(async () => {
    itemId = await createItem("Upload target");
  });

  it("accepts a single file part and stores filename, type and size", async () => {
    const response = await upload(itemId, "photo.bin", Buffer.from("hello-multipart"), "application/octet-stream");
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.filename, "photo.bin");
    assert.equal(body.contentType, "application/octet-stream");
    assert.equal(Number(body.size), "hello-multipart".length);
    assert.ok(existsSync(attachmentFile(itemId, body.id)), "file landed in storage");
  });

  it("rejects a non-multipart body with a clean validation error", async () => {
    const response = await platform.app.inject({
      method: "POST",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      payload: { filename: "x.txt", dataBase64: "eA==" },
      headers: { "content-type": "application/json", cookie },
    });
    // The multipart content-type parser rejects non-multipart bodies.
    assert.equal(response.statusCode, 406);
    assert.equal(response.json().error.code, "bad_request");
  });

  it("enforces the 10MB server-side limit with 413", async () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const response = await upload(itemId, "big.bin", oversized);
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, "attachment_too_large");

    // No partial file or metadata row survived the rejection.
    const list = await platform.app.inject({
      method: "GET",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      headers: { cookie },
    });
    const names = list.json().items.map((item: { filename: string }) => item.filename);
    assert.ok(!names.includes("big.bin"), "no metadata for rejected upload");
  });

  it("accepts a file exactly at the limit", async () => {
    const exact = Buffer.alloc(10 * 1024 * 1024, 7);
    const response = await upload(itemId, "exact.bin", exact);
    assert.equal(response.statusCode, 201);
    assert.equal(Number(response.json().size), exact.length);
  });
});

describe("upload compensation: DB failure after storage save (FP-12.1)", () => {
  it("leaves no orphan file behind", async () => {
    const itemId = await createItem("Orphan target");
    // Force the metadata INSERT to fail while storage.save succeeds.
    await db.context().query("ALTER TABLE assets.attachments ADD CONSTRAINT test_block_insert CHECK (false) NOT VALID");

    const response = await upload(itemId, "orphan.txt", "soon-to-be-orphaned");
    assert.equal(response.statusCode, 500, "insert fails");

    const jobs = await db
      .context()
      .query<{ kind: string; status: string; storage_key: string }>(
        "SELECT kind, status, storage_key FROM assets.cleanup_jobs WHERE reason LIKE '%insert failed%'",
      );
    assert.ok(jobs.rows.length >= 1, "compensation job enqueued");
    for (const job of jobs.rows) {
      assert.equal(job.kind, "delete_storage");
      assert.equal(job.status, "done", "inline cleanup deleted the orphan");
      assert.ok(!existsSync(join(root, "storage", "users", adminId, "apps", "assets", job.storage_key)), "orphan file removed");
    }

    await db.context().query("ALTER TABLE assets.attachments DROP CONSTRAINT test_block_insert");
    const recovery = await upload(itemId, "retry.txt", "works-again");
    assert.equal(recovery.statusCode, 201, "upload works after the fault cleared");
  });
});

describe("delete compensation: DB failure after storage removal (FP-12.1)", () => {
  it("queues and later drains the dangling metadata drop", async () => {
    const itemId = await createItem("Dangling target");
    const uploaded = await upload(itemId, "gone.txt", "about-to-vanish");
    assert.equal(uploaded.statusCode, 201);
    const attachmentId = uploaded.json().id;

    // Block the metadata DELETE; storage delete succeeds first.
    await db.context().query(`
      CREATE OR REPLACE FUNCTION assets._test_block_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'delete blocked'; END
      $$ LANGUAGE plpgsql`);
    await db.context().query(
      "CREATE TRIGGER test_block_delete BEFORE DELETE ON assets.attachments FOR EACH ROW EXECUTE FUNCTION assets._test_block_delete()",
    );

    const response = await platform.app.inject({
      method: "DELETE",
      url: `/api/apps/assets/items/${itemId}/attachments/${attachmentId}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 500, "metadata delete fails");
    assert.ok(!existsSync(attachmentFile(itemId, attachmentId)), "file already removed");

    // The dangling row is queued; inline processing could not drain it (the
    // trigger still blocks), so it stays pending for the scheduler/reconcile.
    const pending = await db
      .context()
      .query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM assets.cleanup_jobs WHERE attachment_id = $1",
        [attachmentId],
      );
    assert.equal(pending.rows[0]!.status, "pending");
    assert.ok(pending.rows[0]!.attempts >= 1, "at least one failed attempt recorded");

    // Fault clears: reconciliation drains the queue and drops the metadata.
    await db.context().query("DROP TRIGGER test_block_delete ON assets.attachments");
    await db.context().query("DROP FUNCTION assets._test_block_delete");
    const result = await reconcile();
    assert.ok(result.queue.processed >= 1);

    const meta = await db
      .context()
      .query("SELECT id FROM assets.attachments WHERE id = $1", [attachmentId]);
    assert.equal(meta.rows.length, 0, "dangling metadata dropped");
  });
});

describe("reconciliation drops metadata whose file vanished (FP-12.1)", () => {
  it("removes rows pointing at missing files", async () => {
    const itemId = await createItem("Reconcile target");
    const uploaded = await upload(itemId, "lost.txt", "will-disappear");
    assert.equal(uploaded.statusCode, 201);
    const attachmentId = uploaded.json().id;
    assert.ok(existsSync(attachmentFile(itemId, attachmentId)));

    // Simulate out-of-band file loss (disk failure, manual deletion).
    rmSync(attachmentFile(itemId, attachmentId));

    const result = await reconcile();
    assert.equal(result.danglingDropped, 1);

    const list = await platform.app.inject({
      method: "GET",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      headers: { cookie },
    });
    assert.equal(list.json().items.length, 0, "metadata for the lost file is gone");
  });

  it("is idempotent: running twice changes nothing", async () => {
    const first = await reconcile();
    const second = await reconcile();
    assert.equal(second.danglingDropped, 0);
    assert.equal(second.queue.processed, 0);
    assert.equal(first.danglingDropped, 0);
  });
});

describe("cleanup job retry and failure observability (FP-12.1)", () => {
  it("marks permanently failing jobs as failed with the last error", async () => {
    const itemId = await createItem("Retry target");
    await db.context().query(
      `INSERT INTO assets.cleanup_jobs (id, user_id, kind, storage_key, reason)
       VALUES ('11111111-1111-4111-8111-111111111111', $1, 'delete_storage', '../escape-attempt', 'test poison')`,
      [adminId],
    );

    for (let i = 0; i < 5; i += 1) {
      await reconcile();
    }
    const job = await db
      .context()
      .query<{ status: string; attempts: number; last_error: string | null }>(
        "SELECT status, attempts, last_error FROM assets.cleanup_jobs WHERE id = '11111111-1111-4111-8111-111111111111'",
      );
    assert.equal(job.rows[0]!.status, "failed");
    assert.equal(job.rows[0]!.attempts, 5);
    assert.match(job.rows[0]!.last_error ?? "", /traversal|invalid_path|storage/i);

    // The queue listing endpoint exposes it to operators.
    const listed = await platform.app.inject({
      method: "GET",
      url: "/api/apps/assets/maintenance/cleanup-jobs",
      headers: { cookie },
    });
    assert.equal(listed.statusCode, 200);
    const poison = listed.json().items.find((item: { id: string }) => item.id === "11111111-1111-4111-8111-111111111111");
    assert.equal(poison.status, "failed");

    // Storage root stayed intact (the traversal key deleted nothing real).
    assert.ok(existsSync(join(root, "storage", "users", adminId, "apps", "assets", "attachments")));
  });
});

describe("reconciliation requires confirmed file loss before deleting metadata", () => {
  it("keeps the exists=true fast path without reading healthy attachments", async () => {
    const attachment = await createProbeAttachment("healthy-fast-path");
    let reads = 0;
    await withStorageFacade((_userId, driver) => storageFacade(driver, {
      read: async () => { reads += 1; throw new Error("healthy files must not be read"); },
    }), async () => {
      const result = await reconcile();
      assert.equal(result.danglingDropped, 0);
      assert.equal(result.probeFailed, 0);
      assert.equal(reads, 0, "including the existing 10 MiB attachment");
      assert.ok(await attachmentMetadata(attachment.id));
    });
  });

  it("preserves a directory at the object path and recovers after it is repaired", async (t) => {
    const attachment = await createProbeAttachment("directory-fault");
    const warn = t.mock.method(assetsContext.log, "warn");
    try {
      rmSync(attachment.file);
      mkdirSync(attachment.file);
      const driver = assetsContext.storage.forUser(attachment.userId);
      assert.equal(await driver.exists(attachment.storageKey), false);
      await assert.rejects(driver.read(attachment.storageKey), (error: unknown) =>
        error instanceof StorageError && error.code === "io_error");
      const result = await reconcile();
      assert.ok(await attachmentMetadata(attachment.id), "directory errors must not delete metadata");
      assert.equal(result.danglingDropped, 0);
      assert.equal(result.probeFailed, 1);
      assertProbeWarning(warn.mock.calls.map((call) => call.arguments[0]), attachment, "io_error");
    } finally {
      rmSync(attachment.file, { recursive: true, force: true });
      writeFileSync(attachment.file, attachment.content);
    }
    await assertDownloadRestored(attachment);
  });

  it("preserves a blocked symlink and recovers after the original file is restored", async (t) => {
    const attachment = await createProbeAttachment("symlink-fault");
    const outside = join(root, `outside-${attachment.id}.txt`);
    const warn = t.mock.method(assetsContext.log, "warn");
    try {
      writeFileSync(outside, "outside sentinel");
      rmSync(attachment.file);
      symlinkSync(outside, attachment.file);
      const driver = assetsContext.storage.forUser(attachment.userId);
      assert.equal(await driver.exists(attachment.storageKey), false);
      await assert.rejects(driver.read(attachment.storageKey), (error: unknown) =>
        error instanceof StorageError && error.code === "invalid_path");
      const result = await reconcile();
      assert.ok(await attachmentMetadata(attachment.id), "symlink rejection must not delete metadata");
      assert.equal(result.danglingDropped, 0);
      assert.equal(result.probeFailed, 1);
      assertProbeWarning(warn.mock.calls.map((call) => call.arguments[0]), attachment, "invalid_path");
      assert.equal(readFileSync(outside, "utf8"), "outside sentinel");
    } finally {
      rmSync(attachment.file, { force: true });
      writeFileSync(attachment.file, attachment.content);
      rmSync(outside, { force: true });
    }
    await assertDownloadRestored(attachment);
  });

  it("confirms a false existence report through the same user storage facade", async () => {
    const attachment = await createProbeAttachment("false-negative");
    let reads = 0;
    await withStorageFacade((userId, driver) => {
      let checkedHere = false;
      return storageFacade(driver, {
        exists: async (key) => {
          if (key !== attachment.storageKey) return driver.exists(key);
          assert.equal(userId, attachment.userId);
          checkedHere = true;
          return false;
        },
        read: async (key) => {
          assert.equal(key, attachment.storageKey);
          assert.equal(userId, attachment.userId);
          assert.ok(checkedHere, "read uses the same facade that returned false");
          reads += 1;
          return driver.read(key);
        },
      });
    }, async () => {
      const result = await reconcile();
      assert.ok(await attachmentMetadata(attachment.id));
      assert.equal(reads, 1);
      assert.equal(result.danglingDropped, 0);
      assert.equal(result.probeFailed, 0);
    });
  });

  const readFailures = [
    { name: "I/O failure", error: () => new StorageError("disk unavailable", "io_error"), code: "io_error" },
    { name: "invalid path", error: () => new StorageError("blocked path", "invalid_path"), code: "invalid_path" },
    { name: "unknown exception", error: () => new Error("unknown storage failure"), code: "unknown" },
    { name: "plain not_found object", error: () => ({ code: "not_found" }), code: "unknown" },
  ];
  for (const failure of readFailures) {
    it(`preserves metadata after a read ${failure.name}`, async (t) => {
      const attachment = await createProbeAttachment(`read-${failure.code}-${failure.name}`);
      const warn = t.mock.method(assetsContext.log, "warn");
      await withStorageFacade((_userId, driver) => storageFacade(driver, {
        exists: (key) => key === attachment.storageKey ? Promise.resolve(false) : driver.exists(key),
        read: async (key) => {
          if (key === attachment.storageKey) throw failure.error();
          return driver.read(key);
        },
      }), async () => {
        const result = await reconcile();
        assert.ok(await attachmentMetadata(attachment.id));
        assert.equal(result.danglingDropped, 0);
        assert.equal(result.probeFailed, 1);
        assertProbeWarning(warn.mock.calls.map((call) => call.arguments[0]), attachment, failure.code);
      });
    });
  }

  it("preserves metadata when exists itself throws not_found", async (t) => {
    const attachment = await createProbeAttachment("exists-not-found");
    const warn = t.mock.method(assetsContext.log, "warn");
    let reads = 0;
    await withStorageFacade((_userId, driver) => storageFacade(driver, {
      exists: async (key) => {
        if (key === attachment.storageKey) throw new StorageError("existence probe failed", "not_found");
        return driver.exists(key);
      },
      read: async (key) => { reads += 1; return driver.read(key); },
    }), async () => {
      const result = await reconcile();
      assert.ok(await attachmentMetadata(attachment.id));
      assert.equal(reads, 0);
      assert.equal(result.danglingDropped, 0);
      assert.equal(result.probeFailed, 1);
      assertProbeWarning(warn.mock.calls.map((call) => call.arguments[0]), attachment, "not_found");
    });
  });

  it("preserves metadata when acquiring its owner storage fails", async (t) => {
    const attachment = await createProbeAttachment("for-user-fault");
    const warn = t.mock.method(assetsContext.log, "warn");
    const { rows } = await db.context().query<{ count: string }>("SELECT count(*)::text AS count FROM assets.attachments");
    await withStorageFacade(() => {
      throw new StorageError("owner storage unavailable", "io_error");
    }, async () => {
      const result = await reconcile();
      assert.ok(await attachmentMetadata(attachment.id));
      assert.equal(result.danglingDropped, 0);
      assert.equal(result.probeFailed, Number(rows[0]!.count));
      assertProbeWarning(warn.mock.calls.map((call) => call.arguments[0]), attachment, "io_error");
    });
  });

  it("continues a mixed sweep in each attachment owner's storage", async (t) => {
    const user = await createTestUser(db, "assets-probe-owner");
    const owner = { id: user.id, cookie: await loginCookie(platform, user.username, "test-password-assets-probe-owner") };
    const failed = await createProbeAttachment("mixed-failure");
    const healthy = await createProbeAttachment("mixed-healthy", owner);
    const missing = [await createProbeAttachment("mixed-admin-missing"), await createProbeAttachment("mixed-user-missing", owner)];
    for (const attachment of missing) rmSync(attachment.file);
    const { rows } = await db.context().query<{ user_id: string; storage_key: string }>(
      "SELECT user_id, storage_key FROM assets.attachments",
    );
    const owners = new Map(rows.map((row) => [row.storage_key, row.user_id]));
    const checked = new Set<string>();
    const readOwners = new Set<string>();
    const warn = t.mock.method(assetsContext.log, "warn");
    await withStorageFacade((userId, driver) => storageFacade(driver, {
      exists: async (key) => {
        assert.equal(userId, owners.get(key), "exists stays inside the row owner's storage");
        checked.add(key);
        return key === failed.storageKey ? false : driver.exists(key);
      },
      read: async (key) => {
        assert.equal(userId, owners.get(key), "read stays inside the same owner scope");
        readOwners.add(userId);
        if (key === failed.storageKey) throw new StorageError("temporary read failure", "io_error");
        return driver.read(key);
      },
    }), async () => {
      const result = await reconcile();
      assert.equal(result.danglingDropped, 2);
      assert.equal(result.probeFailed, 1);
      for (const attachment of [failed, healthy, ...missing]) assert.ok(checked.has(attachment.storageKey));
      assert.deepEqual(readOwners, new Set([adminId, owner.id]));
      assert.ok(await attachmentMetadata(failed.id));
      assert.ok(await attachmentMetadata(healthy.id));
      for (const attachment of missing) assert.equal(await attachmentMetadata(attachment.id), undefined);
      assertProbeWarning(warn.mock.calls.map((call) => call.arguments[0]), failed, "io_error");
    });
  });

  for (const change of ["storage_key", "user_id", "removed"] as const) {
    it(`does not count or delete a row ${change === "removed" ? "removed" : `with changed ${change}`} during probing`, async () => {
      const attachment = await createProbeAttachment(`concurrent-${change}`);
      const user = change === "user_id" ? await createTestUser(db, "assets-probe-new-owner") : null;
      const replacementKey = `${attachment.storageKey}-replacement`;
      let read = false;
      try {
        await withStorageFacade((_userId, driver) => storageFacade(driver, {
          exists: (key) => key === attachment.storageKey ? Promise.resolve(false) : driver.exists(key),
          read: async (key) => {
            if (key !== attachment.storageKey) return driver.read(key);
            read = true;
            if (change === "removed") {
              await db.context().query("DELETE FROM assets.attachments WHERE id = $1", [attachment.id]);
            } else if (change === "storage_key") {
              await db.context().query("UPDATE assets.attachments SET storage_key = $2 WHERE id = $1", [attachment.id, replacementKey]);
            } else {
              await db.context().query("UPDATE assets.attachments SET user_id = $2 WHERE id = $1", [attachment.id, user!.id]);
            }
            throw new StorageError("old object is absent", "not_found");
          },
        }), async () => {
          const result = await reconcile();
          assert.ok(read, "mutation is injected between selection and conditional deletion");
          assert.equal(result.danglingDropped, 0, "count reflects actual DELETE rowCount");
          assert.equal(result.probeFailed, 0);
          const row = await attachmentMetadata(attachment.id);
          if (change === "removed") assert.equal(row, undefined);
          else {
            assert.ok(row, "the changed metadata row is retained");
            assert.equal(row.storage_key, change === "storage_key" ? replacementKey : attachment.storageKey);
            assert.equal(row.user_id, change === "user_id" ? user!.id : attachment.userId);
          }
        });
      } finally {
        await db.context().query("UPDATE assets.attachments SET storage_key = $2, user_id = $3 WHERE id = $1", [
          attachment.id, attachment.storageKey, attachment.userId,
        ]);
      }
    });
  }

  it("reports probe failures in the scheduled reconciliation summary", async (t) => {
    const attachment = await createProbeAttachment("scheduled-probe-failure");
    const info = t.mock.method(assetsContext.log, "info");
    const run = scheduledJobs.get("assets.storage_reconcile");
    assert.ok(run, "the production job callback was registered");
    await withStorageFacade((_userId, driver) => storageFacade(driver, {
      exists: (key) => key === attachment.storageKey ? Promise.resolve(false) : driver.exists(key),
      read: async (key) => {
        if (key === attachment.storageKey) throw new StorageError("scheduled read failed", "io_error");
        return driver.read(key);
      },
    }), async () => {
      await run();
      assert.ok(await attachmentMetadata(attachment.id));
      assert.ok(info.mock.calls.some((call) => {
        const fields = call.arguments[0] as { danglingDropped?: number; probeFailed?: number };
        return fields.danglingDropped === 0 && fields.probeFailed === 1;
      }), "a failure-only sweep is logged with probeFailed=1");
    });
  });
});
