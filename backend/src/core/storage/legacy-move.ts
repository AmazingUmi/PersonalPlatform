/**
 * One-time legacy storage relocation (AUTH-4, worklist amendment 1).
 *
 * Before multi-user, app files lived at `storage/apps/<appId>/…`; user data
 * now lives at `storage/users/<userId>/apps/<appId>/…`. This routine moves
 * every legacy file to the bootstrap owner's user-scoped root exactly once
 * (marker row in core.settings), BEFORE the platform activates — the assets
 * boot reconcile must never observe legacy-path files as "missing" and drop
 * their metadata.
 *
 * Failure semantics: any error propagates to the caller, which must refuse to
 * start (fatal). The routine is idempotent: a crash midway leaves the marker
 * unset, and the next run re-moves the remainder (per-file rename overwrites
 * existing targets, so partial state converges).
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Database } from "../database/index.js";
import type { Logger } from "../logging/index.js";

export const STORAGE_USERSCOPE_MARKER = "platform.storage.userscope.v1";

async function listFilesRecursively(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Move `storage/apps/<appId>/**` into `storage/users/<ownerId>/apps/<appId>/**`
 * for the single bootstrap owner. Returns how many files moved (0 on every
 * later boot). Throws on any filesystem or marker failure.
 */
export async function migrateLegacyAppStorage(options: {
  database: Database;
  storageRoot: string;
  log: Logger;
}): Promise<{ movedFiles: number }> {
  const { database, storageRoot, log } = options;
  const ctx = database.context();

  const marker = await ctx
    .query<{ value: unknown }>("SELECT value FROM core.settings WHERE key = $1", [
      STORAGE_USERSCOPE_MARKER,
    ])
    .catch(() => undefined);
  if (marker?.rows.length) return { movedFiles: 0 };

  const legacyAppsRoot = join(storageRoot, "apps");
  if (!existsSync(legacyAppsRoot)) {
    await setMarker(ctx);
    return { movedFiles: 0 };
  }

  const owner = await ctx.query<{ id: string }>(
    "SELECT id FROM core.users ORDER BY created_at, id LIMIT 1",
  );
  const ownerId = owner.rows[0]?.id;
  if (!ownerId) {
    throw new Error("legacy storage migration requires at least one core.users row (bootstrap first)");
  }

  const appDirs = (await readdir(legacyAppsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let movedFiles = 0;
  for (const appId of appDirs) {
    const legacyAppDir = join(legacyAppsRoot, appId);
    const userAppDir = join(storageRoot, "users", ownerId, "apps", appId);
    const files = await listFilesRecursively(legacyAppDir);
    for (const file of files) {
      const key = relative(legacyAppDir, file);
      const target = join(userAppDir, key);
      // POSIX rename replaces an existing target — a partial previous run
      // converges instead of failing.
      await mkdir(dirname(target), { recursive: true });
      await rename(file, target).catch(async (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EXDEV") {
          // Cross-device fallback (bind mounts, exotic volumes).
          const { copyFile, unlink } = await import("node:fs/promises");
          await copyFile(file, target);
          await unlink(file);
          return;
        }
        throw error;
      });
      movedFiles += 1;
    }
    // Remove the now-empty legacy tree for this app.
    await rm(legacyAppDir, { recursive: true, force: true });
  }
  // Drop the (now empty) legacy apps root so nothing regrows there.
  await rm(legacyAppsRoot, { recursive: true, force: true });

  await setMarker(ctx);
  if (movedFiles > 0) {
    log.info({ movedFiles, ownerId }, "legacy app storage moved to user-scoped roots");
  }
  return { movedFiles };
}

async function setMarker(ctx: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  await ctx.query(
    `INSERT INTO core.settings (key, value, updated_at)
     VALUES ($1, '"done"'::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [STORAGE_USERSCOPE_MARKER],
  );
}

/** Test/introspection helper: has the one-time relocation already run? */
export async function userScopeMigrationDone(
  ctx: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
): Promise<boolean> {
  const result = (await ctx.query("SELECT 1 FROM core.settings WHERE key = $1", [
    STORAGE_USERSCOPE_MARKER,
  ])) as { rows: unknown[] };
  return result.rows.length > 0;
}
