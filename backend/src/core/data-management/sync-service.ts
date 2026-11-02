import { randomUUID } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AppError } from "../api/errors.js";
import { resolveSession } from "../auth/service.js";
import type { Database, DatabaseContext } from "../database/index.js";
import { sanitizeKey } from "../storage/index.js";
import { backupKey, encryptPassword, decryptPassword } from "./credentials.js";
import { dataLockNames } from "./data-lock.js";
import { assertRecordGraph } from "./record-graph.js";
import { canonicalJson } from "./incremental.js";
import { captureOwnSnapshot, readDataCatalog, stageOwnedFile, type SnapshotOptions } from "./snapshot.js";
import {
  TABLES, digest, keyOf, type Column, type Row, type Snapshot, type TableSpec,
} from "./snapshot-schema.js";
import { readCachedObject, writeCachedObject } from "./sync-cache.js";
import {
  buildSyncDocument, parseSyncHead, reconstructSyncDocument, syncHeadName, validSyncKey,
  type ReconstructedSync, type SyncHead, type SyncObjectRef,
} from "./sync-document.js";
import { pruneSyncLocalFiles } from "./sync-retention.js";
import {
  createPairingMaterial, formatPairingCode, parsePairingCode, projectRow, reconcile, recoverPublication,
  redactSyncText, selectTransfers, semanticHash, syncKeyOf, type SyncAction,
} from "./sync-protocol.js";
import { probeConditionalWrites, readStrongEtag } from "./sync-transport.js";
import { davExchange } from "./webdav-http.js";
import type { WebdavBackups } from "./webdav.js";

const NORMAL_BUDGET = 24;
const BOOTSTRAP_BUDGET = 64;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 9 * 60_000;
const CYCLE_DEADLINE_MS = 8 * 60_000;
const HEAD_RESERVE = 3;
export interface SyncStatus {
  linked: boolean;
  enabled: boolean;
  phase: string;
  intervalSeconds: number;
  identityId: string | null;
  openConflicts: number;
  lastError: string | null;
  backoffUntil: string | null;
  baseline: boolean;
  pending: boolean;
  result?: string;
  /** True when this call wrote user-visible app rows the client should reload. */
  dataChanged?: boolean;
}

interface Binding {
  user_id: string;
  identity_id: string;
  replica_id: string;
  destination_endpoint: string;
  destination_username: string;
  pairing_verifier: string;
  pairing_secret_ciphertext: string | null;
  enabled: boolean;
  interval_seconds: number;
  phase: string;
  baseline_hash: string | null;
  lease_token: string | null;
  pending_op_token: string | null;
  pending_content_hash: string | null;
  pending_capture_hash: string | null;
  pending_applied: boolean;
  last_error: string | null;
  head_etag: string | null;
  head_generation: string | null;
  head_document: SyncHead | null;
  remote_op_token: string | null;
  remote_content_hash: string | null;
  parent_op_token: string | null;
  parent_content_hash: string | null;
  parent_etag: string | null;
  pending_head: SyncHead | null;
  pending_tombstones: string[] | null;
  pending_attempts: number;
  backoff_until: Date | null;
  backoff_attempt: number;
  baseline_generation: string | null;
  lease_until: Date | string | null;
  origin: "create" | "join";
}

interface RemoteHead {
  missing: boolean;
  unchanged: boolean;
  etag: string | null;
  head: SyncHead | null;
}

class BudgetStop extends Error {
  constructor() { super("sync budget"); this.name = "SyncBudgetStop"; }
}

/** Own-user continuous sync. Network runs outside table locks and transactions. */
export class ContinuousSync {
  constructor(private readonly deps: {
    database: Database;
    storageRoot: string;
    installedApps: () => string[];
    backups: WebdavBackups;
    now?: () => Date;
  }) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  async status(userId: string): Promise<SyncStatus> {
    const binding = await this.binding(userId);
    return this.view(binding, await this.conflictCount(userId));
  }

  async create(userId: string, token: string): Promise<SyncStatus & { pairingCode: string }> {
    await this.requireUser(token, userId);
    const creds = await this.deps.backups.syncCredentials(userId);
    await this.clearProbe(userId);
    if (await this.binding(userId)) throw new AppError(409, "sync_already_linked", "This account is already linked. Unlink before creating another identity.");
    const material = createPairingMaterial();
    const secret = encryptPassword(material.secret.toString("base64url"), await backupKey(this.deps.storageRoot), userId);
    await this.insertBinding(userId, material.identityId, material.verifier, secret, creds, "create");
    try {
      await probeConditionalWrites(creds);
      const existing = await this.readIdentityHead(creds, material.identityId);
      if (existing) throw new AppError(409, "sync_remote_exists", "That folder already has a sync head. Join it with the pairing code instead of creating another.");
      await this.deps.database.query("UPDATE core.sync_bindings SET phase='bootstrap', enabled=false, updated_at=$2 WHERE user_id=$1 AND phase='probing'", [userId, this.now()]);
    } catch (error) {
      await this.deps.database.query("DELETE FROM core.sync_bindings WHERE user_id=$1 AND enabled=false AND phase='probing'", [userId]);
      throw error;
    }
    const view = await this.status(userId);
    return { ...view, pairingCode: material.code };
  }

  async join(userId: string, token: string, pairingCode: string): Promise<SyncStatus> {
    await this.requireUser(token, userId);
    const creds = await this.deps.backups.syncCredentials(userId);
    let parsed: ReturnType<typeof parsePairingCode>;
    try { parsed = parsePairingCode(pairingCode); }
    catch { throw new AppError(422, "invalid_pairing_code", "Enter the pairing code from the account that created this sync identity."); }
    await this.clearProbe(userId);
    if (await this.binding(userId)) throw new AppError(409, "sync_already_linked", "This account is already linked. Unlink before joining another identity.");
    const secret = encryptPassword(parsed.secret.toString("base64url"), await backupKey(this.deps.storageRoot), userId);
    try {
      await this.insertBinding(userId, parsed.identityId, parsed.verifier, secret, creds, "join");
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AppError(409, "sync_identity_taken", "That sync identity is already linked to another account on this server.");
      throw error;
    }
    try {
      await probeConditionalWrites(creds);
      const existing = await this.readIdentityHead(creds, parsed.identityId);
      if (!existing) throw new AppError(404, "sync_remote_missing", "Join did not find that sync identity. Nothing was created.");
      if (existing.pairingVerifier !== parsed.verifier) throw new AppError(422, "invalid_pairing_code", "That pairing code does not match the cloud identity.");
      await this.deps.database.query("UPDATE core.sync_bindings SET phase='bootstrap', enabled=false, updated_at=$2 WHERE user_id=$1 AND phase='probing'", [userId, this.now()]);
    } catch (error) {
      await this.deps.database.query("DELETE FROM core.sync_bindings WHERE user_id=$1 AND enabled=false AND phase='probing'", [userId]);
      throw error;
    }
    return this.status(userId);
  }

  async configure(userId: string, token: string, input: { enabled?: boolean; intervalSeconds?: number }): Promise<SyncStatus> {
    await this.requireUser(token, userId);
    const binding = await this.binding(userId);
    if (!binding || binding.phase === "probing" || binding.phase === "unlinked") throw new AppError(404, "sync_not_linked", "Continuous sync is not set up.");
    if (input.intervalSeconds !== undefined && ![0, 60, 120].includes(input.intervalSeconds)) throw new AppError(422, "invalid_interval", "Choose 60 or 120 seconds, or 0 for a manual cycle.");
    if (input.enabled === true && binding.phase === "probing") throw new AppError(409, "sync_not_ready", "Sync stays off until the destination accepts conditional writes.");
    const now = this.now();
    const updated = await this.deps.database.query(
      `UPDATE core.sync_bindings SET enabled=COALESCE($2, enabled), interval_seconds=COALESCE($3, interval_seconds), updated_at=$4
       WHERE user_id=$1 AND (lease_until IS NULL OR lease_until <= $4)`,
      [userId, input.enabled ?? null, input.intervalSeconds ?? null, now]);
    if (!updated.rowCount) throw new AppError(409, "sync_busy", "Continuous sync is running. Wait until the current cycle finishes.");
    return this.status(userId);
  }

  async reveal(userId: string, token: string): Promise<{ pairingCode: string }> {
    await this.requireUser(token, userId);
    const binding = await this.binding(userId);
    if (!binding?.pairing_secret_ciphertext) throw new AppError(404, "sync_not_linked", "Continuous sync is not set up.");
    const secret = Buffer.from(decryptPassword(binding.pairing_secret_ciphertext, await backupKey(this.deps.storageRoot), userId), "base64url");
    return { pairingCode: formatPairingCode(binding.identity_id, secret) };
  }

