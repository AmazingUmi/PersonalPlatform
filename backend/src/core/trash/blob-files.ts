import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UUID } from "../data-management/snapshot-schema.js";
import { sanitizeKey } from "../storage/index.js";

export function assertOwnerKey(userId: string, key: string): void {
  if (!UUID.test(userId) || sanitizeKey(key) !== key || key.split("/").includes("")) {
    throw new Error("Invalid attachment storage locator");
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The operator's storage root may resolve through a symlink. Descendants may not. */
async function ownerPath(root: string, userId: string, key: string, createDirectories = false): Promise<string> {
  assertOwnerKey(userId, key);
  let directory = await realpath(root);
  const parts = ["users", userId, ...key.split("/")];
  const leaf = parts.pop()!;
  for (const part of parts) {
    const next = join(directory, part);
    const info = await lstat(next).catch((error: unknown) => {
      if (createDirectories && isMissing(error)) return undefined;
      throw error;
    });
    if (!info) {
      await mkdir(next, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(next)).isDirectory()) throw new Error("Unsafe attachment directory");
    } else if (!info.isDirectory()) {
      throw new Error("Unsafe attachment directory");
    }
    if (createDirectories) await syncDirectory(directory);
    directory = next;
  }
  return join(directory, leaf);
}

export interface BlobCopy {
  sourceKey: string;
  destinationKey: string;
  temporaryKey: string;
  size: number;
  sha256: string;
}

async function readVerified(path: string, { size, sha256 }: BlobCopy): Promise<Buffer> {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size !== size) throw new Error("Attachment size differs from its metadata");
    const data = await source.readFile();
    if (data.length !== size || createHash("sha256").update(data).digest("hex") !== sha256) {
      throw new Error("Attachment bytes differ from their recorded size or digest");
    }
    return data;
  } finally {
    await source.close();
  }
}

/** Reserve, copy, and publish with exclusive creation. Recovery owns any failed stage. */
export async function copyBlob(root: string, userId: string, file: BlobCopy): Promise<void> {
  const data = await readVerified(await ownerPath(root, userId, file.sourceKey), file);
  const destination = await ownerPath(root, userId, file.destinationKey, true);
  const temporary = await ownerPath(root, userId, file.temporaryKey);
  if (dirname(destination) !== dirname(temporary)) throw new Error("Invalid attachment staging directory");
  const staged = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await staged.writeFile(data);
    await staged.sync();
  } finally {
    await staged.close();
  }
  // Recovery must be able to prove ownership even if the process stops during publication.
  await syncDirectory(dirname(temporary));
  await link(temporary, destination);
  // Keep the temporary hard link until the intent is recovered. It proves
  // which destination this operation created if a later step rolls back.
  await syncDirectory(dirname(destination));
}

/** A failed exclusive publish must not reclaim a pre-existing destination. */
export async function removeCopiedDestination(root: string, userId: string, file: BlobCopy): Promise<void> {
  const objects = await Promise.all([file.temporaryKey, file.destinationKey].map(async (key) => {
    try {
      return await lstat(await ownerPath(root, userId, key), { bigint: true });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }));
  const [temporary, destination] = objects;
  if (temporary?.isFile() && destination?.isFile() && temporary.dev === destination.dev && temporary.ino === destination.ino) {
    await removeBlob(root, userId, file.destinationKey);
  }
}

/** Succeed on an absent key, and sync the directory before retiring its database job. */
export async function removeBlob(root: string, userId: string, key: string): Promise<void> {
  const path = await ownerPath(root, userId, key).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!path) return;
  const info = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (info && !info.isFile()) throw new Error("Unsafe attachment object");
  await unlink(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  await syncDirectory(dirname(path));
}
