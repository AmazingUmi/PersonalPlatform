import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { AppError } from "../api/errors.js";
import { CapabilityError } from "../app-registry/context.js";
import type { BackendAppModule, ManifestCapabilities } from "../app-registry/types.js";
import { authenticatedRequest } from "../auth/guard.js";
import { lockActiveUser, lockSessionExpiry } from "../auth/service.js";
import type { Database, DatabaseContext } from "../database/index.js";
import type { Logger } from "../logging/index.js";
import { withAttachmentGuard } from "../storage/attachment-guard.js";
import type { TimeService } from "../time/index.js";
import { removeBlob } from "./blob-files.js";
import { canRetireLiveAssetAttachment, type LockedBlobIntent, type TrashBlobScope, type TrashBlobStore } from "./blobs.js";
import type { AppTrash, OwnedTrashEntry, TrashArchivedAttachment, TrashDraft, TrashMutationContext } from "./types.js";

const DAY_MS = 86_400_000;
const SWEEP_BATCH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TrashRow {
  id: string;
  app_id: string;
  entity_type: string;
  entity_id: string;
  title: string;
  summary: string | null;
  deleted_by_type: "user" | "agent";
  deleted_by_label: string;
  deleted_at: Date;
  expires_at: Date;
}

interface ArchiveRow extends TrashRow {
  payload: unknown;
  payload_version: number;
  attachment_keys: TrashArchivedAttachment[];
}

type TrashActor = { type: "user"; label: string } | { type: "agent"; id: string; label: string };

export type TrashRestoreTarget =
  | { status: "disabled" | "unavailable" }
  | { status: "ready"; restore: NonNullable<BackendAppModule["restoreFromTrash"]>; capabilities: ManifestCapabilities };

interface TrashServiceOptions {
  database: Database;
  time: TimeService;
  log: Logger;
  storageRoot: string;
  retentionDays: number;
  blobs: TrashBlobStore;
  restoreTarget(appId: string): TrashRestoreTarget;
}

function cookieSession(request: FastifyRequest) {
  const principal = authenticatedRequest(request);
  if (!principal) throw new AppError(401, "unauthorized", "authentication required");
  return principal;
}

function missingEntry(): AppError {
  return new AppError(404, "not_found", "Trash entry not found");
}

function assertEntryId(id: string): void {
  if (!UUID.test(id)) throw missingEntry();
}

function sourceChanged(): AppError {
  return new AppError(409, "trash_source_changed", "Attachment data changed before the Trash operation. Reload and retry.");
}

export class TrashService {
  constructor(private readonly options: TrashServiceOptions) {}

  forApp(appId: string, capabilities: ManifestCapabilities): AppTrash {
    const requireAttachmentAccess = () => {
      if (!capabilities.database) throw new CapabilityError(appId, "database");
      if (!capabilities.storage) throw new CapabilityError(appId, "storage");
    };
    return {
      withAttachmentRead: async run => {
        requireAttachmentAccess();
        return this.guard(run);
      },
      retireLiveAttachment: async (userId, storageKey) => {
        requireAttachmentAccess();
        if (appId !== "assets") throw new AppError(409, "app_unavailable", "This App has no attachment retirement adapter.");
        return withAttachmentGuard(this.options.database, "exclusive", async tx => {
          if (!await canRetireLiveAssetAttachment(tx, userId, storageKey)) return false;
          await removeBlob(this.options.storageRoot, userId, `apps/assets/${storageKey}`);
          return true;
        });
      },
      withMutation: async (request, mutate, prepare) => {
        if (!capabilities.database) throw new CapabilityError(appId, "database");
        if (prepare && !capabilities.storage) throw new CapabilityError(appId, "storage");
        const session = cookieSession(request);
        const userId = session.user.id;
        const scope = { userId, appId, trashId: randomUUID() };
        const prepared = prepare && await this.guard(async tx => {
          await this.requireOwner(tx, session);
          const draft = await prepare({ userId, database: tx });
          return {
            entityId: draft.entityId,
            entityType: draft.entityType,
            intentId: await this.options.blobs.prepareDelete(tx, scope, draft.attachments ?? []),
          };
        });
        const run = async (tx: DatabaseContext) => {
          const owner = await this.requireOwner(tx, session);
          const locked = prepared?.intentId ? await this.options.blobs.lockIntent(tx, scope, prepared.intentId, "delete") : undefined;
          return this.runMutation(tx, scope, { type: "user", label: owner.username }, mutation => mutate({
            ...mutation,
            moveToTrash: draft => {
              if (prepared && (draft.entityId !== prepared.entityId || draft.entityType !== prepared.entityType)) throw sourceChanged();
              if (!capabilities.storage && draft.attachments?.length) throw new CapabilityError(appId, "storage");
              return mutation.moveToTrash(draft);
            },
          }), locked);
        };
        return prepared ? this.runAttachmentMutation(prepared.intentId, run) : this.options.database.withTransaction(run);
      },
    };
  }