  async unlink(userId: string, token: string): Promise<void> {
    await this.requireUser(token, userId);
    await this.deps.database.withTransaction(async tx => {
      const held = (await tx.query<{ lease_until: Date | null }>("SELECT lease_until FROM core.sync_bindings WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
      if (held?.lease_until && new Date(held.lease_until).getTime() > this.now().getTime()) throw new AppError(409, "sync_busy", "Continuous sync is running. Wait until the current cycle finishes.");
      await tx.query("DELETE FROM core.sync_remote_objects WHERE user_id=$1", [userId]);
      await tx.query("DELETE FROM core.sync_guards WHERE user_id=$1", [userId]);
      await tx.query("DELETE FROM core.sync_conflicts WHERE user_id=$1", [userId]);
      await tx.query("DELETE FROM core.sync_row_state WHERE user_id=$1", [userId]);
      await tx.query("DELETE FROM core.sync_bindings WHERE user_id=$1", [userId]);
    });
  }

  async conflicts(userId: string): Promise<{ items: { id: string; syncKey: string; reason: string; local: Row | null; remote: Row | null; baseHash: string | null }[] }> {
    const rows = (await this.deps.database.query<{ id: string; sync_key: string; reason: string; local_image: Row | null; remote_image: Row | null; base_hash: string | null }>(
      "SELECT id, sync_key, reason, local_image, remote_image, base_hash FROM core.sync_conflicts WHERE user_id=$1 AND state='open' ORDER BY created_at, sync_key", [userId])).rows;
    return { items: rows.map(row => ({ id: row.id, syncKey: row.sync_key, reason: row.reason, local: row.local_image, remote: row.remote_image, baseHash: row.base_hash })) };
  }

  async resolve(userId: string, token: string, conflictId: string, choice: "keep-local" | "keep-remote"): Promise<SyncStatus> {
    await this.requireUser(token, userId);
    const binding = await this.binding(userId);
    if (!binding?.enabled) throw new AppError(409, "sync_disabled", "Continuous sync is off.");
    const lease = randomUUID();
    const leased = await this.deps.database.query(
      "UPDATE core.sync_bindings SET lease_token=$2, lease_until=$3 WHERE user_id=$1 AND enabled=true AND (lease_until IS NULL OR lease_until <= $4) RETURNING user_id",
      [userId, lease, new Date(this.now().getTime() + LEASE_MS), this.now()]);
    if (!leased.rowCount) throw new AppError(409, "sync_busy", "Continuous sync is already running for this account.");
    try {
      const conflict = (await this.deps.database.query<{ id: string; sync_key: string; local_image: Row | null; remote_image: Row | null; local_content_sha256: string | null; remote_content_sha256: string | null; base_hash: string | null; base_image: Row | null }>(
        "SELECT * FROM core.sync_conflicts WHERE id=$1 AND user_id=$2 AND state='open'", [conflictId, userId])).rows[0];
      if (!conflict) throw new AppError(404, "sync_conflict_missing", "That conflict is no longer open.");
      const creds = await this.deps.backups.syncCredentials(userId);
      await this.gate(userId, token, lease);
      const remote = await this.fetchHead(creds, binding, new Budget(NORMAL_BUDGET, this.now().getTime() + CYCLE_DEADLINE_MS), userId, token, lease);
      if (!remote.head || !remote.etag) throw new AppError(409, "sync_stale", "The cloud copy is gone. Reload sync status before choosing a version.");
      if (remote.head.identityId !== binding.identity_id || remote.head.pairingVerifier !== binding.pairing_verifier) throw new AppError(422, "invalid_sync", "Cloud identity does not match this link.");
      let remoteStill = conflict.remote_image ? semanticHash(conflict.remote_image, conflict.remote_content_sha256 ?? undefined) : undefined;
      if (remote.etag !== binding.head_etag || remote.head.contentHash !== binding.remote_content_hash) {
        const columns = await this.columnMap();
        const plan = await this.materialize(userId, remote.head, columns, new Budget(BOOTSTRAP_BUDGET, this.now().getTime() + CYCLE_DEADLINE_MS), token, lease);
        const remoteHash = plan.hashes.get(conflict.sync_key);
        if (remoteHash !== remoteStill) throw new AppError(409, "sync_stale", "The cloud record changed. Review it again before choosing a version.");
      }
      const storedLocal = conflict.local_image ? semanticHash(conflict.local_image, conflict.local_content_sha256 ?? undefined) : undefined;
      await this.guardedFiles(userId, async (tx, staged) => {
        await tx.query("SET LOCAL lock_timeout = '5s'");
        const held = await tx.query("SELECT user_id FROM core.sync_bindings WHERE user_id=$1 AND lease_token=$2 AND enabled=true FOR UPDATE", [userId, lease]);
        if (!held.rowCount) throw new AppError(409, "sync_stopped", "Continuous sync stopped before the choice was saved.");
        await this.requireUser(token, userId, tx);
        const catalog = await readDataCatalog(tx, this.deps.installedApps());
        const locks = dataLockNames(["core.users", ...[...catalog.columns.keys()].filter(name => !name.startsWith("core."))]);
        await tx.query("LOCK TABLE " + locks.map(quoted).join(", ") + " IN SHARE ROW EXCLUSIVE MODE");
        const open = (await tx.query<typeof conflict>("SELECT * FROM core.sync_conflicts WHERE id=$1 AND user_id=$2 AND state='open' FOR UPDATE", [conflictId, userId])).rows[0];
        if (!open) throw new AppError(404, "sync_conflict_missing", "That conflict is no longer open.");
        const fresh = await captureOwnSnapshot(tx, this.snapshotOptions(userId));
        const localRow = this.conflictLocalRow(open.sync_key, open.local_image, rowsOf(fresh.tables));
        const attachment = tableOf(open.sync_key) === "assets.attachments";
        const freshFile = attachment && localRow ? fresh.files.find(file => file.attachmentId === String(localRow.id))?.sha256 : undefined;
        const localHash = localRow ? semanticHash(localRow, attachment ? freshFile : undefined) : undefined;
        if (localHash !== storedLocal) throw new AppError(409, "sync_stale", "The local record changed. Review it again before choosing a version.");
        const columns = catalog;
        if (choice === "keep-remote" && open.remote_image) {
          const spec = TABLES.find(table => table.name === tableOf(open.sync_key));
          if (!spec) throw new AppError(422, "invalid_sync", "Unsupported sync record.");
          const moves = localRow && syncKeyOf(spec.name, localRow) !== open.sync_key
            ? await this.captureRetarget(tx, spec.name, localRow.id, open.remote_image.id, userId)
            : [];
          if (moves.length) await this.deleteCapturedLinks(tx, moves, userId);
          if (localRow && syncKeyOf(spec.name, localRow) !== open.sync_key) {
            await this.rememberStorageKeys(tx, spec, localRow.id, userId, staged.retired);
            await tx.query(`DELETE FROM ${quoted(spec.name)} WHERE id=$1 AND user_id=$2`, [localRow.id, userId]);
          }
          const files = new Map<string, { data: string; sha256: string }>();
          if (open.remote_content_sha256) {
            const bytes = await readCachedObject(this.deps.storageRoot, userId, open.remote_content_sha256);
            files.set(String(open.remote_image.id), { data: bytes.toString("base64"), sha256: open.remote_content_sha256 });
          }
          const previous = await this.upsert(tx, spec, open.remote_image, columns.columns.get(spec.name) ?? [], userId, files, staged.created);
          if (previous) staged.retired.push(previous);
          if (moves.length) await this.restoreCapturedLinks(tx, moves, userId, choice);
        } else if (choice === "keep-remote") {
          const spec = TABLES.find(table => table.name === tableOf(open.sync_key));
          if (!spec) throw new AppError(422, "invalid_sync", "Unsupported sync record.");
          await this.removeRow(tx, spec, open.sync_key, userId, staged.retired);
          await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, revive) VALUES ($1,$2,NULL,true,false)
            ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=NULL, tombstoned=true, revive=false`, [userId, open.sync_key]);
        }
        if (choice === "keep-local" && !open.remote_image) {
          await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, revive) VALUES ($1,$2,NULL,false,true)
            ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=NULL, tombstoned=false, revive=true`, [userId, open.sync_key]);
        }
        if (choice === "keep-local" && open.remote_image) {
          const remoteHash = semanticHash(open.remote_image, open.remote_content_sha256 ?? undefined);
          const sameKey = !localRow || syncKeyOf(tableOf(open.sync_key), localRow) === open.sync_key;
          if (!sameKey && localRow) {
            const spec = TABLES.find(table => table.name === tableOf(open.sync_key));
            if (spec) {
              const moves = await this.captureRetarget(tx, spec.name, open.remote_image.id, localRow.id, userId);
              await this.deleteCapturedLinks(tx, moves, userId);
              await this.restoreCapturedLinks(tx, moves, userId, choice);
            }
          }
          if (sameKey) {
            // Anchor the reviewed remote version. The next cycle then publishes
            // the chosen local row instead of reopening the same divergence.
            await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, revive) VALUES ($1,$2,$3,false,false)
              ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=EXCLUDED.base_hash, tombstoned=false, revive=false`, [userId, open.sync_key, remoteHash]);
          } else {
            await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, revive) VALUES ($1,$2,$3,true,false)
              ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=EXCLUDED.base_hash, tombstoned=true, revive=false`, [userId, open.sync_key, remoteHash]);
          }
        }
        const applied = choice === "keep-remote"
          ? (open.remote_image ? semanticHash(open.remote_image, open.remote_content_sha256 ?? undefined) : open.base_hash)
          : (localRow ? semanticHash(localRow, open.local_content_sha256 ?? undefined) : open.base_hash);
        await tx.query("UPDATE core.sync_conflicts SET state='resolved', resolution=$3 WHERE id=$1 AND user_id=$2 AND state='open'", [conflictId, userId, choice]);
        await tx.query(`INSERT INTO core.sync_guards (user_id, sync_key, remote_image, applied_hash) VALUES ($1,$2,$3::jsonb,$4)
          ON CONFLICT (user_id, sync_key) DO UPDATE SET remote_image=EXCLUDED.remote_image, applied_hash=EXCLUDED.applied_hash, created_at=now()`,
          [userId, open.sync_key, JSON.stringify(choice === "keep-remote" ? open.remote_image : open.local_image), applied ?? ""]);
      });
      return { ...(await this.status(userId)), dataChanged: true };
    } finally {
      await this.deps.database.query("UPDATE core.sync_bindings SET lease_token=NULL, lease_until=NULL WHERE user_id=$1 AND lease_token=$2", [userId, lease]);
    }
  }

  async cycle(userId: string, token: string): Promise<SyncStatus> {
    await this.requireUser(token, userId);
    const binding = await this.binding(userId);
    if (!binding || binding.phase === "probing") throw new AppError(404, "sync_not_linked", "Continuous sync is not set up.");
    if (!binding.enabled) throw new AppError(409, "sync_disabled", "Continuous sync is off.");
    if (binding.backoff_until && binding.backoff_until.getTime() > this.now().getTime()) return { ...(await this.status(userId)), result: "backoff", dataChanged: false };
    const lease = randomUUID();
    const leased = await this.deps.database.query("UPDATE core.sync_bindings SET lease_token=$2, lease_until=$3 WHERE user_id=$1 AND enabled=true AND (lease_until IS NULL OR lease_until <= $4) RETURNING user_id", [userId, lease, new Date(this.now().getTime() + LEASE_MS), this.now()]);
    if (!leased.rowCount) throw new AppError(409, "sync_busy", "Continuous sync is already running for this account.");
    const budget = new Budget(binding.baseline_hash ? NORMAL_BUDGET : BOOTSTRAP_BUDGET, this.now().getTime() + CYCLE_DEADLINE_MS);
    let headAttempted = false;
    let casPasses = 0;
    let dataChanged = false;
    try {
      // A lost head compare-and-swap re-reads and merges in this cycle. Three
      // passes bound the loop if another replica keeps winning.
      for (;;) {
      const binding = await this.binding(userId);
      if (!binding) throw new AppError(404, "sync_not_linked", "Continuous sync is not set up.");
      const creds = await this.deps.backups.syncCredentials(userId);
      if (creds.endpoint !== binding.destination_endpoint || creds.username !== binding.destination_username) {
        throw new AppError(409, "sync_destination_locked", "Unlink continuous sync before using a different WebDAV destination.");
      }
      await this.gate(userId, token, lease);
      const remote = await this.fetchHead(creds, binding, budget, userId, token, lease);
      if (remote.missing && binding.origin === "join" && !binding.baseline_hash) throw new AppError(404, "sync_remote_missing", "Join cannot create a cloud identity.");
      if (remote.missing && binding.baseline_hash) throw new AppError(409, "sync_remote_missing", "The cloud head is missing. The local baseline was kept.");
      if (remote.head && this.acceptedHeadRegressed(binding, remote.head)) {
        throw new AppError(409, "sync_generation_regressed", "Remote sync generation moved backwards. The local baseline was kept.");
      }
      const captured = await this.capture(userId);
      const decision = this.decideRecovery(binding, remote, captured);
      if (decision === "commit-remote" && remote.head && remote.etag) {
        const columns = await this.columnMap();
        const recovered = await this.materialize(userId, remote.head, columns, budget, token, lease);
        const open = (await this.deps.database.query<{ sync_key: string }>("SELECT sync_key FROM core.sync_conflicts WHERE user_id=$1 AND state='open'", [userId])).rows.map(row => row.sync_key);
        const snapshot = { ...captured.snapshot, tables: recovered.tables, files: recovered.files };
        await this.anchorPublished(userId, token, lease, remote.head, snapshot, recovered.tombstones, remote.etag, open);
        return await this.finish(userId, lease, { ...(await this.status(userId)), result: "committed", dataChanged: false });
      }
      if (decision === "retry-same" && binding.pending_head && binding.pending_attempts < MAX_ATTEMPTS && binding.parent_etag) {
        headAttempted = true;
        await this.putHead(creds, binding.identity_id, Buffer.from(JSON.stringify(binding.pending_head)), binding.parent_etag, budget);
        const confirmed = await this.confirmHead(creds, binding.identity_id, Buffer.from(JSON.stringify(binding.pending_head)), budget);
        if (confirmed) {
          await this.deps.database.query("UPDATE core.sync_bindings SET pending_applied=true, head_etag=$2, updated_at=$3 WHERE user_id=$1 AND lease_token=$4", [userId, confirmed, this.now(), lease]);
          const fresh = await this.binding(userId);
          const again = await this.capture(userId);
          if (fresh && this.decideRecovery(fresh, { missing: false, unchanged: false, etag: confirmed, head: binding.pending_head }, again) === "commit-remote") {
            await this.commitBaseline(userId, token, lease, fresh, again);
            return await this.finish(userId, lease, { ...(await this.status(userId)), result: "committed", dataChanged: false });
          }
        }
        await this.deps.database.query("UPDATE core.sync_bindings SET pending_attempts=pending_attempts+1, updated_at=$2 WHERE user_id=$1 AND lease_token=$3", [userId, this.now(), lease]);
        return { ...(await this.status(userId)), result: "publication_unknown", dataChanged: false };
      }
      const columns = await this.columnMap();
      let plan: ReconstructedSync | null = null;
      if (remote.head && !remote.unchanged) plan = await this.materialize(userId, remote.head, columns, budget, token, lease);
      else if (remote.head && remote.unchanged) plan = await this.materialize(userId, remote.head, columns, budget, token, lease);
      const base = await this.baseline(userId);
      const localTombstones = await this.tombstones(userId);
      const localRows = rowsOf(captured.snapshot.tables);
      const remoteRows = plan ? rowsOf(plan.tables) : new Map<string, Row>();
      const actions = this.interpret(reconcile({
        baselineEstablished: binding.baseline_hash !== null,
        base, local: localRows, remote: remoteRows,
        remoteTombstones: new Set(plan?.tombstones ?? []),
        localTombstones,
        content: { local: contentOf(captured.snapshot), remote: plan ? contentOfPlan(plan) : new Map() },
      }), localRows, remoteRows);
      if (actions.invalid) throw new AppError(422, "invalid_sync", actions.invalid);
      const revive = await this.reviveKeys(userId);
      for (let index = 0; index < actions.actions.length; index++) {
        const action = actions.actions[index]!;
        if (!revive.has(action.key)) continue;
        const row = localRows.get(action.key);
        if (!row) continue;
        // Revive republishes the reviewed deletion only. A new live cloud
        // version was not part of that review and must stay a conflict.
        const reviewedDeletion = action.type === "delete-local" || (action.type === "conflict" && action.remote === undefined);
        if (reviewedDeletion) actions.actions[index] = { type: "pending-local", key: action.key, row };
      }
      const conflicts = actions.actions.filter(action => action.type === "conflict");
      const firstRemote = binding.baseline_hash === null && remote.head !== null;
      const acceptance = remote.head && remote.etag && plan ? { lease, head: remote.head, etag: remote.etag, conflicts } : null;
      if (firstRemote && remote.head && remote.etag && plan) {
        const wrote = await this.applyInbound(userId, token, captured.digest, actions.actions, plan, columns, acceptance);
        await this.rememberConflicts(userId, conflicts, remote.etag, contentOf(captured.snapshot), contentOfPlan(plan), base);
        await this.anchor(userId, token, lease, remote, plan, actions.actions);
        return await this.finish(userId, lease, { ...(await this.status(userId)), result: conflicts.length ? "conflicted" : "bootstrap", dataChanged: wrote || conflicts.length > 0 });
      }
      let appliedInbound = false;
      if (actions.actions.some(action => action.type === "apply-remote" || action.type === "delete-local" || action.type === "adopt-tombstone" || action.type === "raise-high-score")) {
        if (await this.applyInbound(userId, token, captured.digest, actions.actions, plan, columns, acceptance)) {
          dataChanged = true;
          appliedInbound = true;
        }
      }
      await this.rememberConflicts(userId, conflicts, remote.etag, contentOf(captured.snapshot), plan ? contentOfPlan(plan) : new Map(), base);
      // No inbound writes: record the validated head on its own. Applied cycles already
      // stored it in the apply transaction. A budget stop during materialize never gets here.
      if (!appliedInbound && !firstRemote && acceptance && plan) await this.acceptInboundHead(userId, lease, acceptance.head, acceptance.etag, plan, conflicts);
      const outbound = actions.actions.some(action => action.type === "pending-local" || action.type === "publish-tombstone" || action.type === "raise-high-score");
      if (!remote.head || outbound) {
        const current = await this.capture(userId);
        const published = publicationSnapshot(current.snapshot, plan, actions.actions);
        published.tombstones = published.tombstones.filter(key => !revive.has(key) && !rowsOf(published.snapshot.tables).has(key));
        assertRecordGraph(published.snapshot, message => { throw new AppError(422, "invalid_sync", message); });
        const tombstones = published.tombstones;
        const generation = (remote.head?.generation ?? Number(binding.head_generation ?? 0)) + 1;
        const document = buildSyncDocument({
          snapshot: published.snapshot, identityId: binding.identity_id, pairingVerifier: binding.pairing_verifier,
          generation, parentOpToken: remote.head?.opToken ?? null, tombstones,
        });
        const previous = binding.head_document ? new Set(objectNames(binding.head_document)) : new Set<string>();
        const needed = [...document.objects.keys()].filter(name => !previous.has(name));
        const known = await this.knownRemote(userId);
        const room = budget.remaining - HEAD_RESERVE;
        if (room < 1 && needed.some(name => !known.has(name))) return { ...(await this.status(userId)), result: "partial", dataChanged };
        const selected = selectTransfers(needed, known, Math.max(room, 1));
        if (room < 1) selected.transfer.length = 0;
        for (const name of selected.transfer) {
          const object = document.objects.get(name)!;
          await this.gate(userId, token, lease);
          await this.putImmutable(userId, creds, object.ref, object.data, budget);
        }
        if (!selected.done) return { ...(await this.status(userId)), result: "partial", dataChanged };
        const again = await this.capture(userId);
        if (again.digest !== current.digest) {
          return { ...(await this.status(userId)), result: "retained", dataChanged };
        }
        const headBytes = Buffer.from(JSON.stringify(document.head));
        await this.journal(userId, lease, {
          op: document.head.opToken, content: document.head.contentHash, capture: current.digest,
          parentOp: remote.head?.opToken ?? null, parentContent: remote.head?.contentHash ?? null, parentEtag: remote.etag,
          head: document.head, tombstones,
        });
        headAttempted = true;
        try {
          await this.gate(userId, token, lease);
          await this.putHead(creds, binding.identity_id, headBytes, remote.etag, budget);
        } catch (error) {
          if (httpStatus(error) === 412) {
            await this.deps.database.query("UPDATE core.sync_bindings SET pending_op_token=NULL, pending_head=NULL, pending_content_hash=NULL, pending_capture_hash=NULL, pending_applied=false, updated_at=$2 WHERE user_id=$1 AND lease_token=$3", [userId, this.now(), lease]);
            casPasses += 1;
            headAttempted = false;
            if (casPasses >= 3) return { ...(await this.status(userId)), result: "lost-race", dataChanged };
            continue;
          }
          throw error;
        }
        await this.gate(userId, token, lease);
        const etag = await this.confirmHead(creds, binding.identity_id, headBytes, budget);
        if (!etag) return { ...(await this.status(userId)), result: "publication_unknown", dataChanged };
        const marked = await this.deps.database.query("UPDATE core.sync_bindings SET pending_applied=true, head_etag=$2, head_document=$3::jsonb, head_generation=$4, remote_op_token=$5, remote_content_hash=$6, updated_at=$7 WHERE user_id=$1 AND lease_token=$8",
          [userId, etag, JSON.stringify(document.head), document.head.generation, document.head.opToken, document.head.contentHash, this.now(), lease]);
        if (!marked.rowCount) throw new AppError(409, "sync_stopped", "Continuous sync stopped before the baseline was saved.");
        await this.anchorPublished(userId, token, lease, document.head, published.snapshot, tombstones, etag, conflicts.map(action => action.key));
        return await this.finish(userId, lease, { ...(await this.status(userId)), result: conflicts.length ? "conflicted" : "published", dataChanged });
      }
      if (remote.head && remote.etag && plan && !outbound) {
        return await this.finish(userId, lease, { ...(await this.status(userId)), result: conflicts.length ? "conflicted" : "idle", dataChanged });
      }
      return await this.finish(userId, lease, { ...(await this.status(userId)), result: conflicts.length ? "conflicted" : "idle", dataChanged });
      }
    } catch (error) {
      if (error instanceof BudgetStop) return { ...(await this.status(userId)), result: "partial", dataChanged };
      await this.noteFailure(userId, error, headAttempted);
      throw error;
    } finally {
      await this.deps.database.query("UPDATE core.sync_bindings SET lease_token=NULL, lease_until=NULL WHERE user_id=$1 AND lease_token=$2", [userId, lease]);
    }
  }

  private decideRecovery(binding: Binding, remote: RemoteHead, captured: { digest: string }): ReturnType<typeof recoverPublication> {
    if (!binding.pending_op_token || !binding.pending_content_hash || !binding.pending_capture_hash) return "none";
    const pending = {
      opToken: binding.pending_op_token, contentHash: binding.pending_content_hash, captureHash: binding.pending_capture_hash,
      applied: binding.pending_applied, parentOpToken: binding.parent_op_token, parentContentHash: binding.parent_content_hash, parentEtag: binding.parent_etag,
    };
    const decision = recoverPublication({
      pending, remoteOpToken: remote.head?.opToken ?? null, remoteContentHash: remote.head?.contentHash ?? null,
      remoteEtag: remote.etag, localCaptureHash: captured.digest,
    });
    if (decision === "retain-pending" && remote.head?.opToken === pending.opToken && remote.head.contentHash === pending.contentHash && captured.digest === pending.captureHash) return "commit-remote";
    return decision;
  }

  private async applyInbound(userId: string, token: string, expected: string, actions: SyncAction[], plan: ReconstructedSync | null, columns: Map<string, Column[]>, acceptance: { lease: string; head: SyncHead; etag: string; conflicts: SyncAction[] } | null = null): Promise<boolean> {
    const applying = actions.filter(action => action.type === "apply-remote" || action.type === "delete-local" || action.type === "adopt-tombstone" || action.type === "raise-high-score");
    if (!applying.length) return false;
    await this.guardedFiles(userId, async (tx, staged) => {
      await tx.query("SET LOCAL lock_timeout = '5s'");
      await tx.query("SET LOCAL statement_timeout = '30s'");
      await tx.query("SET LOCAL transaction_timeout = '120s'");
      const catalog = await readDataCatalog(tx, this.deps.installedApps());
      const locks = dataLockNames(["core.users", ...[...catalog.columns.keys()].filter(name => !name.startsWith("core."))]);
      await tx.query("LOCK TABLE " + locks.map(quoted).join(", ") + " IN SHARE ROW EXCLUSIVE MODE");
      await this.requireUser(token, userId, tx);
      const fresh = await captureOwnSnapshot(tx, this.snapshotOptions(userId));
      const tombs = await this.tombstones(userId, tx);
      if (captureDigest(fresh, [...tombs]) !== expected) throw new AppError(409, "sync_local_drift", "Local data changed during sync. Nothing from that cycle was applied.");
      const files = new Map((plan?.files ?? []).map(file => [file.attachmentId, file]));
      assertRecordGraph(previewApply(fresh, applying, plan), message => { throw new AppError(422, "invalid_sync", message); });
      for (const spec of [...TABLES].reverse()) {
        for (const action of applying) {
          if ((action.type !== "delete-local" && action.type !== "adopt-tombstone") || tableOf(action.key) !== spec.name) continue;
          await this.removeRow(tx, spec, action.key, userId, staged.retired);
          await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned) VALUES ($1,$2,NULL,true)
            ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=NULL, tombstoned=true`, [userId, action.key]);
        }
      }
      for (const action of applying.filter(action => action.type === "raise-high-score")) {
        if (action.type !== "raise-high-score") continue;
        await tx.query("UPDATE mini_game.saves SET high_score = GREATEST(high_score, $3), revision = revision + 1, updated_at = now() WHERE user_id=$1 AND id=$2", [userId, keyParts(action.key)[0], action.highScore]);
      }
      for (const spec of TABLES) {
        for (const action of applying) {
          if (action.type !== "apply-remote" || tableOf(action.key) !== spec.name) continue;
          const previous = await this.upsert(tx, spec, action.row, columns.get(spec.name) ?? [], userId, files, staged.created);
          if (previous) staged.retired.push(previous);
          const hash = plan?.hashes.get(action.key) ?? semanticHash(action.row);
          await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, high_score) VALUES ($1,$2,$3,false,$4)
            ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=EXCLUDED.base_hash, tombstoned=false, high_score=COALESCE(EXCLUDED.high_score, core.sync_row_state.high_score)`,
            [userId, action.key, hash, typeof action.row.high_score === "number" ? action.row.high_score : null]);
          await tx.query(`INSERT INTO core.sync_guards (user_id, sync_key, remote_image, applied_hash) VALUES ($1,$2,$3::jsonb,$4)
            ON CONFLICT (user_id, sync_key) DO UPDATE SET remote_image=EXCLUDED.remote_image, applied_hash=EXCLUDED.applied_hash, created_at=now()`,
            [userId, action.key, JSON.stringify(projectRow(action.row)), hash]);
        }
      }
      if (acceptance && plan) await this.writeAcceptedHead(tx, userId, acceptance.lease, acceptance.head, acceptance.etag, plan, acceptance.conflicts);
    });
    return true;
  }

  /**
   * Stage files in the same transaction that records them. A confirmed commit
   * retires every replaced key that nothing still references. A confirmed
   * rollback deletes only the new staged files. A lost commit acknowledgement
   * keeps both and does not delete anything.
   */
  private async guardedFiles(userId: string, run: (tx: DatabaseContext, staged: { created: string[]; retired: string[] }) => Promise<void>): Promise<void> {
    const staged = { created: [] as string[], retired: [] as string[] };
    let finished = false;
    try {
      await this.deps.database.withTransaction(async tx => {
        await run(tx, staged);
        finished = true;
      });
    } catch (error) {
      if (finished) {
        await this.deps.database.query("UPDATE core.sync_bindings SET phase='publication_unknown', last_error=$2, updated_at=$3 WHERE user_id=$1", [userId, "The database commit result could not be confirmed. New files were retained.", this.now()]);
        throw new AppError(503, "sync_outcome_unknown", "The database commit result could not be confirmed. New attachment files were retained. The next sync will verify the committed state.");
      }
      await this.discardStaged(staged.created);
      throw error;
    }
    // The commit is already known. A cleanup failure must not look like an uncertain commit.
    try { await this.retireFiles(userId, staged.retired); }
    catch { /* old and new files stay; a later completed cycle can retry */ }
  }

  private async upsert(tx: DatabaseContext, spec: TableSpec, row: Row, columns: Column[], userId: string, files: Map<string, { data: string; sha256: string }>, created: string[]): Promise<string | undefined> {
    const owner = await this.ownership(tx, spec, row, userId);
    if (owner === "foreign") throw new AppError(409, "sync_foreign_owner", "A record id belongs to another account. Nothing from this cycle was applied.");
    await this.assertParents(tx, spec, row, userId);
    const next: Row = { ...row, user_id: spec.columns.includes("user_id") ? userId : row.user_id };
    let previousKey: string | undefined;
    if (spec.name === "assets.attachments") {
      const file = files.get(String(row.id));
      if (!file) throw new AppError(422, "invalid_sync", "Attachment metadata and content references do not match.");
      if (owner === "missing") {
        const staged = await stageOwnedFile(this.deps.storageRoot, userId, Buffer.from(file.data, "base64"), "sync");
        created.push(staged.path);
        next.storage_key = staged.key;
      } else {
        const current = (await tx.query<{ storage_key: string }>("SELECT storage_key FROM assets.attachments WHERE id=$1 AND user_id=$2", [row.id, userId])).rows[0];
        previousKey = current?.storage_key;
        next.storage_key = current?.storage_key ?? "sync/remote";
        if (file) {
          const staged = await stageOwnedFile(this.deps.storageRoot, userId, Buffer.from(file.data, "base64"), "sync");
          created.push(staged.path);
          next.storage_key = staged.key;
        }
      }
    }
    if (typeof next.high_score === "number" && owner === "mine") {
      const current = (await tx.query<{ high_score: number }>("SELECT high_score FROM mini_game.saves WHERE user_id=$1 AND id=$2", [userId, row.id])).rows[0];
      if (current && current.high_score > next.high_score) next.high_score = current.high_score;
    }
    const writable = spec.columns.filter(column => column !== "revision");
    const values = writable.map(column => {
      if (column === "updated_at") return typeof next.updated_at === "string" ? next.updated_at : this.now().toISOString();
      if (column === "user_id") return userId;
      const type = columns.find(item => item.name === column)?.type;
      const value = next[column];
      if (type === "jsonb") return JSON.stringify(value ?? null);
      return value ?? null;
    });
    if (owner === "mine") {
      const assignments = writable.map((column, index) => quoted(column) + "=$" + (index + 1)).join(", ");
      const revision = spec.columns.includes("revision") ? ", revision = revision + 1" : "";
      await tx.query(`UPDATE ${quoted(spec.name)} SET ${assignments}${revision} WHERE ${this.where(spec)}`, [...values, ...this.whereValues(spec, next, userId)]);
      return previousKey && previousKey !== next.storage_key ? previousKey : undefined;
    }
    const names = spec.columns.includes("revision") ? [...writable, "revision"] : writable;
    const insertValues = spec.columns.includes("revision") ? [...values, 1] : values;
    await tx.query(`INSERT INTO ${quoted(spec.name)} (${names.map(quoted).join(", ")}) VALUES (${names.map((_, index) => "$" + (index + 1)).join(", ")})`, insertValues);
    return undefined;
  }

  private where(spec: TableSpec): string {
    return spec.key.map((column, index) => quoted(column) + "=$" + (spec.columns.filter(item => item !== "revision").length + index + 1)).join(" AND ");
  }

  private whereValues(spec: TableSpec, row: Row, userId: string): unknown[] {
    return spec.key.map(column => column === "user_id" ? userId : row[column]);
  }

  private async removeRow(tx: DatabaseContext, spec: TableSpec, key: string, userId: string, retired: string[]): Promise<void> {
    const parts = keyParts(key);
    if (spec.columns.includes("user_id") && spec.key.length === 1 && spec.key[0] === "id") {
      const found = (await tx.query<{ user_id: string }>(`SELECT user_id FROM ${quoted(spec.name)} WHERE id=$1`, [parts[0]])).rows[0];
      if (found && found.user_id !== userId) throw new AppError(409, "sync_foreign_owner", "A record id belongs to another account. Nothing from this cycle was applied.");
      await this.rememberStorageKeys(tx, spec, parts[0], userId, retired);
      await tx.query(`DELETE FROM ${quoted(spec.name)} WHERE id=$1 AND user_id=$2`, [parts[0], userId]);
      return;
    }
    const columns = spec.key.filter(column => column !== "user_id");
    const probe: Row = {};
    spec.key.forEach((column, index) => { if (column !== "user_id") probe[column] = parts[columns.indexOf(column)]; });
    await this.assertParents(tx, spec, probe, userId);
    const values: unknown[] = [];
    const clause = spec.key.map(column => {
      values.push(column === "user_id" ? userId : parts[columns.indexOf(column)]);
      return quoted(column) + "=$" + values.length;
    }).join(" AND ");
    await tx.query(`DELETE FROM ${quoted(spec.name)} WHERE ${clause}`, values);
  }

  private async ownership(tx: DatabaseContext, spec: TableSpec, row: Row, userId: string): Promise<"missing" | "mine" | "foreign"> {
    if (spec.key.length === 1 && spec.key[0] === "id" && spec.columns.includes("user_id")) {
      const found = (await tx.query<{ user_id: string }>(`SELECT user_id FROM ${quoted(spec.name)} WHERE id=$1`, [row.id])).rows[0];
      if (!found) return "missing";
      return found.user_id === userId ? "mine" : "foreign";
    }
    const values: unknown[] = [];
    const clause = spec.key.map(column => { values.push(column === "user_id" ? userId : row[column]); return quoted(column) + "=$" + values.length; }).join(" AND ");
    const found = await tx.query(`SELECT 1 FROM ${quoted(spec.name)} WHERE ${clause}`, values);
    return found.rowCount ? "mine" : "missing";
  }

  private async applyChoice(userId: string, token: string, key: string, row: Row, sha: string | null, colliding: Row | undefined): Promise<void> {
    const columns = await this.columnMap();
    const spec = TABLES.find(table => table.name === tableOf(key));
    if (!spec) throw new AppError(422, "invalid_sync", "Unsupported sync record.");
    const files = sha ? new Map([[String(row.id), { data: "", sha256: sha }]]) : new Map<string, { data: string; sha256: string }>();
    if (sha) {
      let bytes: Buffer;
      try { bytes = await readCachedObject(this.deps.storageRoot, userId, sha); }
      catch { throw new AppError(409, "sync_stale", "The cloud file is not in the local cache. Run sync again before choosing it."); }
      files.set(String(row.id), { data: bytes.toString("base64"), sha256: sha });
    }
    if (colliding && syncKeyOf(spec.name, colliding) !== key) {
      await this.deps.database.query(`DELETE FROM ${quoted(spec.name)} WHERE id=$1 AND user_id=$2`, [colliding.id, userId]);
    }
    const captured = await this.capture(userId);
    await this.applyInbound(userId, token, captured.digest, [{ type: "apply-remote", key, row }], { tables: { [spec.name]: [row] }, hashes: new Map([[key, semanticHash(row, sha ?? undefined)]]), tombstones: [], files: sha ? [{ attachmentId: String(row.id), sha256: sha, data: files.get(String(row.id))!.data }] : [] }, columns);
  }

  private async deleteChoice(userId: string, token: string, key: string): Promise<void> {
    const columns = await this.columnMap();
    const captured = await this.capture(userId);
    await this.applyInbound(userId, token, captured.digest, [{ type: "delete-local", key }], null, columns);
  }

  private async anchor(userId: string, token: string, lease: string, remote: RemoteHead, plan: ReconstructedSync, actions: SyncAction[]): Promise<void> {
    const pending = new Set(actions.filter(action => action.type === "pending-local" || action.type === "conflict").map(action => action.key));
    await this.deps.database.withTransaction(async tx => {
      await this.requireUser(token, userId, tx);
      for (const [key, hash] of plan.hashes) {
        if (pending.has(key)) continue;
        const row = rowsOf(plan.tables).get(key);
        await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, high_score) VALUES ($1,$2,$3,false,$4)
          ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=EXCLUDED.base_hash, tombstoned=false, high_score=COALESCE(EXCLUDED.high_score, core.sync_row_state.high_score)`,
          [userId, key, hash, typeof row?.high_score === "number" ? row.high_score : null]);
      }
      for (const key of plan.tombstones) {
        if (pending.has(key)) continue;
        await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned) VALUES ($1,$2,NULL,true)
          ON CONFLICT (user_id, sync_key) DO UPDATE SET tombstoned=true, base_hash=NULL`, [userId, key]);
      }
      await tx.query(`UPDATE core.sync_bindings SET baseline_hash=$2, baseline_generation=$3, head_etag=$4, head_generation=$3, head_document=$5::jsonb,
        remote_op_token=$6, remote_content_hash=$7, phase=$8, last_error=NULL, backoff_until=NULL, backoff_attempt=0, updated_at=$9
        WHERE user_id=$1 AND lease_token=$10`, [
        userId, remote.head!.contentHash, remote.head!.generation, remote.etag, JSON.stringify(remote.head), remote.head!.opToken, remote.head!.contentHash,
        pending.size ? "bootstrap" : "linked", this.now(), lease,
      ]);
    });
  }

  private async commitBaseline(userId: string, token: string, lease: string, binding: Binding, captured: { snapshot: Snapshot; digest: string }, tombstones: readonly string[] = binding.pending_tombstones ?? []): Promise<void> {
    await this.deps.database.withTransaction(async tx => {
      await tx.query("SET LOCAL lock_timeout = '5s'");
      await tx.query("SET LOCAL statement_timeout = '30s'");
      const catalog = await readDataCatalog(tx, this.deps.installedApps());
      const locks = dataLockNames(["core.users", ...[...catalog.columns.keys()].filter(name => !name.startsWith("core."))]);
      await tx.query("LOCK TABLE " + locks.map(quoted).join(", ") + " IN SHARE ROW EXCLUSIVE MODE");
      await this.requireUser(token, userId, tx);
      const fresh = await captureOwnSnapshot(tx, this.snapshotOptions(userId));
      const open = (await tx.query<{ sync_key: string; remote_image: Row | null }>("SELECT sync_key, remote_image FROM core.sync_conflicts WHERE user_id=$1 AND state='open'", [userId])).rows;
      const conflictKeys = new Set(open.map(row => row.sync_key));
      const localTombs = [...await this.tombstones(userId, tx)];
      if (captureDigest(fresh, localTombs) !== (binding.pending_capture_hash ?? captured.digest)) {
        throw new AppError(409, "sync_local_drift", "Local data changed after upload. The baseline was not moved.");
      }
      const source = fresh;
      await tx.query("DELETE FROM core.sync_row_state WHERE user_id=$1 AND tombstoned=false AND NOT (sync_key = ANY($2::text[]))", [userId, [...conflictKeys]]);
      for (const [key, row] of rowsOf(source.tables)) {
        if (conflictKeys.has(key)) continue;
        const file = source.files.find(item => item.attachmentId === row.id)?.sha256;
        await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, high_score) VALUES ($1,$2,$3,false,$4)
          ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=EXCLUDED.base_hash, tombstoned=false, high_score=EXCLUDED.high_score`,
          [userId, key, semanticHash(row, file), typeof row.high_score === "number" ? row.high_score : null]);
      }
      for (const key of (tombstones.length ? tombstones : localTombs)) {
        if (conflictKeys.has(key)) continue;
        await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned) VALUES ($1,$2,NULL,true)
          ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=NULL, tombstoned=true`, [userId, key]);
      }
      await tx.query(`UPDATE core.sync_bindings SET baseline_hash=$2, baseline_generation=$3, phase='linked', pending_op_token=NULL, pending_content_hash=NULL,
        pending_capture_hash=NULL, pending_applied=false, pending_head=NULL, pending_tombstones='[]'::jsonb, pending_attempts=0, parent_op_token=NULL,
        parent_content_hash=NULL, parent_etag=NULL, last_error=NULL, backoff_until=NULL, backoff_attempt=0, updated_at=$4
        WHERE user_id=$1 AND lease_token=$5`, [userId, binding.remote_content_hash ?? binding.pending_content_hash, binding.head_generation ?? binding.baseline_generation, this.now(), lease]);
    });
  }

  private async journal(userId: string, lease: string, pending: { op: string; content: string; capture: string; parentOp: string | null; parentContent: string | null; parentEtag: string | null; head: SyncHead; tombstones: string[] }): Promise<void> {
    await this.deps.database.query(`UPDATE core.sync_bindings SET pending_op_token=$2, pending_content_hash=$3, pending_capture_hash=$4, pending_applied=false,
      parent_op_token=$5, parent_content_hash=$6, parent_etag=$7, pending_head=$8::jsonb, pending_tombstones=$9::jsonb, pending_attempts=0, updated_at=$10
      WHERE user_id=$1 AND lease_token=$11`, [userId, pending.op, pending.content, pending.capture, pending.parentOp, pending.parentContent, pending.parentEtag, JSON.stringify(pending.head), JSON.stringify(pending.tombstones), this.now(), lease]);
  }

  private async fetchHead(creds: { endpoint: string; username: string; password: string }, binding: Binding, budget: Budget, userId?: string, token?: string, lease?: string): Promise<RemoteHead> {
    if (userId && token && lease) await this.gate(userId, token, lease);
    const filename = syncHeadName(binding.identity_id);
    budget.use();
    let response: Awaited<ReturnType<typeof davExchange>>;
    try {
      response = await davExchange({ ...creds, method: "GET", filename, timeoutMs: budget.timeout(), ...(binding.head_etag ? { ifNoneMatch: binding.head_etag } : {}) });
    } catch (error) {
      if (httpStatus(error) === 404) return { missing: true, unchanged: false, etag: null, head: null };
      throw error;
    }
    if (response.status === 304) {
      if (!binding.head_document) throw new AppError(422, "invalid_sync", "The cloud copy was unchanged but its local head is missing.");
      return { missing: false, unchanged: true, etag: binding.head_etag, head: binding.head_document };
    }
    if (response.status === 404) return { missing: true, unchanged: false, etag: null, head: null };
    let etag = readStrongEtag(response.etag);
    if (!etag) {
      budget.use();
      const again = await davExchange({ ...creds, method: "GET", filename, timeoutMs: budget.timeout() });
      etag = readStrongEtag(again.etag);
      if (!etag) throw new AppError(422, "webdav_cas_unsupported", "WebDAV did not return a strong ETag for the sync head.", { step: "etag" });
      response.body = again.body;
    }
    const head = parseSyncHead(JSON.parse(response.body.toString("utf8")), binding.identity_id);
    if (head.pairingVerifier !== binding.pairing_verifier) throw new AppError(422, "invalid_sync", "Cloud pairing verifier does not match this link.");
    return { missing: false, unchanged: head.contentHash === binding.remote_content_hash && etag === binding.head_etag, etag, head };
  }

  private async materialize(userId: string, head: SyncHead, columns: Map<string, Column[]>, budget: Budget, token?: string, lease?: string): Promise<ReconstructedSync> {
    const creds = await this.deps.backups.syncCredentials(userId);
    return reconstructSyncDocument(head, async ref => {
      try { return await readCachedObject(this.deps.storageRoot, userId, ref.sha256); }
      catch {
        if (token && lease) await this.gate(userId, token, lease);
        budget.use();
        const response = await davExchange({ ...creds, method: "GET", filename: ref.filename, timeoutMs: budget.timeout() });
        if (response.body.length !== ref.size || digest(response.body) !== ref.sha256) throw new AppError(422, "invalid_sync", "Sync object size or SHA-256 differs from the head.");
        await writeCachedObject(this.deps.storageRoot, userId, ref.sha256, response.body);
        return response.body;
      }
    }, columns, userId);
  }

  private async putImmutable(userId: string, creds: { endpoint: string; username: string; password: string }, ref: SyncObjectRef, body: Buffer, budget: Budget): Promise<void> {
    budget.use();
    try {
      await davExchange({ ...creds, method: "PUT", filename: ref.filename, body, timeoutMs: budget.timeout() });
    } catch (error) {
      if (httpStatus(error) !== 412) throw error;
      budget.use();
      const current = await davExchange({ ...creds, method: "GET", filename: ref.filename, timeoutMs: budget.timeout() });
      if (current.body.length !== ref.size || digest(current.body) !== ref.sha256) throw new AppError(422, "invalid_sync", "An existing cloud object does not match its content hash.");
    }
    await this.deps.database.query("INSERT INTO core.sync_remote_objects (user_id, sha256, filename) VALUES ($1,$2,$3) ON CONFLICT (user_id, filename) DO UPDATE SET sha256=EXCLUDED.sha256", [userId, ref.sha256, ref.filename]);
    await writeCachedObject(this.deps.storageRoot, userId, ref.sha256, body);
  }

  private async putHead(creds: { endpoint: string; username: string; password: string }, identityId: string, body: Buffer, etag: string | null, budget: Budget): Promise<void> {
    budget.use();
    await davExchange({ ...creds, method: "PUT", filename: syncHeadName(identityId), body, timeoutMs: budget.timeout(), ...(etag ? { ifMatch: etag } : {}) });
  }

  private async confirmHead(creds: { endpoint: string; username: string; password: string }, identityId: string, body: Buffer, budget: Budget): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      budget.use();
      const response = await davExchange({ ...creds, method: "GET", filename: syncHeadName(identityId), timeoutMs: budget.timeout() });
      const etag = readStrongEtag(response.etag);
      if (etag && response.body.equals(body)) return etag;
      if (etag && !response.body.equals(body)) return null;
    }
    return null;
  }

  /** Accepted remote head, not a per-row conflict baseline. Equal generation with a different content hash is a rewrite. */
  private acceptedHeadRegressed(binding: Binding, head: SyncHead): boolean {
    const marks: { generation: number; contentHash: string }[] = [];
    const baseGen = binding.baseline_generation === null ? null : Number(binding.baseline_generation);
    const headGen = binding.head_generation === null ? null : Number(binding.head_generation);
    if (baseGen !== null && Number.isSafeInteger(baseGen) && binding.baseline_hash) marks.push({ generation: baseGen, contentHash: binding.baseline_hash });
    const headHash = binding.head_document?.contentHash ?? (headGen !== null && binding.remote_content_hash ? binding.remote_content_hash : null);
    if (headGen !== null && Number.isSafeInteger(headGen) && headHash) marks.push({ generation: headGen, contentHash: headHash });
    if (!marks.length) return false;
    const accepted = Math.max(...marks.map(mark => mark.generation));
    if (head.generation < accepted) return true;
    if (head.generation > accepted) return false;
    const hashes = new Set(marks.filter(mark => mark.generation === accepted).map(mark => mark.contentHash));
    return !hashes.has(head.contentHash);
  }

  /**
   * Record a fully validated inbound head. Moves the generation high-water and
   * non-conflict row baselines. Incomplete inbound materialize does not call this.
   * A partial outbound upload after this commit may leave the accepted remote generation in place.
   */
  private async acceptInboundHead(userId: string, lease: string, head: SyncHead, etag: string, plan: ReconstructedSync, conflicts: SyncAction[]): Promise<void> {
    const current = await this.binding(userId);
    if (!current || current.lease_token !== lease) throw new AppError(409, "sync_stopped", "Continuous sync stopped before the baseline was saved.");
    if (current.head_etag === etag && current.head_document?.contentHash === head.contentHash && Number(current.head_generation) === head.generation
      && (current.baseline_hash === null || (current.baseline_hash === head.contentHash && Number(current.baseline_generation) === head.generation))) return;
    await this.deps.database.withTransaction(async tx => {
      await this.writeAcceptedHead(tx, userId, lease, head, etag, plan, conflicts);
    });
  }

  /**
   * Persist the validated remote head in the caller's transaction. Baseline stays
   * unset until bootstrap anchoring finishes. An established baseline moves with the head.
   */
  private async writeAcceptedHead(tx: DatabaseContext, userId: string, lease: string, head: SyncHead, etag: string, plan: ReconstructedSync, conflicts: SyncAction[]): Promise<void> {
    const held = await tx.query("SELECT baseline_hash FROM core.sync_bindings WHERE user_id=$1 AND lease_token=$2 AND enabled=true FOR UPDATE", [userId, lease]);
    if (!held.rowCount) throw new AppError(409, "sync_stopped", "Continuous sync stopped before the baseline was saved.");
    const skip = new Set(conflicts.map(action => action.key));
    for (const [key, hash] of plan.hashes) {
      if (skip.has(key)) continue;
      const row = rowsOf(plan.tables).get(key);
      await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, high_score) VALUES ($1,$2,$3,false,$4)
        ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=EXCLUDED.base_hash, tombstoned=false, high_score=COALESCE(EXCLUDED.high_score, core.sync_row_state.high_score)`,
        [userId, key, hash, typeof row?.high_score === "number" ? row.high_score : null]);
    }
    for (const key of plan.tombstones) {
      if (skip.has(key)) continue;
      await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned) VALUES ($1,$2,NULL,true)
        ON CONFLICT (user_id, sync_key) DO UPDATE SET tombstoned=true, base_hash=NULL`, [userId, key]);
    }
    const marked = await tx.query(`UPDATE core.sync_bindings SET
      head_etag=$4, head_generation=$3, head_document=$5::jsonb, remote_op_token=$6, remote_content_hash=$2,
      baseline_generation=CASE WHEN baseline_hash IS NULL THEN baseline_generation ELSE $3 END,
      baseline_hash=CASE WHEN baseline_hash IS NULL THEN baseline_hash ELSE $2 END,
      updated_at=$7
      WHERE user_id=$1 AND lease_token=$8
      AND (head_generation IS NULL OR head_generation <= $3)
      AND (baseline_generation IS NULL OR baseline_generation <= $3)`,
      [userId, head.contentHash, head.generation, etag, JSON.stringify(head), head.opToken, this.now(), lease]);
    if (!marked.rowCount) throw new AppError(409, "sync_generation_regressed", "Remote sync generation moved backwards. The local baseline was kept.");
  }

  private async rememberConflicts(userId: string, actions: SyncAction[], etag: string | null, localContent: Map<string, string>, remoteContent: Map<string, string>, base: Map<string, string | { hash: string; highScore?: number }>): Promise<void> {
    for (const action of actions) {
      if (action.type !== "conflict") continue;
      const baseEntry = base.get(action.key);
      await this.deps.database.query(`INSERT INTO core.sync_conflicts (id, user_id, sync_key, reason, local_image, remote_image, base_image, base_hash, local_content_sha256, remote_content_sha256)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10)
        ON CONFLICT (user_id, sync_key) WHERE state='open' DO UPDATE SET reason=EXCLUDED.reason, local_image=EXCLUDED.local_image, remote_image=EXCLUDED.remote_image, base_hash=EXCLUDED.base_hash, base_image=EXCLUDED.base_image, local_content_sha256=EXCLUDED.local_content_sha256, remote_content_sha256=EXCLUDED.remote_content_sha256`,
        [randomUUID(), userId, action.key, action.reason, JSON.stringify(action.local ?? null), JSON.stringify(action.remote ?? null), null, typeof baseEntry === "string" ? baseEntry : baseEntry?.hash ?? null, localContent.get(action.key) ?? null, remoteContent.get(action.key) ?? null]);
    }
  }

  private interpret(result: { actions: SyncAction[]; invalid: string | null }, local: Map<string, Row>, remote: Map<string, Row>): { actions: SyncAction[]; invalid: string | null } {
    if (result.invalid) return result;
    const actions = result.actions.map(action => ({ ...action }));
    // Deletion, natural-key, and parent availability depend on each other.
    // Repeat until a pass changes nothing so a deferred child can block its parent delete.
    for (let pass = 0; pass < actions.length + 2; pass++) {
      let changed = false;
      const retiring = () => new Set(actions.filter(action => action.type === "delete-local" || action.type === "adopt-tombstone").map(action => action.key));
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index]!;
        if (action.type !== "delete-local" && action.type !== "adopt-tombstone") continue;
        const name = tableOf(action.key);
        const parent = local.get(action.key) ?? remote.get(action.key);
        const parentId = parent?.id ?? keyParts(action.key)[0];
        const gone = retiring();
        const childBusy = [...local.entries()].some(([key, row]) => {
          const child = TABLES.find(table => table.name === tableOf(key));
          if (!child?.parents || !Object.values(child.parents).includes(name)) return false;
          const column = Object.entries(child.parents).find(([, table]) => table === name)?.[0];
          if (!column || row[column] !== parentId) return false;
          const childAction = actions.find(item => item.key === key);
          if (childAction && (childAction.type === "delete-local" || childAction.type === "adopt-tombstone")) return false;
          if (childAction?.type === "apply-remote") return !this.parentAvailable(actions, local, remote, name, parentId) || gone.has(key);
          return true;
        }) || actions.some(item => item.type === "conflict" && item.remote && this.rowReferences(item.remote, name, parentId));
        if (childBusy) {
          actions[index] = { type: "conflict", key: action.key, reason: "parent-child", ...(parent ? { local: parent } : {}) };
          changed = true;
        }
      }
      const gone = retiring();
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index]!;
        if (action.type !== "apply-remote") continue;
        const name = tableOf(action.key);
        const spec = TABLES.find(table => table.name === name);
        if (spec?.natural) {
          const collision = [...local.entries()].find(([key, row]) => key.startsWith(name + ":") && key !== action.key && !gone.has(key) && row[spec.natural!] === action.row[spec.natural!]);
          if (collision) {
            actions[index] = { type: "conflict", key: action.key, reason: "natural-key", local: collision[1], remote: action.row };
            changed = true;
            continue;
          }
        }
        const missingParent = Object.entries(spec?.parents ?? {}).find(([column, parent]) => !this.parentAvailable(actions, local, remote, parent, action.row[column]));
        if (missingParent) {
          const localRow = local.get(action.key);
          actions[index] = { type: "conflict", key: action.key, reason: "parent-child", ...(localRow ? { local: localRow } : {}), remote: action.row };
          changed = true;
        }
      }
      if (!changed) break;
    }
    return { actions, invalid: null };
  }

  private rowReferences(row: Row, parentTable: string, parentId: unknown): boolean {
    return TABLES.some(table => Object.entries(table.parents ?? {}).some(([column, parent]) => parent === parentTable && row[column] === parentId));
  }

  /** A parent id is available when a non-conflict row with that id will still be here after this cycle. */
  private parentAvailable(actions: SyncAction[], local: Map<string, Row>, remote: Map<string, Row>, parentTable: string, parentId: unknown): boolean {
    if (typeof parentId !== "string") return false;
    const applied = actions.find(action => action.type === "apply-remote" && tableOf(action.key) === parentTable && action.row.id === parentId);
    if (applied) return true;
    for (const [key, row] of local) {
      if (!key.startsWith(parentTable + ":") || row.id !== parentId) continue;
      const action = actions.find(item => item.key === key);
      if (!action) return true;
      if (action.type === "delete-local" || action.type === "adopt-tombstone" || action.type === "publish-tombstone" || action.type === "conflict") return false;
      return true;
    }
    for (const [key, row] of remote) {
      if (!key.startsWith(parentTable + ":") || row.id !== parentId) continue;
      const action = actions.find(item => item.key === key);
      if (action?.type === "conflict" || action?.type === "publish-tombstone" || action?.type === "adopt-tombstone") return false;
      if (!action || action.type === "unchanged") return true;
    }
    return false;
  }

  /** Owned links that must move onto the surviving natural-key id. */
  private async captureRetarget(tx: DatabaseContext, parentTable: string, fromId: unknown, toId: unknown, userId: string): Promise<LinkMove[]> {
    if (typeof fromId !== "string" || typeof toId !== "string" || fromId === toId) return [];
    const moves: LinkMove[] = [];
    for (const child of TABLES) {
      const column = Object.entries(child.parents ?? {}).find(([, parent]) => parent === parentTable)?.[0];
      if (!column || child.key.length !== 2) continue;
      const other = child.key.find(key => key !== column)!;
      const otherParent = child.parents?.[other];
      if (!otherParent) continue;
      const owned = (await tx.query<{ other_id: string }>(
        `SELECT c.${quoted(other)} AS other_id FROM ${quoted(child.name)} c
         JOIN ${quoted(otherParent)} o ON o.id = c.${quoted(other)} AND o.user_id = $2
         JOIN ${quoted(parentTable)} p ON p.id = c.${quoted(column)} AND p.user_id = $2
         WHERE c.${quoted(column)} = $1`, [fromId, userId])).rows;
      for (const row of owned) {
        moves.push({ table: child.name, column, other, otherId: row.other_id, fromId, toId, oldKey: syncKeyOf(child.name, { [other]: row.other_id, [column]: fromId }), tombstoneHash: null, conflictId: null });
      }
    }
    const deferred = (await tx.query<{ id: string; sync_key: string; remote_image: Row | null }>(
      "SELECT id, sync_key, remote_image FROM core.sync_conflicts WHERE user_id=$1 AND state='open' AND reason='parent-child'", [userId])).rows;
    for (const row of deferred) {
      const image = row.remote_image;
      if (!image || !validSyncKey(row.sync_key)) continue;
      const child = TABLES.find(item => item.name === tableOf(row.sync_key));
      const column = child ? Object.entries(child.parents ?? {}).find(([, parent]) => parent === parentTable)?.[0] : undefined;
      if (!child || !column || child.key.length !== 2) continue;
      if (syncKeyOf(child.name, image) !== row.sync_key) continue;
      if (image[column] !== fromId && image[column] !== toId) continue;
      const other = child.key.find(key => key !== column)!;
      if (typeof image[other] !== "string") continue;
      const pointed = String(image[column]);
      moves.push({
        table: child.name, column, other, otherId: image[other], fromId: pointed, toId, oldKey: row.sync_key, conflictId: row.id,
        tombstoneHash: pointed === fromId ? semanticHash(image) : null,
      });
    }
    return moves;
  }

  private async deleteCapturedLinks(tx: DatabaseContext, moves: LinkMove[], userId: string): Promise<void> {
    for (const move of moves) {
      const child = TABLES.find(item => item.name === move.table)!;
      const parentTable = child.parents?.[move.column];
      const otherParent = child.parents?.[move.other];
      if (!parentTable || !otherParent) continue;
      await tx.query(
        `DELETE FROM ${quoted(move.table)} c
         USING ${quoted(otherParent)} o, ${quoted(parentTable)} p
         WHERE c.${quoted(move.other)} = o.id AND c.${quoted(move.column)} = p.id
         AND c.${quoted(move.other)} = $1 AND c.${quoted(move.column)} = $2
         AND o.user_id = $3 AND p.user_id = $3`,
        [move.otherId, move.fromId, userId]);
    }
  }

  private async restoreCapturedLinks(tx: DatabaseContext, moves: LinkMove[], userId: string, choice: "keep-local" | "keep-remote"): Promise<void> {
    const closed: string[] = [];
    for (const move of moves) {
      const child = TABLES.find(item => item.name === move.table)!;
      const parentTable = child.parents?.[move.column];
      const otherParent = child.parents?.[move.other];
      if (!parentTable || !otherParent) continue;
      await tx.query(
        `INSERT INTO ${quoted(move.table)} (${quoted(move.other)}, ${quoted(move.column)})
         SELECT $1, $2
         WHERE EXISTS (SELECT 1 FROM ${quoted(otherParent)} WHERE id=$1 AND user_id=$3)
           AND EXISTS (SELECT 1 FROM ${quoted(parentTable)} WHERE id=$2 AND user_id=$3)
         ON CONFLICT DO NOTHING`,
        [move.otherId, move.toId, userId]);
      if (move.tombstoneHash) {
        await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, revive) VALUES ($1,$2,$3,true,false)
          ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=EXCLUDED.base_hash, tombstoned=true, revive=false`,
          [userId, move.oldKey, move.tombstoneHash]);
      }
      if (move.conflictId) closed.push(move.conflictId);
    }
    if (closed.length) {
      await tx.query("UPDATE core.sync_conflicts SET state='resolved', resolution=$3 WHERE user_id=$1 AND id = ANY($2::uuid[]) AND state='open' AND reason='parent-child'", [userId, closed, choice]);
    }
  }

  private async noteFailure(userId: string, error: unknown, ambiguousHead: boolean): Promise<void> {
    const message = redactSyncText(error instanceof Error ? error.message : "Sync failed.").slice(0, 500);
    const status = httpStatus(error);
    const transport = error instanceof AppError && (error.code === "webdav_unreachable" || status === 429);
    if (ambiguousHead) {
      await this.deps.database.query("UPDATE core.sync_bindings SET phase='publication_unknown', last_error=$2, updated_at=$3 WHERE user_id=$1", [userId, message, this.now()]);
      return;
    }
    if (transport) {
      const attempt = Number((await this.deps.database.query<{ backoff_attempt: number }>("SELECT backoff_attempt FROM core.sync_bindings WHERE user_id=$1", [userId])).rows[0]?.backoff_attempt ?? 0) + 1;
      const base = Math.min(30 * 60 * 1000, 1000 * 2 ** Math.min(attempt, 10));
      const delay = base + Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.2)));
      await this.deps.database.query("UPDATE core.sync_bindings SET last_error=$2, backoff_until=$3, backoff_attempt=$4, updated_at=$5 WHERE user_id=$1", [userId, message, new Date(this.now().getTime() + delay), attempt, this.now()]);
      return;
    }
    await this.deps.database.query("UPDATE core.sync_bindings SET last_error=$2, updated_at=$3 WHERE user_id=$1", [userId, message, this.now()]);
  }

  private async columnMap(): Promise<Map<string, Column[]>> {
    const catalog = await this.deps.database.withTransaction(tx => readDataCatalog(tx, this.deps.installedApps()));
    return new Map([...catalog.columns].filter(([name]) => !name.startsWith("core.")));
  }

  private snapshotOptions(userId: string): SnapshotOptions {
    return { database: this.deps.database, storageRoot: this.deps.storageRoot, actor: { id: userId, role: "user" }, scope: "own", installedApps: this.deps.installedApps() };
  }

  private async finish(userId: string, lease: string, status: SyncStatus): Promise<SyncStatus> {
    if (status.result && ["published", "committed", "idle", "conflicted", "bootstrap"].includes(status.result)) {
      // A validated cycle observed the committed rows. Clear a local apply/resolve
      // whose commit acknowledgement was lost only when no head op is still pending.
      const cleared = await this.deps.database.query(`UPDATE core.sync_bindings SET phase=CASE WHEN baseline_hash IS NULL THEN 'bootstrap' ELSE 'linked' END, last_error=NULL, updated_at=$3
        WHERE user_id=$1 AND lease_token=$2 AND phase='publication_unknown' AND pending_op_token IS NULL RETURNING user_id`, [userId, lease, this.now()]);
      try { await this.retainLocal(userId, lease); }
      catch (error) {
        if (error instanceof Error && (error.message === "Unsafe sync retention path" || error.message === "Invalid sync retention identity")) throw error;
      }
      if (cleared.rowCount) {
        const fresh = await this.status(userId);
        return { ...fresh, result: status.result, dataChanged: status.dataChanged };
      }
    }
    return status;
  }

  /** Lease is still held. Skip while a publication is pending or its commit is unknown. */
  private async retainLocal(userId: string, lease: string): Promise<void> {
    const binding = await this.binding(userId);
    if (!binding || binding.lease_token !== lease || binding.pending_op_token || binding.phase === "publication_unknown") return;
    const conflicts = (await this.deps.database.query<{ local_content_sha256: string | null; remote_content_sha256: string | null }>(
      "SELECT local_content_sha256, remote_content_sha256 FROM core.sync_conflicts WHERE user_id=$1 AND state='open'", [userId])).rows;
    const stored = (await this.deps.database.query<{ storage_key: string | null }>(
      "SELECT storage_key FROM assets.attachments WHERE user_id=$1", [userId])).rows;
    const refs = collectSyncRetentionRefs({
      heads: [binding.head_document, binding.pending_head],
      conflictHashes: conflicts.flatMap(row => [row.local_content_sha256, row.remote_content_sha256]),
      storageKeys: stored.map(row => row.storage_key).filter((key): key is string => typeof key === "string"),
    });
    await pruneSyncLocalFiles({ root: this.deps.storageRoot, userId, cacheHashes: refs.cacheHashes, storageKeys: refs.storageKeys });
  }

  private async capture(userId: string): Promise<{ snapshot: Snapshot; digest: string }> {
    const snapshot = await captureOwnSnapshotOn(this.deps.database, this.snapshotOptions(userId));
    const tombstones = await this.tombstones(userId);
    return { snapshot, digest: captureDigest(snapshot, [...tombstones]) };
  }

  private async binding(userId: string): Promise<Binding | undefined> {
    return (await this.deps.database.query<Binding>("SELECT * FROM core.sync_bindings WHERE user_id=$1", [userId])).rows[0];
  }

  private async baseline(userId: string): Promise<Map<string, string | { hash: string; highScore?: number }>> {
    const rows = (await this.deps.database.query<{ sync_key: string; base_hash: string | null; high_score: number | null; tombstoned: boolean }>("SELECT sync_key, base_hash, high_score, tombstoned FROM core.sync_row_state WHERE user_id=$1 AND base_hash IS NOT NULL", [userId])).rows;
    return new Map(rows.filter(row => row.base_hash).map(row => [row.sync_key, row.high_score === null ? row.base_hash! : { hash: row.base_hash!, highScore: row.high_score }]));
  }

  private async tombstones(userId: string, tx: DatabaseContext = this.deps.database.context()): Promise<Set<string>> {
    const rows = (await tx.query<{ sync_key: string }>("SELECT sync_key FROM core.sync_row_state WHERE user_id=$1 AND tombstoned=true", [userId])).rows;
    return new Set(rows.map(row => row.sync_key));
  }

  private async reviveKeys(userId: string): Promise<Set<string>> {
    const rows = (await this.deps.database.query<{ sync_key: string }>("SELECT sync_key FROM core.sync_row_state WHERE user_id=$1 AND revive=true", [userId])).rows;
    return new Set(rows.map(row => row.sync_key));
  }

  private async knownRemote(userId: string): Promise<Set<string>> {
    const rows = (await this.deps.database.query<{ sha256: string; filename: string | null }>("SELECT sha256, filename FROM core.sync_remote_objects WHERE user_id=$1", [userId])).rows;
    const names = new Set<string>();
    for (const row of rows) if (row.filename) names.add(row.filename);
    return names;
  }

  private async conflictCount(userId: string): Promise<number> {
    return Number((await this.deps.database.query<{ count: string }>("SELECT count(*)::text AS count FROM core.sync_conflicts WHERE user_id=$1 AND state='open'", [userId])).rows[0]?.count ?? 0);
  }

  private view(binding: Binding | undefined, openConflicts: number): SyncStatus {
    return {
      linked: Boolean(binding) && binding?.phase !== "probing",
      enabled: binding?.enabled ?? false,
      phase: binding?.phase ?? "unlinked",
      intervalSeconds: binding?.interval_seconds ?? 120,
      identityId: binding?.identity_id ?? null,
      openConflicts, lastError: binding?.last_error ?? null,
      backoffUntil: binding?.backoff_until ? new Date(binding.backoff_until).toISOString() : null,
      baseline: Boolean(binding?.baseline_hash),
      pending: Boolean(binding?.pending_op_token),
    };
  }

  private async requireUser(token: string, userId: string, db: DatabaseContext = this.deps.database.context()): Promise<void> {
    const user = await resolveSession(db, token, this.now());
    if (!user || user.id !== userId) throw new AppError(401, "auth_required", "Sign in to sync.");
  }

  private async clearProbe(userId: string): Promise<void> {
    await this.deps.database.query("DELETE FROM core.sync_bindings WHERE user_id=$1 AND enabled=false AND phase='probing'", [userId]);
  }

  private async insertBinding(userId: string, identityId: string, verifier: string, secret: string, creds: { endpoint: string; username: string }, origin: "create" | "join"): Promise<void> {
    await this.deps.database.withTransaction(async tx => {
      await tx.query("SELECT user_id FROM core.backup_targets WHERE user_id=$1 FOR UPDATE", [userId]);
      const target = (await tx.query<{ endpoint: string; username: string }>("SELECT endpoint, username FROM core.backup_targets WHERE user_id=$1", [userId])).rows[0];
      if (!target || target.endpoint !== creds.endpoint || target.username !== creds.username) {
        throw new AppError(409, "sync_destination_locked", "The WebDAV destination changed before the link was saved.");
      }
      await tx.query("SELECT user_id FROM core.sync_bindings WHERE user_id=$1 FOR UPDATE", [userId]);
      await tx.query(`INSERT INTO core.sync_bindings (user_id, identity_id, replica_id, destination_endpoint, destination_username, pairing_verifier, pairing_secret_ciphertext, enabled, phase, origin)
        VALUES ($1,$2,$3,$4,$5,$6,$7,false,'probing',$8)`, [userId, identityId, randomUUID(), creds.endpoint, creds.username, verifier, secret, origin]);
    });
  }

  private async gate(userId: string, token: string, lease: string): Promise<void> {
    await this.requireUser(token, userId);
    const binding = await this.binding(userId);
    if (!binding?.enabled || binding.lease_token !== lease) throw new AppError(409, "sync_stopped", "Continuous sync stopped before the next cloud request.");
    if (!binding.lease_until || new Date(binding.lease_until).getTime() <= this.now().getTime()) throw new AppError(409, "sync_stopped", "The sync lease expired before the next cloud request.");
    const creds = await this.deps.backups.syncCredentials(userId);
    if (creds.endpoint !== binding.destination_endpoint || creds.username !== binding.destination_username) {
      throw new AppError(409, "sync_destination_locked", "Unlink continuous sync before using a different WebDAV destination.");
    }
  }

  private async rejectIfBusy(userId: string): Promise<void> {
    const row = (await this.deps.database.query<{ lease_until: Date | null }>("SELECT lease_until FROM core.sync_bindings WHERE user_id=$1", [userId])).rows[0];
    if (row?.lease_until && new Date(row.lease_until).getTime() > this.now().getTime()) throw new AppError(409, "sync_busy", "Continuous sync is running. Wait until the current cycle finishes.");
  }

  private async readIdentityHead(creds: { endpoint: string; username: string; password: string }, identityId: string): Promise<SyncHead | null> {
    try {
      const response = await davExchange({ ...creds, method: "GET", filename: syncHeadName(identityId), timeoutMs: 30_000 });
      if (response.status === 404) return null;
      return parseSyncHead(JSON.parse(response.body.toString("utf8")), identityId);
    } catch (error) {
      if (httpStatus(error) === 404) return null;
      throw error;
    }
  }

  private conflictLocalRow(key: string, image: Row | null, rows: Map<string, Row>): Row | undefined {
    const direct = rows.get(key);
    if (direct) return direct;
    if (!image) return undefined;
    const table = tableOf(key);
    return [...rows.entries()].find(([candidate, row]) => candidate.startsWith(table + ":") && row.id === image.id)?.[1];
  }

  private async assertParents(tx: DatabaseContext, spec: TableSpec, row: Row, userId: string): Promise<void> {
    for (const [column, parent] of Object.entries(spec.parents ?? {})) {
      const parentSpec = TABLES.find(table => table.name === parent);
      if (!parentSpec?.columns.includes("user_id")) continue;
      const found = (await tx.query<{ user_id: string }>(`SELECT user_id FROM ${quoted(parent)} WHERE id=$1`, [row[column]])).rows[0];
      if (!found) continue;
      if (found.user_id !== userId) throw new AppError(409, "sync_foreign_owner", "A related record belongs to another account. Nothing from this cycle was applied.");
    }
  }

  /** Record attachment bytes before a delete. Item delete cascades attachment rows. */
  private async rememberStorageKeys(tx: DatabaseContext, spec: TableSpec, id: unknown, userId: string, retired: string[]): Promise<void> {
    if (spec.name === "assets.attachments") {
      const row = (await tx.query<{ storage_key: string | null }>("SELECT storage_key FROM assets.attachments WHERE id=$1 AND user_id=$2", [id, userId])).rows[0];
      if (row?.storage_key) retired.push(row.storage_key);
      return;
    }
    if (spec.name === "assets.items") {
      const rows = (await tx.query<{ storage_key: string | null }>("SELECT storage_key FROM assets.attachments WHERE item_id=$1 AND user_id=$2", [id, userId])).rows;
      for (const row of rows) if (row.storage_key) retired.push(row.storage_key);
    }
  }

  private async discardStaged(paths: string[]): Promise<void> {
    for (const path of paths) {
      const info = await lstat(path).catch(() => undefined);
      if (!info || info.isSymbolicLink() || !info.isFile()) continue;
      await unlink(path).catch(() => undefined);
    }
  }

  private async retireFiles(userId: string, keys: string[]): Promise<void> {
    const seen = new Set<string>();
    for (const key of keys) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let canonical: string;
      try { canonical = sanitizeKey(key); }
      catch { continue; }
      if (canonical !== key) continue;
      const used = await this.deps.database.query("SELECT 1 FROM assets.attachments WHERE user_id=$1 AND storage_key=$2", [userId, key]);
      if (used.rowCount) continue;
      await this.unlinkOwnedFile(userId, canonical);
    }
  }

  /** Unlink one user file. The storage root may be a mount; no descendant symlink is followed. */
  private async unlinkOwnedFile(userId: string, key: string): Promise<void> {
    const root = resolve(this.deps.storageRoot);
    const rootInfo = await lstat(root).catch(() => undefined);
    if (!rootInfo || (!rootInfo.isDirectory() && !rootInfo.isSymbolicLink())) return;
    let rootReal: string;
    try { rootReal = await realpath(root); }
    catch { return; }
    const parts = ["users", userId, "apps", "assets", ...key.split("/")];
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (part.length === 0 || part === "." || part === "..") return;
      current = join(current, part);
      const info = await lstat(current).catch(() => undefined);
      if (!info || info.isSymbolicLink()) return;
      let real: string;
      try { real = await realpath(current); }
      catch { return; }
      const rel = relative(rootReal, real);
      if (rel.startsWith("..") || isAbsolute(rel)) return;
      const last = index === parts.length - 1;
      if (!last) {
        if (!info.isDirectory()) return;
        continue;
      }
      if (!info.isFile()) return;
      await unlink(current);
    }
  }

  private async anchorPublished(userId: string, token: string, lease: string, head: SyncHead, snapshot: Snapshot, tombstones: readonly string[], etag: string, conflictKeys: readonly string[]): Promise<void> {
    const skip = new Set(conflictKeys);
    await this.deps.database.withTransaction(async tx => {
      await this.requireUser(token, userId, tx);
      const held = await tx.query("SELECT user_id FROM core.sync_bindings WHERE user_id=$1 AND lease_token=$2 AND enabled=true FOR UPDATE", [userId, lease]);
      if (!held.rowCount) throw new AppError(409, "sync_stopped", "Continuous sync stopped before the baseline was saved.");
      for (const [key, row] of rowsOf(snapshot.tables)) {
        if (skip.has(key)) continue;
        const file = snapshot.files.find(item => item.attachmentId === row.id)?.sha256;
        await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, high_score) VALUES ($1,$2,$3,false,$4)
          ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=EXCLUDED.base_hash, tombstoned=false, high_score=EXCLUDED.high_score`,
          [userId, key, semanticHash(row, file), typeof row.high_score === "number" ? row.high_score : null]);
      }
      const liveKeys = new Set(rowsOf(snapshot.tables).keys());
      for (const key of tombstones) {
        if (skip.has(key) || liveKeys.has(key)) continue;
        await tx.query(`INSERT INTO core.sync_row_state (user_id, sync_key, base_hash, tombstoned, revive) VALUES ($1,$2,NULL,true,false)
          ON CONFLICT (user_id, sync_key) DO UPDATE SET base_hash=NULL, tombstoned=true, revive=false`, [userId, key]);
      }
      await tx.query("UPDATE core.sync_row_state SET revive=false WHERE user_id=$1 AND revive=true AND NOT (sync_key = ANY($2::text[]))", [userId, [...skip]]);
      await tx.query(`UPDATE core.sync_bindings SET baseline_hash=$2, baseline_generation=$3, phase='linked', head_etag=$4, head_generation=$3, head_document=$5::jsonb,
        remote_op_token=$6, remote_content_hash=$2, pending_op_token=NULL, pending_content_hash=NULL, pending_capture_hash=NULL, pending_applied=false,
        pending_head=NULL, pending_tombstones='[]'::jsonb, pending_attempts=0, parent_op_token=NULL, parent_content_hash=NULL, parent_etag=NULL,
        last_error=NULL, backoff_until=NULL, backoff_attempt=0, updated_at=$7
        WHERE user_id=$1 AND lease_token=$8`, [userId, head.contentHash, head.generation, etag, JSON.stringify(head), head.opToken, this.now(), lease]);
    });
  }
}

