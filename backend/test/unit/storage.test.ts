import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLocalStorage } from "../../src/core/storage/local.js";
import { sanitizeKey, StorageError, type Storage } from "../../src/core/storage/index.js";

function isStorageErrorWithCode(error: unknown, code: StorageError["code"]): boolean {
  return error instanceof StorageError && error.code === code;
}

/** Each test gets an isolated temp dir so cases never share state. */
async function withStorage(run: (root: string, storage: Storage) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pp-storage-unit-"));
  const storage = createLocalStorage(root);
  try {
    await run(root, storage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("sanitizeKey", () => {
  it("rejects an empty key", () => {
    assert.throws(
      () => sanitizeKey(""),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
  });

  it("rejects keys containing a null byte", () => {
    assert.throws(
      () => sanitizeKey("a\0b"),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
  });

  it("rejects keys with `..` traversal segments", () => {
    assert.throws(
      () => sanitizeKey("../etc/passwd"),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
    assert.throws(
      () => sanitizeKey("a/../b"),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
    assert.throws(
      () => sanitizeKey("a/b/.."),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
  });

  it("rejects keys with `.` segments", () => {
    assert.throws(
      () => sanitizeKey("./a"),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
    assert.throws(
      () => sanitizeKey("a/./b"),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
  });

  it("normalizes backslashes to forward slashes before validating", () => {
    assert.equal(sanitizeKey("a\\b.txt"), "a/b.txt");
    assert.equal(sanitizeKey("dir\\sub\\file.txt"), "dir/sub/file.txt");
    // Windows-style traversal must be caught after normalization.
    assert.throws(
      () => sanitizeKey("a\\..\\b"),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
  });

  it("rejects keys with a leading slash (absolute paths)", () => {
    // The implementation rejects absolute keys instead of stripping the slash.
    assert.throws(
      () => sanitizeKey("/abs/path.txt"),
      (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
    );
  });

  it("returns valid keys unchanged", () => {
    assert.equal(sanitizeKey("a/b.txt"), "a/b.txt");
    assert.equal(sanitizeKey("file.txt"), "file.txt");
    assert.equal(sanitizeKey("dir/sub/deep/name.bin"), "dir/sub/deep/name.bin");
  });
});

describe("LocalStorageDriver", () => {
  it("round-trips save/read with Buffer and string payloads", async () => {
    await withStorage(async (_root, storage) => {
      await storage.save("text/hello.txt", "hello world");
      const text = await storage.read("text/hello.txt");
      assert.equal(text.toString(), "hello world");

      const binary = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
      await storage.save("blob/data.bin", binary);
      const blob = await storage.read("blob/data.bin");
      assert.ok(blob.equals(binary), "binary round-trip must preserve bytes");
    });
  });

  it("rejects read of a missing object with StorageError not_found", async () => {
    await withStorage(async (_root, storage) => {
      await assert.rejects(
        storage.read("missing.txt"),
        (error: unknown) => isStorageErrorWithCode(error, "not_found"),
      );
    });
  });

  it("delete is idempotent: deleting a missing object does not throw", async () => {
    await withStorage(async (_root, storage) => {
      await storage.save("doomed.txt", "bye");
      await storage.delete("doomed.txt");
      await assert.rejects(
        storage.read("doomed.txt"),
        (error: unknown) => isStorageErrorWithCode(error, "not_found"),
      );
      // Already-deleted and never-existing keys are both no-ops.
      await storage.delete("doomed.txt");
      await storage.delete("never-existed.txt");
    });
  });

  it("list returns relative, sorted keys including subdirectories", async () => {
    await withStorage(async (_root, storage) => {
      await storage.save("b.txt", "b");
      await storage.save("a/c.txt", "c");
      await storage.save("a/d/e.txt", "e");
      assert.deepEqual(await storage.list(), ["a/c.txt", "a/d/e.txt", "b.txt"]);
      assert.deepEqual(await storage.list("a"), ["a/c.txt", "a/d/e.txt"]);
      assert.deepEqual(await storage.list("a/d"), ["a/d/e.txt"]);
    });
  });

  it("save creates nested directories automatically", async () => {
    await withStorage(async (_root, storage) => {
      await storage.save("x/y/z.txt", "nested");
      assert.equal((await storage.read("x/y/z.txt")).toString(), "nested");
    });
  });

  it("read through a symlink that escapes the root is rejected", async () => {
    await withStorage(async (root, storage) => {
      const outside = mkdtempSync(join(tmpdir(), "pp-storage-outside-"));
      try {
        writeFileSync(join(outside, "secret.txt"), "secret");
        symlinkSync(outside, join(root, "link"));
        await assert.rejects(
          storage.read("link/secret.txt"),
          (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
        );
        // Writes through the same escape hatch are rejected too.
        await assert.rejects(
          storage.save("link/planted.txt", "x"),
          (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("save with a `..` key is rejected as invalid_path", async () => {
    await withStorage(async (_root, storage) => {
      await assert.rejects(
        storage.save("a/../b", "x"),
        (error: unknown) => isStorageErrorWithCode(error, "invalid_path"),
      );
    });
  });
});
