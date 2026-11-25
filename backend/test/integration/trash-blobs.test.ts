import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { Database, type DatabaseContext } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { createLogger } from "../../src/core/logging/index.js";
import { withAttachmentGuard } from "../../src/core/storage/attachment-guard.js";
import { listTrashReservedAssetKeys, TrashBlobStore, type TrashBlobScope } from "../../src/core/trash/blobs.js";
import type { TrashArchivedAttachment, TrashLiveAttachment } from "../../src/core/trash/types.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const log = createLogger("fatal");
let database: Database;
let storageRoot: string;

function path(userId: string, key: string) {
  return join(storageRoot, "users", userId, key);
}

async function put(filename: string, data: string) {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, data);
}

function storeClock() {
  let instant = Date.now();
  const makeStore = (ownerDb = database) => new TrashBlobStore({ database: ownerDb, storageRoot, log, now: () => new Date(instant) });
  return { makeStore, advance: (milliseconds: number) => { instant += milliseconds; } };
}

async function assetWithFiles(data: string[]): Promise<{
  scope: TrashBlobScope;
  itemId: string;
  files: TrashLiveAttachment[];
}> {
  const userId = randomUUID();
  const itemId = randomUUID();
  await database.query("INSERT INTO core.users (id, username, password_hash) VALUES ($1, $2, '!test')", [userId, `assets-${userId}`]);
  await database.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1, $2, 'Fixture asset')", [itemId, userId]);
  const files: TrashLiveAttachment[] = [];
  for (const contents of data) {
    const attachmentId = randomUUID();
    const storageKey = `sync/${randomUUID()}`;
    const size = Buffer.byteLength(contents);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await put(path(userId, `apps/assets/${storageKey}`), contents);
    await database.query(`
      INSERT INTO assets.attachments (id, user_id, item_id, storage_key, size, filename)
      VALUES ($1, $2, $3, $4, $5, 'fixture.bin')`, [attachmentId, userId, itemId, storageKey, size]);
    files.push({ attachmentId, storageKey, size, sha256 });
  }
  return { scope: { userId, appId: "assets", trashId: randomUUID() }, itemId, files };
}