class Budget {
  remaining: number;
  readonly deadline: number;
  constructor(limit: number, deadline: number) { this.remaining = limit; this.deadline = deadline; }
  use(): void {
    if (Date.now() >= this.deadline) throw new BudgetStop();
    if (this.remaining <= 0) throw new BudgetStop();
    this.remaining -= 1;
  }
  timeout(): number { return Math.max(1, Math.min(30_000, this.deadline - Date.now())); }
}

/** Hashes and storage keys retention must not delete after a completed cycle. */
export function collectSyncRetentionRefs(input: {
  heads: readonly (SyncHead | null | undefined)[];
  conflictHashes: readonly (string | null | undefined)[];
  storageKeys: readonly string[];
}): { cacheHashes: Set<string>; storageKeys: Set<string> } {
  const cacheHashes = new Set<string>();
  for (const head of input.heads) {
    if (!head) continue;
    cacheHashes.add(head.tombstones.sha256);
    for (const file of head.files) cacheHashes.add(file.object.sha256);
    for (const buckets of Object.values(head.tables)) for (const bucket of buckets) cacheHashes.add(bucket.object.sha256);
  }
  for (const hash of input.conflictHashes) if (hash) cacheHashes.add(hash);
  return { cacheHashes, storageKeys: new Set(input.storageKeys) };
}