  /** Internal transaction entry point for an actor already authorized by Core. */
  async runMutation<T>(
    tx: DatabaseContext,
    scope: TrashBlobScope,
    actor: TrashActor,
    mutate: (ctx: TrashMutationContext) => Promise<T>,
    intent?: LockedBlobIntent,
  ): Promise<T> {
    let archive: Promise<void> | undefined;
    const result = await mutate({
      userId: scope.userId, database: tx,
      moveToTrash: draft => {
        if (archive) throw new Error("A Trash mutation can only archive one record");
        archive = this.archive(tx, scope, actor, draft, intent);
        return archive;
      },
    });
    if (!archive) throw new Error("A Trash mutation must archive its deleted record");
    await archive;
    if (intent) await this.options.blobs.settle(tx, intent);
    return result;
  }

  private async archive(tx: DatabaseContext, scope: TrashBlobScope, actor: TrashActor, draft: TrashDraft, intent?: LockedBlobIntent): Promise<void> {
    const files = draft.attachments ?? [];
    if (!intent && files.length) throw sourceChanged();
    const attachmentKeys = intent ? await this.options.blobs.stageDelete(intent, files) : [];
    const deletedAt = this.options.time.now();
    const expiresAt = new Date(deletedAt.getTime() + this.options.retentionDays * DAY_MS);
    await tx.query(
      `INSERT INTO core.trash_items (
         id, user_id, app_id, entity_type, entity_id, title, summary, payload, payload_version,
         attachment_keys, deleted_by_type, deleted_by_agent_id, deleted_by_label, deleted_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14, $15)`,
      [scope.trashId, scope.userId, scope.appId, draft.entityType, draft.entityId, draft.title, draft.summary ?? null,
        JSON.stringify(draft.payload), draft.payloadVersion ?? 1, JSON.stringify(attachmentKeys),
        actor.type, actor.type === "agent" ? actor.id : null, actor.label, deletedAt, expiresAt],
    );
  }

  async list(request: FastifyRequest, query: { appId?: string; limit?: number; offset?: number }) {
    const userId = cookieSession(request).user.id;
    const limit = query.limit ?? 30;
    const offset = query.offset ?? 0;
    const { rows } = await this.options.database.query<TrashRow>(
      `SELECT id, app_id, entity_type, entity_id, title, summary, deleted_by_type, deleted_by_label, deleted_at, expires_at
       FROM core.trash_items
       WHERE user_id = $1 AND expires_at > $2 AND ($3::text IS NULL OR app_id = $3)
       ORDER BY deleted_at DESC, id DESC LIMIT $4 OFFSET $5`,
      [userId, this.options.time.now(), query.appId ?? null, limit + 1, offset],
    );
    return {
      items: rows.slice(0, limit).map(row => ({
        id: row.id, appId: row.app_id, entityType: row.entity_type, entityId: row.entity_id,
        title: row.title, summary: row.summary, deletedByType: row.deleted_by_type, deletedByLabel: row.deleted_by_label,
        deletedAt: row.deleted_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      })),
      hasMore: rows.length > limit,
    };
  }

  async restore(request: FastifyRequest, id: string): Promise<{ restoredId: string; appId: string; entityType: string }> {
    const session = cookieSession(request);
    const userId = session.user.id;
    assertEntryId(id);
    const restoredId = randomUUID();
    const prepared = await this.guard(async tx => {
      await this.requireOwner(tx, session);
      const entry = await this.readEntry(tx, userId, id, false);
      const scope = { userId, appId: entry.app_id, trashId: entry.id };
      const target = this.options.restoreTarget(entry.app_id);
      const intentId = target.status === "ready" && target.capabilities.storage
        ? await this.options.blobs.prepareRestore(tx, scope, entry.attachment_keys, restoredId)
        : undefined;
      return { scope, intentId };
    });
    return this.runAttachmentMutation(prepared.intentId, async tx => {
      await this.requireOwner(tx, session);
      const intent = prepared.intentId ? await this.options.blobs.lockIntent(tx, prepared.scope, prepared.intentId, "restore") : undefined;
      const row = await this.readEntry(tx, userId, id, true);
      const { restore, capabilities } = this.restoreTarget(row.app_id);
      if (row.attachment_keys.length && !capabilities.storage) throw new CapabilityError(row.app_id, "storage");
      if (row.app_id !== prepared.scope.appId || (!intent && row.attachment_keys.length)) throw sourceChanged();
      const entry: OwnedTrashEntry = {
        id: row.id, entityType: row.entity_type, entityId: row.entity_id,
        payload: row.payload, payloadVersion: row.payload_version, attachmentKeys: row.attachment_keys,
      };
      const stage = () => {
        if (!capabilities.storage) throw new CapabilityError(row.app_id, "storage");
        return intent ? this.options.blobs.stageRestore(intent, row.attachment_keys) : Promise.resolve([]);
      };
      let copies: ReturnType<typeof stage> | undefined;
      const result = await restore({
        userId, restoredId, database: tx, time: this.options.time,
        log: this.options.log.child({ app: row.app_id }),
        restoreAttachments: () => copies ??= stage(),
      }, entry);
      if (result.restoredId !== restoredId || (intent && !copies)) throw new Error("App did not restore the claimed Trash entry");
      await copies;
      await tx.query("DELETE FROM core.trash_items WHERE id = $1 AND user_id = $2", [id, userId]);
      if (intent) await this.options.blobs.settle(tx, intent);
      return { restoredId, appId: row.app_id, entityType: row.entity_type };
    });
  }

