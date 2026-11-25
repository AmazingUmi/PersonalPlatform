import { randomUUID } from "node:crypto";
import { AppError } from "../api/errors.js";
import { UUID } from "../data-management/snapshot-schema.js";
import type { Database, DatabaseContext } from "../database/index.js";
import type { Logger } from "../logging/index.js";
import { withAttachmentGuard } from "../storage/attachment-guard.js";
import { assertOwnerKey, copyBlob, removeBlob, removeCopiedDestination, type BlobCopy } from "./blob-files.js";
import type { TrashArchivedAttachment, TrashLiveAttachment, TrashRestoredAttachment } from "./types.js";

const ASSETS_PREFIX = "apps/assets/";
const INTENT_LIFETIME_MS = 5 * 60_000;
const COMMITTED_INTENT_LIFETIME_MS = 24 * 60 * 60_000;
const INTENT_RETRY_MS = 60_000;
const SWEEP_BATCH_SIZE = 16;
const HASH = /^[0-9a-f]{64}$/;

export interface TrashBlobScope {
  userId: string;
  appId: string;
  trashId: string;
}

export type TrashBlobOperation = "delete" | "restore";
export type TrashBlobOutcome = "committed" | "uncommitted" | "missing";

interface IntentFile extends BlobCopy {
  attachmentId: string;
}

const intentLock = Symbol("locked Trash attachment intent");
export interface LockedBlobIntent {
  readonly [intentLock]: true;
  readonly id: string;
  readonly scope: TrashBlobScope;
  readonly operation: TrashBlobOperation;
  readonly files: readonly IntentFile[];
}

interface IntentRow {
  id: string;
  user_id: string;
  app_id: string;
  trash_id: string;
  operation: TrashBlobOperation;
  files: IntentFile[];
  created_at: Date;
  abandon_after: Date;
  committed_at: Date | null;
}

interface CleanupRow {
  user_id: string;
  app_id: string;
  trash_id: string;
  kind: "trash" | "live";
  storage_key: string;
  attempts: number;
}

interface BlobStoreOptions {
  database: Database;
  storageRoot: string;
  log: Logger;
  now?: () => Date;
}

function trashKey(trashId: string, attachmentId: string): string {
  return `trash/${trashId}/${attachmentId}`;
}

function temporaryKey(destinationKey: string, intentId: string): string {
  return `${destinationKey}.stage-${intentId}`;
}

function liveKey(storageKey: string): string {
  return ASSETS_PREFIX + storageKey;
}

function scopeOf(row: IntentRow): TrashBlobScope {
  return { userId: row.user_id, appId: row.app_id, trashId: row.trash_id };
}

function assertScope(scope: TrashBlobScope): void {
  // Assets is the only attachment-owning App covered by Unified Trash.
  if (scope.appId !== "assets" || !UUID.test(scope.userId) || !UUID.test(scope.trashId)) {
    throw new Error("Invalid Trash attachment scope");
  }
}

function assertRestoreKey(key: string): void {
  const parts = key.slice(ASSETS_PREFIX.length).split("/");
  if (!key.startsWith(ASSETS_PREFIX) || parts.length !== 3 || parts[0] !== "attachments" ||
      !UUID.test(parts[1]!) || !UUID.test(parts[2]!)) {
    throw new Error("Invalid live restore locator");
  }
}

function assertIntentFiles(scope: TrashBlobScope, id: string, operation: TrashBlobOperation, files: readonly IntentFile[]): void {
  assertScope(scope);
  if (!UUID.test(id) || !Array.isArray(files) || files.length === 0) throw new Error("Invalid Trash attachment intent");
  const archivedIds = new Set<string>();
  const destinations = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.attachmentId !== "string" || !UUID.test(file.attachmentId) ||
        typeof file.sha256 !== "string" || !HASH.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error("Invalid Trash attachment proof");
    }
    assertOwnerKey(scope.userId, file.sourceKey);
    assertOwnerKey(scope.userId, file.destinationKey);
    assertOwnerKey(scope.userId, file.temporaryKey);
    const archiveKey = trashKey(scope.trashId, file.attachmentId);
    if (file.temporaryKey !== temporaryKey(file.destinationKey, id) ||
        archivedIds.has(file.attachmentId) || destinations.has(file.destinationKey)) {
      throw new Error("Inconsistent Trash attachment staging locator");
    }
    archivedIds.add(file.attachmentId);
    destinations.add(file.destinationKey);
    if (operation === "delete") {
      if (!file.sourceKey.startsWith(ASSETS_PREFIX) || file.destinationKey !== archiveKey) {
        throw new Error("Invalid live-to-Trash attachment locator");
      }
    } else {
      if (file.sourceKey !== archiveKey) throw new Error("Invalid Trash restore source locator");
      assertRestoreKey(file.destinationKey);
    }
  }
}