async function insertArchive(tx: DatabaseContext, scope: TrashBlobScope, itemId: string, files: TrashArchivedAttachment[]) {
  await tx.query(`
    INSERT INTO core.trash_items (id, user_id, app_id, entity_type, entity_id, title, payload, attachment_keys,
                                  deleted_by_type, deleted_by_label, deleted_at, expires_at)
    VALUES ($1, $2, 'assets', 'asset_item', $3, 'Fixture asset', '{}', $4, 'user', 'Fixture', now(), now() + interval '30 days')`,
  [scope.trashId, scope.userId, itemId, JSON.stringify(files)]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}

async function connectionId(pool: Database): Promise<number> {
  return (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
}

async function waitForLock(pid: number, ...lockTypes: string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await database.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = ANY($2::text[]) AND NOT granted", [pid, lockTypes]);
    if (status.rowCount) return;
    await wait(10);
  }
  assert.fail(`connection ${pid} did not wait for ${lockTypes.join(" or ")}`);
}

function loseCommitAcknowledgement(outcome: "COMMIT" | "ROLLBACK", error: Error): Pick<Database, "getClient"> {
  return {
    async getClient() {
      const client = await database.getClient();
      return new Proxy(client, {
        get(target, property) {
          if (property === "release") return target.release.bind(target);
          if (property !== "query") return Reflect.get(target, property);
          return async (statement: string, args?: unknown[]) => {
            if (statement !== "COMMIT") return target.query(statement, args);
            await target.query(outcome);
            throw error;
          };
        },
      });
    },
  };
}

describe("Trash attachment staging and recovery", () => {
  before(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "pp-trash-blobs-"));
    await (await resetDatabase()).close();
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [
      { scope: "assets", schema: "assets", dir: join(repoRoot, "apps", "assets", "migrations") },
    ] });
    database = new Database(TEST_DATABASE_URL, log, { max: 1 });
  });

  after(async () => {
    await database?.close();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it("keeps staged bytes readable through committed delete and restore with fresh IDs", async () => {
    const contents = ["one fish", "two fish"];
    const { scope, itemId, files } = await assetWithFiles(contents);
    const { makeStore, advance } = storeClock();
    const store = makeStore();
    const intentId = (await withAttachmentGuard(database, "shared", (tx) => store.prepareDelete(tx, scope, files)))!;
    assert.equal(await store.recheckOutcome(intentId), "uncommitted");

    const archived = await withAttachmentGuard(database, "shared", async (tx) => {
      const intent = await store.lockIntent(tx, scope, intentId, "delete");
      const staged = await store.stageDelete(intent, files);
      await insertArchive(tx, scope, itemId, staged);
      await tx.query("DELETE FROM assets.items WHERE id = $1 AND user_id = $2", [itemId, scope.userId]);
      await store.settle(tx, intent);
      return staged;
    });
    assert.equal(await store.recheckOutcome(intentId), "committed");
    assert.deepEqual((await withAttachmentGuard(database, "exclusive", (tx) => listTrashReservedAssetKeys(tx, scope.userId))).sort(),
      files.map((file) => file.storageKey).sort());
    await makeStore().sweep();
    for (const [index, attachment] of archived.entries()) {
      assert.equal(await readFile(path(scope.userId, attachment.key), "utf8"), contents[index]);
      await assert.rejects(readFile(path(scope.userId, `apps/assets/${files[index]!.storageKey}`)), { code: "ENOENT" });
    }

    const restoredId = randomUUID();
    const restoreIntentId = (await withAttachmentGuard(database, "shared", (tx) => store.prepareRestore(tx, scope, archived, restoredId)))!;
    const restored = await withAttachmentGuard(database, "shared", async (tx) => {
      const intent = await store.lockIntent(tx, scope, restoreIntentId, "restore");
      const staged = await store.stageRestore(intent, archived);
      await tx.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'Fixture asset')", [restoredId, scope.userId]);
      for (const [index, file] of staged.entries()) {
        await tx.query(`
          INSERT INTO assets.attachments (id, user_id, item_id, storage_key, size, filename)
          VALUES ($1,$2,$3,$4,$5,'fixture.bin')`, [file.id, scope.userId, restoredId, file.storageKey, archived[index]!.size]);
      }
      await tx.query("DELETE FROM core.trash_items WHERE id = $1 AND user_id = $2", [scope.trashId, scope.userId]);
      await store.settle(tx, intent);
      return staged;
    });
    await makeStore().sweep();
    for (const [index, attachment] of restored.entries()) {
      assert.notEqual(attachment.id, attachment.attachmentId);
      assert.equal(attachment.storageKey, `attachments/${restoredId}/${attachment.id}`);
      assert.equal(await readFile(path(scope.userId, `apps/assets/${attachment.storageKey}`), "utf8"), contents[index]);
      await assert.rejects(readFile(path(scope.userId, archived[index]!.key)), { code: "ENOENT" });
    }
    advance(25 * 60 * 60_000);
    await makeStore().sweep();
    assert.equal(await store.recheckOutcome(restoreIntentId), "missing");
    await assert.rejects(readFile(path(scope.userId, `apps/assets/${restored[0]!.storageKey}.stage-${restoreIntentId}`)), { code: "ENOENT" });
    assert.equal(await readFile(path(scope.userId, `apps/assets/${restored[0]!.storageKey}`), "utf8"), contents[0]);
  });

  it("restarts after a partial copy and retains the live bytes and an existing destination", async () => {
    const { scope, files } = await assetWithFiles(["staged first", "live source retained"]);
    const { makeStore, advance } = storeClock();
    const store = makeStore();
    const intentId = (await withAttachmentGuard(database, "shared", (tx) => store.prepareDelete(tx, scope, files)))!;
    const firstKey = `trash/${scope.trashId}/${files[0]!.attachmentId}`;
    const secondKey = `trash/${scope.trashId}/${files[1]!.attachmentId}`;
    await put(path(scope.userId, secondKey), "existed before exclusive publish");

    await assert.rejects(withAttachmentGuard(database, "shared", async (tx) => {
      const intent = await store.lockIntent(tx, scope, intentId, "delete");
      await store.stageDelete(intent, files);
    }), { code: "EEXIST" });
    assert.equal(await store.recheckOutcome(intentId), "uncommitted");
    assert.equal(await readFile(path(scope.userId, firstKey), "utf8"), "staged first");
    advance(6 * 60_000);
    await makeStore().sweep();
    await assert.rejects(readFile(path(scope.userId, firstKey)), { code: "ENOENT" });
    await assert.rejects(readFile(path(scope.userId, `${secondKey}.stage-${intentId}`)), { code: "ENOENT" });
    assert.equal(await readFile(path(scope.userId, secondKey), "utf8"), "existed before exclusive publish");
    assert.equal(await readFile(path(scope.userId, `apps/assets/${files[1]!.storageKey}`), "utf8"), "live source retained");
    assert.equal(await store.recheckOutcome(intentId), "missing");
  });

  it("rechecks both possible outcomes after losing the final commit acknowledgement", async () => {
    for (const outcome of ["COMMIT", "ROLLBACK"] as const) {
      const { scope, itemId, files } = await assetWithFiles(["original bytes"]);
      const { makeStore, advance } = storeClock();
      const store = makeStore();
      const intentId = (await database.withTransaction((tx) => store.prepareDelete(tx, scope, files)))!;
      const source = path(scope.userId, `apps/assets/${files[0]!.storageKey}`);
      const destination = path(scope.userId, `trash/${scope.trashId}/${files[0]!.attachmentId}`);
      const lost = new Error("lost commit acknowledgement");
      const unreliable = loseCommitAcknowledgement(outcome, lost);
      await assert.rejects(withAttachmentGuard(unreliable, "shared", async (tx) => {
        const intent = await store.lockIntent(tx, scope, intentId, "delete");
        await insertArchive(tx, scope, itemId, await store.stageDelete(intent, files));
        await tx.query("DELETE FROM assets.items WHERE id = $1", [itemId]);
        await store.settle(tx, intent);
      }), (error) => error === lost);
      const committed = outcome === "COMMIT";
      assert.equal(await store.recheckOutcome(intentId), committed ? "committed" : "uncommitted");
      assert.equal(await readFile(source, "utf8"), "original bytes");
      assert.equal(await readFile(destination, "utf8"), "original bytes");
      advance(6 * 60_000);
      await makeStore().sweep();
      await assert.rejects(readFile(committed ? source : destination), { code: "ENOENT" });
      assert.equal(await readFile(committed ? destination : source, "utf8"), "original bytes");
    }
  });

  it("writes no staged files when the committed preparation acknowledgement is lost", async () => {
    const { scope, files } = await assetWithFiles(["the original"]);
    const { makeStore, advance } = storeClock();
    const store = makeStore();
    const lost = new Error("lost preparation acknowledgement");
    let intentId: string | undefined;
    await assert.rejects(withAttachmentGuard(loseCommitAcknowledgement("COMMIT", lost), "shared", async (tx) => {
      intentId = await store.prepareDelete(tx, scope, files);
    }), (error) => error === lost);
    assert.ok(intentId);
    assert.equal(await store.recheckOutcome(intentId), "uncommitted");
    await assert.rejects(readFile(path(scope.userId, `trash/${scope.trashId}/${files[0]!.attachmentId}`)), { code: "ENOENT" });
    advance(6 * 60_000);
    await makeStore().sweep();
    assert.equal(await store.recheckOutcome(intentId), "missing");
    assert.equal(await readFile(path(scope.userId, `apps/assets/${files[0]!.storageKey}`), "utf8"), "the original");
  });

  it("defers and retries a failed retirement while keeping the archive readable", async () => {
    const { scope, itemId, files } = await assetWithFiles(["archive survives"]);
    const { makeStore } = storeClock();
    const store = makeStore();
    const intentId = (await database.withTransaction((tx) => store.prepareDelete(tx, scope, files)))!;
    const archived = await withAttachmentGuard(database, "shared", async (tx) => {
      const intent = await store.lockIntent(tx, scope, intentId, "delete");
      const staged = await store.stageDelete(intent, files);
      await insertArchive(tx, scope, itemId, staged);
      await tx.query("DELETE FROM assets.items WHERE id = $1", [itemId]);
      await store.settle(tx, intent);
      return staged[0]!;
    });

    const source = path(scope.userId, `apps/assets/${files[0]!.storageKey}`);
    const other = path(scope.userId, "apps/assets/other.bin");
    await put(other, "another file");
    await rm(source);
    await symlink(other, source);
    await makeStore().sweep();
    const failed = await database.query(`SELECT attempts, last_error FROM core.trash_blob_cleanup WHERE user_id = $1`, [scope.userId]);
    assert.deepEqual(failed.rows, [{ attempts: 1, last_error: "Unsafe attachment object" }]);
    assert.equal(await readFile(path(scope.userId, archived.key), "utf8"), "archive survives");

    await rm(source);
    await put(source, "archive survives");
    await makeStore().sweep();
    assert.equal(await readFile(source, "utf8"), "archive survives");
    await database.query("UPDATE core.trash_blob_cleanup SET next_attempt_at = now() WHERE user_id = $1", [scope.userId]);
    await makeStore().sweep();
    await assert.rejects(readFile(source), { code: "ENOENT" });
    assert.equal(await readFile(other, "utf8"), "another file");
    assert.equal(await readFile(path(scope.userId, archived.key), "utf8"), "archive survives");
  });

  it("checks the source digest and refuses an in-tree symlink without writing staged files", async () => {
    const { scope, files } = await assetWithFiles(["correct"]);
    const store = storeClock().makeStore();
    const intentId = (await withAttachmentGuard(database, "shared", (tx) => store.prepareDelete(tx, scope, files)))!;
    const source = path(scope.userId, `apps/assets/${files[0]!.storageKey}`);
    const dest = path(scope.userId, `trash/${scope.trashId}/${files[0]!.attachmentId}`);
    await writeFile(source, "altered");
    const run = () => withAttachmentGuard(database, "shared", async (tx) => {
      const intent = await store.lockIntent(tx, scope, intentId, "delete");
      await store.stageDelete(intent, files);
    });
    await assert.rejects(run(), /bytes differ/);
    await assert.rejects(readFile(dest), { code: "ENOENT" });
    const realDir = path(scope.userId, "apps/assets/moved");
    await mkdir(realDir);
    await put(join(realDir, files[0]!.storageKey.split("/")[1]!), "correct");
    await rm(dirname(source), { recursive: true });
    await symlink(realDir, dirname(source));
    await assert.rejects(run(), /Unsafe attachment directory/);
    await assert.rejects(readFile(dest), { code: "ENOENT" });
  });

  it("reclaims a cascaded account's archived bytes and leaves another account's live bytes readable", async () => {
    const { scope, itemId, files } = await assetWithFiles(["archived bytes"]);
    const other = await assetWithFiles(["other owner"]);
    const { makeStore, advance } = storeClock();
    const store = makeStore();
    const intentId = (await withAttachmentGuard(database, "shared", (tx) => store.prepareDelete(tx, scope, files)))!;
    const archived = await withAttachmentGuard(database, "shared", async (tx) => {
      const intent = await store.lockIntent(tx, scope, intentId, "delete");
      const staged = await store.stageDelete(intent, files);
      await insertArchive(tx, scope, itemId, staged);
      await tx.query("DELETE FROM assets.items WHERE id = $1", [itemId]);
      await store.settle(tx, intent);
      return staged[0]!;
    });
    await database.query("DELETE FROM core.users WHERE id = $1", [scope.userId]);
    advance(1);
    await makeStore().sweep();
    await assert.rejects(readFile(path(scope.userId, archived.key)), { code: "ENOENT" });
    await assert.rejects(readFile(path(scope.userId, `${archived.key}.stage-${intentId}`)), { code: "ENOENT" });
    await assert.rejects(readFile(path(scope.userId, `apps/assets/${files[0]!.storageKey}`)), { code: "ENOENT" });
    assert.equal(await readFile(path(other.scope.userId, `apps/assets/${other.files[0]!.storageKey}`), "utf8"), "other owner");
  });

  it("keeps a staged restore past its recovery deadline while purge and cleanup wait", async () => {
    const { scope, itemId, files } = await assetWithFiles(["winning restore"]);
    const { makeStore, advance } = storeClock();
    const store = makeStore();
    const deleteIntent = (await withAttachmentGuard(database, "shared", (tx) => store.prepareDelete(tx, scope, files)))!;
    const archived = await withAttachmentGuard(database, "shared", async (tx) => {
      const intent = await store.lockIntent(tx, scope, deleteIntent, "delete");
      const staged = await store.stageDelete(intent, files);
      await insertArchive(tx, scope, itemId, staged);
      await tx.query("DELETE FROM assets.items WHERE id = $1 AND user_id = $2", [itemId, scope.userId]);
      await store.settle(tx, intent);
      return staged;
    });

    const restoredId = randomUUID();
    const restoreIntent = (await withAttachmentGuard(database, "shared", (tx) => store.prepareRestore(tx, scope, archived, restoredId)))!;
    const restorePool = new Database(TEST_DATABASE_URL, log, { max: 1 });
    const purgePool = new Database(TEST_DATABASE_URL, log, { max: 1 });
    const cleanupPool = new Database(TEST_DATABASE_URL, log, { max: 1 });
    const copied = deferred();
    const finishRestore = deferred();
    let stagedPath: string | undefined;
    let purged: Promise<number> | undefined;
    let swept: Promise<void> | undefined;
    const restored = withAttachmentGuard(restorePool, "shared", async (tx) => {
      const intent = await store.lockIntent(tx, scope, restoreIntent, "restore");
      const entry = await tx.query<{ attachment_keys: TrashArchivedAttachment[] }>(
        "SELECT attachment_keys FROM core.trash_items WHERE id = $1 AND user_id = $2 FOR UPDATE", [scope.trashId, scope.userId]);
      const [file] = await store.stageRestore(intent, entry.rows[0]!.attachment_keys);
      assert.ok(file);
      stagedPath = path(scope.userId, `apps/assets/${file.storageKey}`);
      copied.resolve();
      await finishRestore.promise;
      await tx.query("INSERT INTO assets.items (id, user_id, name) VALUES ($1,$2,'Fixture asset')", [restoredId, scope.userId]);
      await tx.query(`
        INSERT INTO assets.attachments (id, user_id, item_id, storage_key, size, filename)
        VALUES ($1,$2,$3,$4,$5,'fixture.bin')`, [file.id, scope.userId, restoredId, file.storageKey, archived[0]!.size]);
      await tx.query("DELETE FROM core.trash_items WHERE id = $1 AND user_id = $2", [scope.trashId, scope.userId]);
      await store.settle(tx, intent);
      return file;
    });
    try {
      await Promise.race([copied.promise, restored]);
      assert.ok(stagedPath);
      advance(6 * 60_000);
      const [purgePid, cleanupPid] = await Promise.all([connectionId(purgePool), connectionId(cleanupPool)]);
      purged = purgePool.withTransaction(async (tx) => {
        const entry = await tx.query("SELECT id FROM core.trash_items WHERE id = $1 AND user_id = $2 FOR UPDATE", [scope.trashId, scope.userId]);
        if (!entry.rowCount) return 0;
        return (await tx.query("DELETE FROM core.trash_items WHERE id = $1 AND user_id = $2", [scope.trashId, scope.userId])).rowCount ?? 0;
      });
      swept = makeStore(cleanupPool).sweep();
      await Promise.all([waitForLock(purgePid, "transactionid", "tuple"), waitForLock(cleanupPid, "advisory")]);
      assert.equal(await readFile(stagedPath, "utf8"), "winning restore");
      assert.equal(await readFile(path(scope.userId, archived[0]!.key), "utf8"), "winning restore");
      assert.equal((await database.query("SELECT id FROM assets.items WHERE id = $1", [restoredId])).rowCount, 0);

      finishRestore.resolve();
      const [file, purgedRows] = await Promise.all([restored, purged, swept]);
      assert.equal(purgedRows, 0);
      assert.equal(await store.recheckOutcome(restoreIntent), "committed");
      assert.deepEqual((await database.query("SELECT item_id, storage_key FROM assets.attachments WHERE id = $1", [file.id])).rows,
        [{ item_id: restoredId, storage_key: file.storageKey }]);
      assert.equal(await readFile(stagedPath, "utf8"), "winning restore");
      await assert.rejects(readFile(path(scope.userId, archived[0]!.key)), { code: "ENOENT" });
      await assert.rejects(readFile(`${stagedPath}.stage-${restoreIntent}`), { code: "ENOENT" });
    } finally {
      finishRestore.resolve();
      await Promise.allSettled([restored, purged, swept]);
      await Promise.all([restorePool.close(), purgePool.close(), cleanupPool.close()]);
    }
  });

  it("starts the repeatable snapshot before delete and defers file retirement until the reader finishes", async () => {
    const { scope, itemId, files } = await assetWithFiles(["complete bytes"]);
    const separatePool = new Database(TEST_DATABASE_URL, log, { max: 1 });
    const readerPool = new Database(TEST_DATABASE_URL, log, { max: 1 });
    const store = storeClock().makeStore(separatePool);
    const readerHasMetadata = deferred();
    const allowRead = deferred();
    const reader = withAttachmentGuard(readerPool, "shared", async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const { rows } = await tx.query<{ storage_key: string }>("SELECT storage_key FROM assets.attachments WHERE id = $1", [files[0]!.attachmentId]);
      readerHasMetadata.resolve();
      await allowRead.promise;
      return readFile(path(scope.userId, `apps/assets/${rows[0]!.storage_key}`), "utf8");
    });
    let retirement: Promise<void> | undefined;
    try {
      await Promise.race([readerHasMetadata.promise, reader]);
      const intentId = (await withAttachmentGuard(database, "shared", (tx) => store.prepareDelete(tx, scope, files)))!;
      await withAttachmentGuard(database, "shared", async (tx) => {
        const intent = await store.lockIntent(tx, scope, intentId, "delete");
        await insertArchive(tx, scope, itemId, await store.stageDelete(intent, files));
        await tx.query("DELETE FROM assets.items WHERE id = $1", [itemId]);
        await store.settle(tx, intent);
      });
      const cleanupPid = await connectionId(separatePool);
      retirement = store.sweep();
      await waitForLock(cleanupPid, "advisory");
      allowRead.resolve();
      assert.equal(await reader, "complete bytes");
      await retirement;
      await assert.rejects(readFile(path(scope.userId, `apps/assets/${files[0]!.storageKey}`)), { code: "ENOENT" });
    } finally {
      allowRead.resolve();
      await Promise.allSettled([reader, retirement]);
      await Promise.all([separatePool.close(), readerPool.close()]);
    }
  });
});