interface LinkMove {
  table: string;
  column: string;
  other: string;
  otherId: string;
  fromId: string;
  toId: string;
  oldKey: string;
  tombstoneHash: string | null;
  conflictId: string | null;
}

function publicationSnapshot(local: Snapshot, plan: ReconstructedSync | null, actions: SyncAction[]): { snapshot: Snapshot; tombstones: string[] } {
  const conflicts = new Set(actions.filter(action => action.type === "conflict").map(action => action.key));
  const drop = new Set(actions.filter(action => action.type === "publish-tombstone" || action.type === "adopt-tombstone").map(action => action.key));
  const pending = new Set(actions.filter(action => action.type === "pending-local" || action.type === "raise-high-score").map(action => action.key));
  const remoteRows = plan ? rowsOf(plan.tables) : new Map<string, Row>();
  const localRows = rowsOf(local.tables);
  const held = heldLocalKeys(actions, localRows);
  const chosen = new Map<string, Row>();
  for (const key of new Set([...remoteRows.keys(), ...localRows.keys()])) {
    if (drop.has(key)) continue;
    if (conflicts.has(key)) {
      const remote = remoteRows.get(key);
      if (remote) chosen.set(key, remote);
      continue;
    }
    if (held.has(key)) continue;
    if (!plan || pending.has(key)) {
      const row = localRows.get(key);
      if (row) chosen.set(key, row);
      continue;
    }
    const remote = remoteRows.get(key);
    if (remote) chosen.set(key, remote);
  }
  const tables: Record<string, Row[]> = {};
  for (const name of Object.keys(local.tables)) tables[name] = [];
  const stripped = new Set<string>();
  for (let pass = 0; pass < chosen.size + 2; pass++) {
    let removed = false;
    for (const [key, row] of [...chosen]) {
      const spec = TABLES.find(table => table.name === tableOf(key));
      const missing = Object.entries(spec?.parents ?? {}).some(([column, parent]) => ![...chosen].some(([candidate, parentRow]) => candidate.startsWith(parent + ":") && parentRow.id === row[column]));
      if (missing) { chosen.delete(key); stripped.add(key); removed = true; }
    }
    if (!removed) break;
  }
  for (const [key, row] of chosen) tables[tableOf(key)]!.push(row);
  const files: Snapshot["files"] = [];
  for (const row of tables["assets.attachments"] ?? []) {
    const key = syncKeyOf("assets.attachments", row);
    const remoteFile = plan?.files.find(file => file.attachmentId === row.id);
    const localFile = local.files.find(file => file.attachmentId === row.id);
    const file = conflicts.has(key) ? remoteFile : (localFile ?? remoteFile);
    if (file) files.push({ attachmentId: file.attachmentId, sha256: file.sha256, data: file.data });
  }
  const droppedChildren = [...new Set([...remoteRows.keys(), ...localRows.keys()])].filter(key => !chosen.has(key) && (stripped.has(key) || drop.has(key) || (!conflicts.has(key) && remoteRows.has(key))));
  const tombstones = [...new Set([...(plan?.tombstones ?? []), ...drop, ...stripped, ...droppedChildren])].filter(key => !chosen.has(key)).sort();
  return { snapshot: { ...local, tables, files }, tombstones };
}

