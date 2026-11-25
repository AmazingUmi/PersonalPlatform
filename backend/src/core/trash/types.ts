import type { FastifyRequest } from "fastify";
import type { DatabaseContext } from "../database/index.js";
import type { Logger } from "../logging/index.js";
import type { TimeService } from "../time/index.js";

export interface TrashLiveAttachment {
  attachmentId: string;
  /** Key relative to the acting owner's App storage root. */
  storageKey: string;
  size: number;
  sha256: string;
}

export interface TrashArchivedAttachment {
  attachmentId: string;
  /** Key relative to the acting owner's storage root. */
  key: string;
  size: number;
  sha256: string;
}

export interface TrashRestoredAttachment {
  attachmentId: string;
  id: string;
  /** New key relative to the acting owner's App storage root. */
  storageKey: string;
}

export interface TrashDraft {
  entityType: string;
  entityId: string;
  title: string;
  summary?: string | null;
  payload: Record<string, unknown>;
  payloadVersion?: number;
  attachments?: readonly TrashLiveAttachment[];
}

export interface TrashPrepareContext {
  readonly userId: string;
  readonly database: DatabaseContext;
}

export interface TrashMutationContext extends TrashPrepareContext {
  /** Writes the archive using the same transaction as the live delete. */
  moveToTrash(draft: TrashDraft): Promise<void>;
}

export interface AppTrash {
  /** The optional preparation describes owned sources before any file copies. */
  withMutation<T>(
    request: FastifyRequest,
    mutate: (ctx: TrashMutationContext) => Promise<T>,
    prepare?: (ctx: TrashPrepareContext) => Promise<TrashDraft>,
  ): Promise<T>;
  /** Protects an attachment metadata view until its final byte read. */
  withAttachmentRead<T>(run: (tx: DatabaseContext) => Promise<T>): Promise<T>;
  /** Retires an App-owned live key after checking current references and reservations. */
  retireLiveAttachment(userId: string, storageKey: string): Promise<boolean>;
}

export interface OwnedTrashEntry {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payloadVersion: number;
  readonly payload: unknown;
  readonly attachmentKeys: readonly TrashArchivedAttachment[];
}

export interface TrashRestoreContext extends TrashPrepareContext {
  readonly restoredId: string;
  readonly log: Logger;
  readonly time: TimeService;
  restoreAttachments(): Promise<readonly TrashRestoredAttachment[]>;
}
