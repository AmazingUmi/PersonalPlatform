import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sanitizeKey, StorageError, type AppStorage, type Storage } from "./index.js";

function toError(error: unknown): never {
  if (error instanceof StorageError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new StorageError("object not found", "not_found");
  throw new StorageError(`storage io error: ${String(error)}`, "io_error");
}

/**
 * Local filesystem driver. The driver is scoped to a single app root and
 * rejects `..`, absolute paths and symlink escapes.
 */
export class LocalStorageDriver implements Storage {
  constructor(private readonly rootDir: string) {}

  private resolveKey(key: string): string {
    const normalized = sanitizeKey(key);
    const full = resolve(this.rootDir, normalized);
    const relativePath = relative(this.rootDir, full);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new StorageError("path escapes the storage root", "invalid_path");
    }
    return full;
  }

  /**
   * Reject symlink escapes by resolving the nearest existing ancestor
   * (AUTH-H1-06), then require that the final path component itself is not a
   * symlink — readFile/writeFile/rm/stat would otherwise follow a symlink
   * planted as the object. The storage root as configured is exempt: it is
   * operator-provided and realpath'd here once.
   */
  private async assertWithinRoot(fullPath: string): Promise<void> {
    let rootReal: string;
    try {
      rootReal = await realpath(this.rootDir);
    } catch {
      return; // root not created yet; write() will create it
    }

    let dir = dirname(fullPath);
    for (let i = 0; i < 64; i += 1) {
      try {
        const real = await realpath(dir);
        const rel = relative(rootReal, real);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new StorageError("path escapes the storage root", "invalid_path");
        }
        break;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          const parent = dirname(dir);
          if (parent === dir) return;
          dir = parent;
          continue;
        }
        return;
      }
    }

    if (fullPath !== this.rootDir) {
      const info = await lstat(fullPath).catch(() => undefined);
      if (info?.isSymbolicLink()) {
        throw new StorageError("symlink at storage path is not allowed", "invalid_path");
      }
    }
  }

  async save(key: string, data: Buffer | Uint8Array | string): Promise<void> {
    const fullPath = this.resolveKey(key);
    await this.assertWithinRoot(fullPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data).catch(toError);
  }

  async read(key: string): Promise<Buffer> {
    const fullPath = this.resolveKey(key);
    await this.assertWithinRoot(fullPath);
    try {
      return await readFile(fullPath);
    } catch (error) {
      throw toError(error);
    }
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.resolveKey(key);
    await this.assertWithinRoot(fullPath);
    await rm(fullPath, { force: true }).catch(toError);
  }

  async list(prefix = ""): Promise<string[]> {
    const normalizedPrefix = prefix === "" ? prefix : sanitizeKey(prefix);
    const base = resolve(this.rootDir, normalizedPrefix);
    // The prefix path gets the same symlink validation as object keys; the
    // bare root is the trusted boundary itself (AUTH-H1-06).
    if (base !== this.rootDir) await this.assertWithinRoot(base);
    const results: string[] = [];
    await this.walk(base, results);
    return results.sort();
  }

  async exists(key: string): Promise<boolean> {
    try {
      const fullPath = this.resolveKey(key);
      await this.assertWithinRoot(fullPath);
      const info = await stat(fullPath);
      return info.isFile();
    } catch {
      return false;
    }
  }

  private async walk(dir: string, results: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await toError(error);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, results);
      } else if (entry.isFile()) {
        results.push(relative(this.rootDir, full).split(sep).join("/"));
      }
      // Symlinked entries are neither traversed nor listed (AUTH-H1-06): a
      // linked directory could lead outside the root, and a linked file is
      // not an object this driver owns. readdir's Dirent does not follow
      // symlinks, so isDirectory()/isFile() already exclude them.
    }
  }
}

export function createLocalStorage(appRoot: string): Storage {
  return new LocalStorageDriver(appRoot);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The app's storage surface (AUTH-2): `storage/apps/<appId>` as the app root
 * and `storage/users/<userId>/apps/<appId>` for user-owned data. The userId
 * is uuid-validated before it can influence any path.
 */
export function createAppStorage(storageRoot: string, appId: string): AppStorage {
  const appDriver = new LocalStorageDriver(join(storageRoot, "apps", appId));
  return {
    save: (key, data) => appDriver.save(key, data),
    read: (key) => appDriver.read(key),
    delete: (key) => appDriver.delete(key),
    list: (prefix) => appDriver.list(prefix),
    exists: (key) => appDriver.exists(key),
    forUser(userId: string): Storage {
      if (typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
        throw new StorageError("user id must be a uuid", "invalid_path");
      }
      return createLocalStorage(join(storageRoot, "users", userId, "apps", appId));
    },
  };
}