function previewApply(local: Snapshot, actions: SyncAction[], plan: ReconstructedSync | null): Snapshot {
  const tables: Record<string, Row[]> = {};
  for (const name of Object.keys(local.tables)) tables[name] = [...(local.tables[name] ?? [])];
  const rows = rowsOf(tables);
  for (const action of actions) {
    if (action.type === "delete-local" || action.type === "adopt-tombstone") rows.delete(action.key);
    if (action.type === "apply-remote") rows.set(action.key, action.row);
  }
  for (const name of Object.keys(tables)) tables[name] = [];
  for (const [key, row] of rows) (tables[tableOf(key)] ??= []).push(row);
  const files: Snapshot["files"] = [];
  for (const row of tables["assets.attachments"] ?? []) {
    const key = syncKeyOf("assets.attachments", row);
    const action = actions.find(item => item.key === key);
    const remoteFile = plan?.files.find(file => file.attachmentId === String(row.id));
    const localFile = local.files.find(file => file.attachmentId === String(row.id));
    const file = action?.type === "apply-remote" ? remoteFile : (localFile ?? remoteFile);
    if (file) files.push({ attachmentId: String(row.id), sha256: file.sha256, data: file.data });
  }
  return { ...local, tables, files };
}

/** Conflict rows and local rows that would duplicate them, plus dependent children, stay out of the outbound head. */
function heldLocalKeys(actions: SyncAction[], localRows: Map<string, Row>): Set<string> {
  const held = new Set<string>();
  for (const action of actions) {
    if (action.type !== "conflict" || !action.local) continue;
    const spec = TABLES.find(table => table.name === tableOf(action.key));
    if (!spec) continue;
    held.add(syncKeyOf(spec.name, action.local));
    if (action.reason === "parent-child" && action.local.id !== undefined) {
      for (const [key, row] of localRows) {
        const child = TABLES.find(table => table.name === tableOf(key));
        const column = Object.entries(child?.parents ?? {}).find(([, parent]) => parent === spec.name)?.[0];
        if (column && row[column] === action.local.id) held.add(key);
      }
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, row] of localRows) {
      if (held.has(key)) continue;
      const spec = TABLES.find(table => table.name === tableOf(key));
      for (const [column, parent] of Object.entries(spec?.parents ?? {})) {
        for (const parentKey of held) {
          if (!parentKey.startsWith(parent + ":")) continue;
          const parentRow = localRows.get(parentKey);
          const parentId = parentRow?.id ?? keyParts(parentKey)[0];
          if (row[column] === parentId) { held.add(key); grew = true; }
        }
      }
    }
  }
  for (const key of [...held]) if (actions.some(action => action.type === "conflict" && action.key === key)) held.delete(key);
  return held;
}

