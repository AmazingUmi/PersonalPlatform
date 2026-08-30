import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import assetsApp from "../../src/apps/assets/index.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
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
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

async function createItem(name: string): Promise<string> {
  const response = await platform.app.inject({
    method: "POST",
    url: "/api/apps/assets/items",
    payload: { name },
  });
  assert.equal(response.statusCode, 201);
  return response.json().id as string;
}

function upload(itemId: string, filename: string, data: Buffer | string, contentType?: string) {
  return platform.app.inject({
    method: "POST",
    url: `/api/apps/assets/items/${itemId}/attachments`,
    ...multipartBody([{ name: "file", filename, contentType, data }]),
  });
}

function attachmentFile(itemId: string, attachmentId: string): string {
  return join(root, "storage", "apps", "assets", "attachments", itemId, attachmentId);
}

async function reconcile(): Promise<{ queue: { processed: number; failed: number }; danglingDropped: number }> {
  const response = await platform.app.inject({ method: "POST", url: "/api/apps/assets/maintenance/reconcile" });
  assert.equal(response.statusCode, 200);
  return response.json();
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
      headers: { "content-type": "application/json" },
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
      assert.ok(!existsSync(join(root, "storage", "apps", "assets", job.storage_key)), "orphan file removed");
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
      `INSERT INTO assets.cleanup_jobs (id, kind, storage_key, reason)
       VALUES ('11111111-1111-4111-8111-111111111111', 'delete_storage', '../escape-attempt', 'test poison')`,
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
    const listed = await platform.app.inject({ method: "GET", url: "/api/apps/assets/maintenance/cleanup-jobs" });
    assert.equal(listed.statusCode, 200);
    const poison = listed.json().items.find((item: { id: string }) => item.id === "11111111-1111-4111-8111-111111111111");
    assert.equal(poison.status, "failed");

    // Storage root stayed intact (the traversal key deleted nothing real).
    assert.ok(existsSync(join(root, "storage", "apps", "assets", "attachments")));
  });
});
