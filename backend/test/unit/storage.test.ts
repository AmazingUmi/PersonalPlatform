import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { LocalStorageDriver } from "../../src/core/storage/local.js";
import { sanitizeKey, StorageError, type Storage } from "../../src/core/storage/index.js";

let root: string;
let storage: Storage;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pp-storage-"));
  storage = new LocalStorageDriver(root);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sanitizeKey", () => {
  it("rejects traversal and absolute paths", () => {
    assert.throws(() => sanitizeKey("../etc/passwd"), StorageError);
    assert.throws(() => sanitizeKey("a/../../b"), StorageError);
    assert.throws(() => sanitizeKey("/abs/path"), StorageError);
    assert.throws(() => sanitizeKey("a\\..\\b"), StorageError);
    assert.throws(() => sanitizeKey(""), StorageError);
  });

  it("normalizes backslashes", () => {
    assert.equal(sanitizeKey("a/b"), "a/b");
    assert.equal(sanitizeKey("a\\b"), "a/b");
  });
});

describe("LocalStorageDriver", () => {
  it("round-trips save/read/delete/list", async () => {
    await storage.save("dir/file.txt", "hello");
    assert.equal((await storage.read("dir/file.txt")).toString(), "hello");
    const listed = await storage.list();
    assert.deepEqual(listed, ["dir/file.txt"]);
    await storage.delete("dir/file.txt");
    await assert.rejects(storage.read("dir/file.txt"), StorageError);
  });

  it("rejects writes that escape the root", async () => {
    await assert.rejects(storage.save("../escape.txt", "x"), StorageError);
    await assert.rejects(storage.save("/abs.txt", "x"), StorageError);
  });

  it("rejects symlink escapes", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pp-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(root, "link"));
      await assert.rejects(storage.save("link/secret.txt", "x"), StorageError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