function sourceChanged(): AppError {
  return new AppError(409, "trash_source_changed", "The attachments changed. Reload and retry.");
}

function compareSourceProof(intent: LockedBlobIntent, operation: TrashBlobOperation, actualFiles: readonly TrashArchivedAttachment[]): void {
  if (intent.operation !== operation || intent.files.length !== actualFiles.length) throw sourceChanged();
  const actual = new Map(actualFiles.map((file) => [file.attachmentId, file]));
  for (const expected of intent.files) {
    const file = actual.get(expected.attachmentId);
    if (!file || file.key !== expected.sourceKey || file.size !== expected.size || file.sha256 !== expected.sha256) {
      throw sourceChanged();
    }
  }
}

async function pendingKeys(tx: DatabaseContext, userId: string, exceptId?: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ storage_key: string }>(`
    SELECT DISTINCT key.value AS storage_key
    FROM core.trash_blob_intents intent
    CROSS JOIN LATERAL jsonb_array_elements(intent.files) AS part(file)
    CROSS JOIN LATERAL (VALUES (part.file->>'sourceKey'), (part.file->>'destinationKey'), (part.file->>'temporaryKey')) AS key(value)
    WHERE intent.user_id = $1 AND intent.committed_at IS NULL AND intent.id IS DISTINCT FROM $2::uuid
      AND key.value IS NOT NULL`, [userId, exceptId ?? null]);
  return new Set(rows.map((row) => row.storage_key));
}

/** User-App-relative keys to retain during sync pruning. Call under the exclusive attachment guard. */
export async function listTrashReservedAssetKeys(tx: DatabaseContext, userId: string): Promise<string[]> {
  const reserved = await pendingKeys(tx, userId);
  const { rows } = await tx.query<{ storage_key: string }>(`
    SELECT storage_key FROM core.trash_blob_cleanup WHERE user_id = $1 AND kind = 'live'`, [userId]);
  for (const row of rows) reserved.add(row.storage_key);
  return [...reserved].filter((key) => key.startsWith(ASSETS_PREFIX)).map((key) => key.slice(ASSETS_PREFIX.length));
}

async function assetReferenceExists(tx: DatabaseContext, userId: string, storageKey: string): Promise<boolean> {
  const catalog = await tx.query<{ attachments: string | null }>("SELECT to_regclass('assets.attachments') AS attachments");
  if (!catalog.rows[0]?.attachments) return false;
  const result = await tx.query("SELECT 1 FROM assets.attachments WHERE user_id = $1 AND storage_key = $2 LIMIT 1", [userId, storageKey]);
  return Boolean(result.rowCount);
}

/** Guarded legacy unlinkers must leave files reserved by Trash to Core recovery. */
export async function canRetireLiveAssetAttachment(tx: DatabaseContext, userId: string, storageKey: string): Promise<boolean> {
  assertOwnerKey(userId, liveKey(storageKey));
  if (await assetReferenceExists(tx, userId, storageKey)) return false;
  return !(await listTrashReservedAssetKeys(tx, userId)).includes(storageKey);
}

async function committedReferenceExists(tx: DatabaseContext, userId: string, key: string): Promise<boolean> {
  if (key.startsWith(ASSETS_PREFIX)) return assetReferenceExists(tx, userId, key.slice(ASSETS_PREFIX.length));
  const result = await tx.query(`
    SELECT 1 FROM core.trash_items
    WHERE user_id = $1 AND id = $2 AND attachment_keys @> jsonb_build_array(jsonb_build_object('key', $3::text))`,
  [userId, key.split("/")[1], key]);
  return Boolean(result.rowCount);
}

export class TrashBlobStore {
  constructor(private readonly options: BlobStoreOptions) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  async prepareDelete(tx: DatabaseContext, scope: TrashBlobScope, files: readonly TrashLiveAttachment[]): Promise<string | undefined> {
    if (files.length === 0) return undefined;
    const id = randomUUID();
    const staged = files.map(({ attachmentId, storageKey, size, sha256 }) => {
      const destinationKey = trashKey(scope.trashId, attachmentId);
      return { attachmentId, sourceKey: liveKey(storageKey), destinationKey, temporaryKey: temporaryKey(destinationKey, id), size, sha256 };
    });
    await this.prepare(tx, scope, id, "delete", staged);
    return id;
  }