  async purge(request: FastifyRequest, id: string): Promise<void> {
    const session = cookieSession(request);
    const userId = session.user.id;
    assertEntryId(id);
    await this.options.database.withTransaction(async tx => {
      await this.requireOwner(tx, session);
      await this.readEntry(tx, userId, id, true);
      await tx.query("DELETE FROM core.trash_items WHERE id = $1 AND user_id = $2", [id, userId]);
    });
  }

  async empty(request: FastifyRequest): Promise<void> {
    const session = cookieSession(request);
    const userId = session.user.id;
    await this.options.database.withTransaction(async tx => {
      await this.requireOwner(tx, session);
      const { rows } = await tx.query<{ id: string; expires_at: Date }>(
        "SELECT id, expires_at FROM core.trash_items WHERE user_id = $1 AND expires_at > $2 ORDER BY id FOR UPDATE",
        [userId, this.options.time.now()],
      );
      const now = this.options.time.now();
      const ids = rows.filter(row => row.expires_at > now).map(row => row.id);
      if (ids.length) await tx.query("DELETE FROM core.trash_items WHERE user_id = $1 AND id = ANY($2::uuid[])", [userId, ids]);
    });
  }

  async purgeExpired(): Promise<number> {
    const now = this.options.time.now();
    const { rowCount } = await this.options.database.query(
      `WITH candidates AS (
         SELECT id FROM core.trash_items WHERE expires_at <= $1 ORDER BY expires_at, id LIMIT $2
       ), claimed AS (
         SELECT t.id FROM core.trash_items t JOIN candidates c ON t.id = c.id
         WHERE t.expires_at <= $1 ORDER BY t.id FOR UPDATE OF t SKIP LOCKED
       ) DELETE FROM core.trash_items t USING claimed WHERE t.id = claimed.id`,
      [now, SWEEP_BATCH],
    );
    return rowCount ?? 0;
  }

  private async readEntry(tx: DatabaseContext, userId: string, id: string, lock: boolean): Promise<ArchiveRow> {
    const { rows } = await tx.query<ArchiveRow>(
      `SELECT * FROM core.trash_items WHERE user_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
      [userId, id],
    );
    const row = rows[0];
    if (!row || row.expires_at <= this.options.time.now()) throw missingEntry();
    return row;
  }

  private async requireOwner(tx: DatabaseContext, session: ReturnType<typeof cookieSession>) {
    const owner = await lockActiveUser(tx, session.user.id);
    if (owner) {
      const expiresAt = await lockSessionExpiry(tx, owner.id, session.sessionHash);
      if (expiresAt && expiresAt > this.options.time.now()) return owner;
    }
    throw new AppError(401, "unauthorized", "authentication required");
  }

  private restoreTarget(appId: string): Extract<TrashRestoreTarget, { status: "ready" }> {
    const target = this.options.restoreTarget(appId);
    if (target.status === "disabled") throw new AppError(409, "app_disabled", "Enable the App to restore this entry.");
    if (target.status !== "ready") throw new AppError(409, "app_unavailable", "This App cannot restore the entry right now.");
    return target;
  }

  private guard<T>(run: (tx: DatabaseContext) => Promise<T>): Promise<T> {
    return withAttachmentGuard(this.options.database, "shared", run);
  }

  /** Core transaction with durable outcome resolution for a prepared attachment intent. */
  async runAttachmentMutation<T>(intentId: string | undefined, run: (tx: DatabaseContext) => Promise<T>): Promise<T> {
    let completed: { result: T } | undefined;
    try {
      return await this.guard(async tx => {
        const result = await run(tx);
        completed = { result };
        return result;
      });
    } catch (error) {
      if (!intentId || !completed) throw error;
      const outcome = await this.options.blobs.recheckOutcome(intentId).catch(() => "missing" as const);
      if (outcome === "committed") return completed.result;
      if (outcome === "uncommitted") throw error;
      throw new AppError(503, "trash_outcome_unknown", "Could not confirm the Trash operation. Reload before retrying.");
    }
  }
}
