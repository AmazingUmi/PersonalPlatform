import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { UUID } from "./snapshot-schema.js";

const HASH = /^[0-9a-f]{64}$/;

/** Content-addressed objects for one user. The pairing secret is not a cache key or file. */
export async function writeCachedObject(root: string, userId: string, sha256: string, bytes: Buffer): Promise<string> {
  assertIds(userId, sha256);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Cached object hash does not match its bytes.");
  const directory = await userDirectory(root, userId);
  const path = join(directory, sha256);
  await assertNotSymlink(path);
  try {
    const existing = await readFile(path);
    if (createHash("sha256").update(existing).digest("hex") === sha256) return path;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await assertNotSymlink(path);
    try {
      const existing = await readFile(path);
      if (createHash("sha256").update(existing).digest("hex") === sha256) {
        await unlink(temporary).catch(() => undefined);
        return path;
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return path;
}

export async function readCachedObject(root: string, userId: string, sha256: string): Promise<Buffer> {
  assertIds(userId, sha256);
  await assertNotSymlink(join(root, ".sync"));
  await assertNotSymlink(join(root, ".sync", userId));
  const path = join(root, ".sync", userId, sha256);
  await assertNotSymlink(path);
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Cached object hash does not match its bytes.");
  return bytes;
}

async function userDirectory(root: string, userId: string): Promise<string> {
  const syncDir = join(root, ".sync");
  const directory = join(syncDir, userId);
  await assertNotSymlink(syncDir);
  await assertNotSymlink(directory);
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  await assertNotSymlink(syncDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNotSymlink(directory);
  return directory;
}

async function assertNotSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Sync cache path must not be a symlink.");
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertIds(userId: string, sha256: string): void {
  if (!UUID.test(userId) || !HASH.test(sha256)) throw new Error("Invalid sync cache identity.");
}
