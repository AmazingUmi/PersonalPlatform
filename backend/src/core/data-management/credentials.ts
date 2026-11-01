import { constants } from "node:fs";
import { mkdir, open, lstat, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../api/errors.js";

/** The server key is intentionally outside exported data, in the persistent storage volume. */
export async function backupKey(storageRoot: string): Promise<Buffer> {
  const supplied = process.env.DATA_BACKUP_ENCRYPTION_KEY || undefined;
  if (supplied !== undefined) {
    const key = Buffer.from(supplied, "base64");
    if (key.length !== 32 || key.toString("base64") !== supplied) {
      throw new AppError(503, "backup_key_invalid", "DATA_BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    }
    return key;
  }
  const dir = join(storageRoot, ".core");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw new AppError(503, "backup_key_invalid", "Backup key directory must not be a symlink.");
  const path = join(dir, "backup.key");
  const staging = join(dir, `backup-key-${randomUUID()}.tmp`);
  // Publish only a complete key; concurrent first saves must never read a
  // partially-written final file or overwrite each other's encryption key.
  try {
    const file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(randomBytes(32)); await file.sync(); } finally { await file.close(); }
    await link(staging, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally { await unlink(staging).catch(() => undefined); }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== 32 || (info.mode & 0o077) !== 0) throw new Error("invalid key file");
    return await file.readFile();
  } catch {
    throw new AppError(503, "backup_key_invalid", "Backup key file is invalid; restore the original private key or reconfigure WebDAV.");
  } finally { await file.close(); }
}

export function encryptPassword(password: string, key: Buffer, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId));
  return Buffer.concat([iv, cipher.update(password, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

export function decryptPassword(value: string, key: Buffer, userId: string): string {
  try {
    const bytes = Buffer.from(value, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError(503, "backup_key_changed", "Cannot decrypt the saved WebDAV password. Restore the original key or save the password again.");
  }
}