function captureOwnSnapshotOn(database: Database, options: SnapshotOptions): Promise<Snapshot> {
  return database.withTransaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await tx.query("SET LOCAL statement_timeout = '30s'");
    return captureOwnSnapshot(tx, options);
  });
}

export function captureDigest(snapshot: Snapshot, tombstones: readonly string[]): string {
  const tables: Record<string, Row[]> = {};
  for (const name of Object.keys(snapshot.tables).sort()) {
    const spec = TABLES.find(table => table.name === name)!;
    tables[name] = snapshot.tables[name]!.map(row => projectRow(row)).sort((a, b) => keyOf(a, spec.key) < keyOf(b, spec.key) ? -1 : 1);
  }
  const files = snapshot.files.map(file => ({ attachmentId: file.attachmentId, sha256: file.sha256 })).sort((a, b) => a.attachmentId < b.attachmentId ? -1 : 1);
  return digest(Buffer.from(canonicalJson({ tables, files, tombstones: [...tombstones].sort() })));
}

function contentOf(snapshot: Snapshot): Map<string, string> {
  const files = new Map(snapshot.files.map(file => [file.attachmentId, file.sha256]));
  const map = new Map<string, string>();
  for (const row of snapshot.tables["assets.attachments"] ?? []) {
    const sha = files.get(String(row.id));
    if (sha) map.set(syncKeyOf("assets.attachments", row), sha);
  }
  return map;
}

