import { mkdir, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sanitizeKey, StorageError, type Storage } from "./index.js";

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

  /** Reject symlink escapes by resolving the nearest existing ancestor. */
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
        return;
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
      } else if (entry.isSymbolicLink()) {
        const targetStat = await stat(full).catch(() => undefined);
        if (targetStat?.isDirectory()) {
          await this.walk(full, results);
        } else if (targetStat?.isFile()) {
          results.push(relative(this.rootDir, full).split(sep).join("/"));
        }
      }
    }
  }
}

export function createLocalStorage(appRoot: string): Storage {
  return new LocalStorageDriver(appRoot);
}