  async prepareRestore(tx: DatabaseContext, scope: TrashBlobScope, files: readonly TrashArchivedAttachment[], restoredId: string): Promise<string | undefined> {
    if (files.length === 0) return undefined;
    const id = randomUUID();
    const staged = files.map(({ attachmentId, key, size, sha256 }) => {
      const destinationKey = liveKey(`attachments/${restoredId}/${randomUUID()}`);
      return { attachmentId, sourceKey: key, destinationKey, temporaryKey: temporaryKey(destinationKey, id), size, sha256 };
    });
    await this.prepare(tx, scope, id, "restore", staged);
    return id;
  }

  private async prepare(tx: DatabaseContext, scope: TrashBlobScope, id: string, operation: TrashBlobOperation, files: IntentFile[]): Promise<void> {
    assertIntentFiles(scope, id, operation, files);
    const now = this.now();
    await tx.query(`
      INSERT INTO core.trash_blob_intents (id, user_id, app_id, trash_id, operation, files, created_at, abandon_after)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [id, scope.userId, scope.appId, scope.trashId, operation, JSON.stringify(files), now, new Date(now.getTime() + INTENT_LIFETIME_MS)]);
  }

  async lockIntent(tx: DatabaseContext, scope: TrashBlobScope, intentId: string, operation: TrashBlobOperation): Promise<LockedBlobIntent> {
    const { rows } = await tx.query<IntentRow>(`
      SELECT * FROM core.trash_blob_intents
      WHERE id = $1 AND user_id = $2 AND app_id = $3 AND trash_id = $4 AND operation = $5 FOR UPDATE`,
    [intentId, scope.userId, scope.appId, scope.trashId, operation]);
    const row = rows[0];
    // The original cutoff does not move if recovery postpones its next try.
    if (!row || row.committed_at || row.created_at.getTime() + INTENT_LIFETIME_MS <= this.now().getTime()) throw sourceChanged();
    assertIntentFiles(scope, intentId, operation, row.files);
    return { [intentLock]: true, id: intentId, scope: { ...scope }, operation, files: row.files };
  }

  async stageDelete(intent: LockedBlobIntent, actualFiles: readonly TrashLiveAttachment[]): Promise<TrashArchivedAttachment[]> {
    compareSourceProof(intent, "delete", actualFiles.map(({ attachmentId, storageKey, size, sha256 }) =>
      ({ attachmentId, key: liveKey(storageKey), size, sha256 })));
    for (const file of intent.files) await copyBlob(this.options.storageRoot, intent.scope.userId, file);
    return intent.files.map(({ attachmentId, destinationKey, size, sha256 }) => ({ attachmentId, key: destinationKey, size, sha256 }));
  }

  async stageRestore(intent: LockedBlobIntent, actualFiles: readonly TrashArchivedAttachment[]): Promise<TrashRestoredAttachment[]> {
    compareSourceProof(intent, "restore", actualFiles);
    for (const file of intent.files) await copyBlob(this.options.storageRoot, intent.scope.userId, file);
    return intent.files.map(({ attachmentId, destinationKey }) => ({
      attachmentId, id: destinationKey.split("/").at(-1)!, storageKey: destinationKey.slice(ASSETS_PREFIX.length),
    }));
  }

  async settle(tx: DatabaseContext, intent: LockedBlobIntent): Promise<void> {
    const { rowCount } = await tx.query(`
      UPDATE core.trash_blob_intents
      SET committed_at = $2, abandon_after = greatest(created_at + interval '1 microsecond', $2)
      WHERE id = $1 AND committed_at IS NULL`,
    [intent.id, this.now()]);
    if (rowCount !== 1) throw sourceChanged();
    if (intent.operation !== "delete") return;
    const { userId, appId, trashId } = intent.scope;
    await tx.query(`
      INSERT INTO core.trash_blob_cleanup (user_id, app_id, trash_id, kind, storage_key)
      SELECT $1, $2, $3, 'live', key FROM unnest($4::text[]) AS files(key)
      ON CONFLICT (user_id, storage_key) DO NOTHING`,
    [userId, appId, trashId, intent.files.map((file) => file.sourceKey)]);
  }

  async recheckOutcome(intentId: string): Promise<TrashBlobOutcome> {
    return this.options.database.withTransaction(async (tx) => {
      const { rows } = await tx.query<{ committed_at: Date | null }>(
        "SELECT committed_at FROM core.trash_blob_intents WHERE id = $1 FOR UPDATE", [intentId]);
      if (!rows[0]) return "missing";
      return rows[0].committed_at ? "committed" : "uncommitted";
    });
  }

  async sweep(): Promise<void> {
    await withAttachmentGuard(this.options.database, "exclusive", async (tx) => {
      await this.reclaimIntents(tx);
      await this.processRetirements(tx);
    });
  }

  private async reclaimIntents(tx: DatabaseContext): Promise<void> {
    const now = this.now();
    const { rows } = await tx.query<IntentRow>(`
      SELECT * FROM core.trash_blob_intents
      WHERE abandon_after <= $1 ORDER BY abandon_after, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [now, SWEEP_BATCH_SIZE]);
    for (const row of rows) {
      const scope = scopeOf(row);
      try {
        assertIntentFiles(scope, row.id, row.operation, row.files);
        const reserved = await pendingKeys(tx, scope.userId, row.id);
        for (const file of row.files) {
          if (reserved.has(file.temporaryKey) || (!row.committed_at && reserved.has(file.destinationKey))) {
            throw new Error("Another Trash attachment intent holds a staging locator");
          }
          if (!row.committed_at && !(await committedReferenceExists(tx, scope.userId, file.destinationKey))) {
            await removeCopiedDestination(this.options.storageRoot, scope.userId, file);
          }
          if (!(await committedReferenceExists(tx, scope.userId, file.temporaryKey))) {
            await removeBlob(this.options.storageRoot, scope.userId, file.temporaryKey);
          }
        }
      } catch (error) {
        this.options.log.warn({ error, intentId: row.id, userId: scope.userId }, "Trash attachment stage cleanup failed");
        await tx.query("UPDATE core.trash_blob_intents SET abandon_after = $2 WHERE id = $1",
          [row.id, new Date(now.getTime() + INTENT_RETRY_MS)]);
        continue;
      }
      const expires = row.committed_at && new Date(row.committed_at.getTime() + COMMITTED_INTENT_LIFETIME_MS);
      if (expires && expires > now) {
        // Temporary links may be retired immediately. Keep the outcome for
        // a caller whose commit acknowledgement was lost.
        await tx.query("UPDATE core.trash_blob_intents SET abandon_after = $2 WHERE id = $1", [row.id, expires]);
      } else {
        await tx.query("DELETE FROM core.trash_blob_intents WHERE id = $1", [row.id]);
      }
    }
  }

