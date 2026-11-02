import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { UUID } from "./snapshot-schema.js";

const HASH = /^[0-9a-f]{64}$/;

/**
 * Newest unreferenced objects kept in each local directory.
 * This is the retention grace: a lost commit's objects stay until a later
 * completed cycle, bounded by these caps. There is no clock-based grace.
 * Referenced names are never counted against the caps and are never deleted.
 */
export const SYNC_RETENTION_MAX_BYTES = 64 * 1024 * 1024;
export const SYNC_RETENTION_MAX_FILES = 64;

export interface PruneSyncLocalFilesInput {
  root: string;
  userId: string;
  /** Current head, pending head, and open-conflict attachment hashes. */
  cacheHashes: ReadonlySet<string>;
  /** Current user's attachment storage keys (`sync/<uuid>`). */
  storageKeys: ReadonlySet<string>;
  /** Test override. Defaults to {@link SYNC_RETENTION_MAX_BYTES}. */
  maxBytes?: number;
  /** Test override. Defaults to {@link SYNC_RETENTION_MAX_FILES}. */
  maxFiles?: number;
}

export interface PruneSyncLocalCounts {
  cacheDeleted: number;
  cacheDeletedBytes: number;
  stagingDeleted: number;
  stagingDeletedBytes: number;
}

/**
 * Bound one user's local sync cache and sync staging directory.
 *
 * Caller preconditions (not checked here):
 * - the caller holds the current user's binding lease;
 * - a validated sync cycle has completed;
 * - no publication is ambiguously pending;
 * - `cacheHashes` includes every current head, pending head, and open conflict;
 * - `storageKeys` includes every current-user attachment storage key.
 *
 * Deletes only regular files whose names are a sha256 hex digest (cache) or a
 * UUID (staging) and that are absent from those sets. Never issues a remote
 * delete. The operator storage root may be a symlink; nothing below it is followed.
 */
export async function pruneSyncLocalFiles(input: PruneSyncLocalFilesInput): Promise<PruneSyncLocalCounts> {
  const maxBytes = limit(input.maxBytes, SYNC_RETENTION_MAX_BYTES);
  const maxFiles = limit(input.maxFiles, SYNC_RETENTION_MAX_FILES);
  if (!UUID.test(input.userId)) throw new Error("Invalid sync retention identity.");

  const cacheDir = await safeDirectory(input.root, [".sync", input.userId]);
  const stagingDir = await safeDirectory(input.root, ["users", input.userId, "apps", "assets", "sync"]);
  const cachePlan = cacheDir ? await plan(cacheDir, HASH, (name) => input.cacheHashes.has(name), maxBytes, maxFiles) : emptyPlan();
  const stagingPlan = stagingDir
    ? await plan(stagingDir, UUID, (name) => input.storageKeys.has(`sync/${name}`), maxBytes, maxFiles)
    : emptyPlan();

  const cache = await remove(cachePlan);
  const staging = await remove(stagingPlan);
  return {
    cacheDeleted: cache.deleted,
    cacheDeletedBytes: cache.bytes,
    stagingDeleted: staging.deleted,
    stagingDeletedBytes: staging.bytes,
  };
}

interface Candidate {
  path: string;
  bytes: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

function limit(value: number | undefined, fallback: number): number {
  const chosen = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(chosen) || chosen < 0) throw new Error("Invalid sync retention limit.");
  return chosen;
}

function emptyPlan(): Candidate[] {
  return [];
}

async function safeDirectory(root: string, parts: string[]): Promise<string | undefined> {
  let current = resolve(root);
  let info = await lstat(current).catch(missing);
  if (!info) return undefined;
  if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error("Unsafe sync retention path.");
  let rootReal: string;
  try {
    rootReal = await realpath(current);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  for (const part of parts) {
    if (part.length === 0 || part === "." || part === ".." || part.includes("/") || part.includes("\\")) {
      throw new Error("Unsafe sync retention path.");
    }
    current = join(current, part);
    info = await lstat(current).catch(missing);
    if (!info) return undefined;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unsafe sync retention path.");
    let real: string;
    try {
      real = await realpath(current);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
    const rel = relative(rootReal, real);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe sync retention path.");
  }
  return current;
}

async function plan(
  directory: string,
  namePattern: RegExp,
  protectedName: (name: string) => boolean,
  maxBytes: number,
  maxFiles: number,
): Promise<Candidate[]> {
  const again = await lstat(directory);
  if (again.isSymbolicLink() || !again.isDirectory()) throw new Error("Unsafe sync retention path.");
  const entries = await readdir(directory, { withFileTypes: true });
  const victims: Candidate[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    if (!namePattern.test(entry.name)) continue;
    if (protectedName(entry.name)) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) continue;
    victims.push({ path, bytes: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev });
  }
  victims.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const doomed: Candidate[] = [];
  let kept = 0;
  let keptBytes = 0;
  for (const candidate of victims) {
    if (kept < maxFiles && keptBytes + candidate.bytes <= maxBytes) {
      kept += 1;
      keptBytes += candidate.bytes;
    } else {
      doomed.push(candidate);
    }
  }
  return doomed;
}

async function remove(candidates: Candidate[]): Promise<{ deleted: number; bytes: number }> {
  let deleted = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    const info = await lstat(candidate.path).catch(missing);
    if (!info || info.isSymbolicLink() || !info.isFile()) continue;
    if (info.ino !== candidate.ino || info.dev !== candidate.dev) continue;
    const handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== candidate.ino || opened.dev !== candidate.dev) continue;
    } finally {
      await handle.close();
    }
    const confirmed = await lstat(candidate.path).catch(missing);
    if (!confirmed || confirmed.isSymbolicLink() || !confirmed.isFile()) continue;
    if (confirmed.ino !== candidate.ino || confirmed.dev !== candidate.dev) continue;
    await unlink(candidate.path);
    deleted += 1;
    bytes += candidate.bytes;
  }
  return { deleted, bytes };
}

function missing(error: unknown): undefined {
  if (isEnoent(error)) return undefined;
  throw error;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
