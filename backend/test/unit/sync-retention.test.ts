import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pruneSyncLocalFiles, SYNC_RETENTION_MAX_BYTES, SYNC_RETENTION_MAX_FILES } from "../../src/core/data-management/sync-retention.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("pruneSyncLocalFiles", () => {
  let root: string;
  let outside: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "sync-retention-"));
    outside = mkdtempSync(join(tmpdir(), "sync-retention-out-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("exports a 64 MiB and 64 file default for each directory", () => {
    assert.equal(SYNC_RETENTION_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(SYNC_RETENTION_MAX_FILES, 64);
  });

  it("returns zeros when the cache and staging directories are absent", async () => {
    const counts = await pruneSyncLocalFiles({
      root: join(root, "missing-tree"),
      userId: USER,
      cacheHashes: new Set(),
      storageKeys: new Set(),
      maxBytes: 8,
      maxFiles: 1,
    });
    assert.deepEqual(counts, { cacheDeleted: 0, cacheDeletedBytes: 0, stagingDeleted: 0, stagingDeletedBytes: 0 });
  });

  it("keeps protected cache and staging names and drops older unreferenced files by count and bytes", async () => {
    const current = hash(1);
    const pending = hash(2);
    const conflict = hash(3);
    const newestOrphan = hash(4);
    const middle = hash(5);
    const oldest = hash(6);
    writeCache(root, USER, current, "cc", 10);
    writeCache(root, USER, pending, "pp", 20);
    writeCache(root, USER, conflict, "kk", 30);
    writeCache(root, USER, oldest, "o", 40);
    writeCache(root, USER, middle, "mm", 50);
    writeCache(root, USER, newestOrphan, "nnnn", 60);

    const keptStage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const newStage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const oldStage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    writeStage(root, USER, keptStage, "kept-stage", 10);
    writeStage(root, USER, oldStage, "old", 30);
    writeStage(root, USER, newStage, "new", 60);

    const counts = await pruneSyncLocalFiles({
      root,
      userId: USER,
      cacheHashes: new Set([current, pending, conflict]),
      storageKeys: new Set([`sync/${keptStage}`]),
      maxBytes: 4,
      maxFiles: 1,
    });

    assert.equal(counts.cacheDeleted, 2);
    assert.equal(counts.cacheDeletedBytes, 3);
    assert.equal(counts.stagingDeleted, 1);
    assert.equal(counts.stagingDeletedBytes, 3);
    assert.equal(await text(cachePath(root, USER, newestOrphan)), "nnnn");
    assert.equal(await text(cachePath(root, USER, current)), "cc");
    assert.equal(await text(cachePath(root, USER, pending)), "pp");
    assert.equal(await text(cachePath(root, USER, conflict)), "kk");
    await assert.rejects(readFile(cachePath(root, USER, middle)));
    await assert.rejects(readFile(cachePath(root, USER, oldest)));
    assert.equal(await text(stagePath(root, USER, keptStage)), "kept-stage");
    assert.equal(await text(stagePath(root, USER, newStage)), "new");
    await assert.rejects(readFile(stagePath(root, USER, oldStage)));
  });

  it("leaves another user, unknown names, and import files in place", async () => {
    const orphan = hash(7);
    writeCache(root, OTHER, orphan, "other-user", 1);
    const unknown = join(root, ".sync", USER, "not-a-hash");
    writeFileSync(unknown, "keep-unknown");
    const nested = join(root, ".sync", USER, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, hash(8)), "keep-nested");
    const imported = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const importDir = join(root, "users", USER, "apps", "assets", "imports");
    mkdirSync(importDir, { recursive: true });
    writeFileSync(join(importDir, imported), "keep-import");
    const weird = join(root, "users", USER, "apps", "assets", "sync", "notes.txt");
    writeFileSync(weird, "keep-notes");

    await pruneSyncLocalFiles({
      root,
      userId: USER,
      cacheHashes: new Set(),
      storageKeys: new Set(),
      maxBytes: 0,
      maxFiles: 0,
    });

    assert.equal(await text(cachePath(root, OTHER, orphan)), "other-user");
    assert.equal(await text(unknown), "keep-unknown");
    assert.equal(await text(join(nested, hash(8))), "keep-nested");
    assert.equal(await text(join(importDir, imported)), "keep-import");
    assert.equal(await text(weird), "keep-notes");
  });

  it("rejects a symlink below the storage root and leaves the outside target untouched", async () => {
    const survivor = hash(9);
    writeCache(root, USER, survivor, "stay", 70);
    const outsideFile = join(outside, "secret.bin");
    writeFileSync(outsideFile, "outside");
    const userApps = join(root, "users", USER, "apps");
    rmSync(userApps, { recursive: true, force: true });
    symlinkSync(outside, userApps);

    await assert.rejects(
      pruneSyncLocalFiles({
        root,
        userId: USER,
        cacheHashes: new Set(),
        storageKeys: new Set(),
        maxBytes: 0,
        maxFiles: 0,
      }),
      /Unsafe sync retention path/,
    );

    assert.equal(await text(outsideFile), "outside");
    assert.equal(await text(cachePath(root, USER, survivor)), "stay");
    const link = await lstat(userApps);
    assert.equal(link.isSymbolicLink(), true);
    rmSync(userApps, { force: true });
    mkdirSync(join(root, "users", USER, "apps", "assets", "sync"), { recursive: true });
  });
});

function hash(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function cachePath(root: string, userId: string, name: string): string {
  return join(root, ".sync", userId, name);
}

function stagePath(root: string, userId: string, name: string): string {
  return join(root, "users", userId, "apps", "assets", "sync", name);
}

function writeCache(root: string, userId: string, name: string, body: string, seconds: number): void {
  const path = cachePath(root, userId, name);
  mkdirSync(join(root, ".sync", userId), { recursive: true });
  writeFileSync(path, body);
  const when = new Date(seconds * 1000);
  utimesSync(path, when, when);
}

function writeStage(root: string, userId: string, name: string, body: string, seconds: number): void {
  const path = stagePath(root, userId, name);
  mkdirSync(join(root, "users", userId, "apps", "assets", "sync"), { recursive: true });
  writeFileSync(path, body);
  const when = new Date(seconds * 1000);
  utimesSync(path, when, when);
}

async function text(path: string): Promise<string> {
  return (await readFile(path)).toString("utf8");
}