  private async processRetirements(tx: DatabaseContext): Promise<void> {
    const { rows } = await tx.query<CleanupRow>(`
      SELECT user_id, app_id, trash_id, kind, storage_key, attempts FROM core.trash_blob_cleanup
      WHERE next_attempt_at <= now() ORDER BY next_attempt_at, user_id, storage_key
      LIMIT $1 FOR UPDATE SKIP LOCKED`, [SWEEP_BATCH_SIZE]);
    for (const job of rows) {
      const { user_id: userId, app_id: appId, trash_id: trashId, kind, storage_key: key } = job;
      try {
        const scopePrefix = kind === "trash" ? `trash/${trashId}/` : ASSETS_PREFIX;
        if (!key.startsWith(scopePrefix)) throw new Error("Invalid attachment retirement locator");
        if (kind === "live") assertScope({ userId, appId, trashId });
        else if (!UUID.test(key.slice(scopePrefix.length))) throw new Error("Invalid Trash attachment retirement locator");
        if ((await pendingKeys(tx, userId)).has(key)) {
          await tx.query("UPDATE core.trash_blob_cleanup SET next_attempt_at = now() + interval '1 minute' WHERE user_id = $1 AND storage_key = $2",
            [userId, key]);
          continue;
        }
        if (!(await committedReferenceExists(tx, userId, key))) await removeBlob(this.options.storageRoot, userId, key);
      } catch (error) {
        this.options.log.warn({ error, userId, storageKey: key }, "Trash attachment retirement failed");
        const delaySeconds = Math.min(60 * 2 ** Math.min(job.attempts, 6), 3_600);
        const message = error instanceof Error ? error.message : String(error);
        await tx.query(`
          UPDATE core.trash_blob_cleanup SET attempts = attempts + 1, last_error = $3,
            next_attempt_at = now() + $4 * interval '1 second'
          WHERE user_id = $1 AND storage_key = $2`, [userId, key, message, delaySeconds]);
        continue;
      }
      await tx.query("DELETE FROM core.trash_blob_cleanup WHERE user_id = $1 AND storage_key = $2", [userId, key]);
    }
  }
}