function contentOfPlan(plan: ReconstructedSync): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of plan.files) {
    const row = (plan.tables["assets.attachments"] ?? []).find(item => item.id === file.attachmentId);
    if (row) map.set(syncKeyOf("assets.attachments", row), file.sha256);
  }
  return map;
}

function rowsOf(tables: Record<string, Row[]>): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const [name, rows] of Object.entries(tables)) for (const row of rows ?? []) map.set(syncKeyOf(name, row), row);
  return map;
}

function substituteConflicts(snapshot: Snapshot, conflicts: SyncAction[]): Snapshot {
  const copy: Snapshot = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  for (const action of conflicts) {
    if (action.type !== "conflict" || !action.remote) continue;
    const name = tableOf(action.key);
    const rows = copy.tables[name];
    if (!rows) continue;
    const index = rows.findIndex(row => syncKeyOf(name, row) === action.key);
    if (index >= 0) rows[index] = { ...rows[index], ...projectRow(action.remote), user_id: rows[index]!.user_id };
  }
  return copy;
}

function objectNames(head: SyncHead): string[] {
  return [
    ...Object.values(head.tables).flatMap(buckets => buckets.map(bucket => bucket.object.filename)),
    ...head.files.map(file => file.object.filename),
    head.tombstones.filename,
  ];
}

function tableOf(key: string): string { return key.slice(0, key.indexOf(":")); }
function keyParts(key: string): unknown[] { return JSON.parse(key.slice(key.indexOf(":") + 1)) as unknown[]; }
function quoted(name: string): string { return name.split(".").map(part => '"' + part + '"').join("."); }
function httpStatus(error: unknown): number | undefined {
  return error instanceof AppError ? (error.details as { status?: number } | undefined)?.status : undefined;
}
