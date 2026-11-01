import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../database/index.js";
import { AppError } from "../api/errors.js";
import { backupKey, decryptPassword, encryptPassword } from "./credentials.js";
import { davRequest, davHead, normalizeEndpoint, type DavRequest } from "./webdav-http.js";
import { exportSnapshot, MAX_SNAPSHOT_BYTES } from "./snapshot.js";
import { buildIncremental, parseManifest, getObjectRefs, reconstructManifest, fingerprintManifest, type ObjectRef } from "./incremental.js";

export interface BackupActor { id: string; role: "admin" | "user" }
export type BackupScope = "own" | "all";
export interface WebdavInput { endpoint: string; username: string; password?: string; scope: BackupScope; intervalHours: number }
interface Target {
  user_id: string; endpoint: string; username: string; password_ciphertext: string;
  scope: BackupScope; interval_hours: number; next_run_at: Date | null;
  last_run_at: Date | null; last_status: string | null; last_error: string | null;
  lease_until: Date | null; lease_token: string | null;
  revision: number;
}
export type BackupMode = "incremental" | "full";
interface History {
  id: string; endpoint: string; filename: string; scope: BackupScope; size_bytes: number; sha256: string; created_at: Date;
  kind: BackupMode; namespace: string | null; content_fingerprint: string | null; destination_username: string | null;
  logical_size_bytes: number; uploaded_bytes: string | number; uploaded_objects: number;
}
export interface BackupRunResult {
  status: "created" | "unchanged";
  backup: ReturnType<typeof historyView> | null;
  uploadedBytes: number;
  uploadedObjects: number;
}

const REMOTE_BUDGET_MS = 180_000;
// Canonical refs plus their row JSON overhead remain below the snapshot limit;
// allow bounded re-reads for 412 crash recovery, old manifest and reconstruction.
const REMOTE_READ_LIMIT = MAX_SNAPSHOT_BYTES * 3;
export function backupNamespace(actorId: string, endpoint: string, username: string, scope: BackupScope): string {
  return createHash("sha256").update(JSON.stringify([actorId, endpoint, username, scope])).digest("hex");
}

export function checkScope(actor: BackupActor, scope: BackupScope): void {
  if (scope !== "own" && scope !== "all") throw new AppError(422, "invalid_scope", "Choose own or all data.");
  if (scope === "all" && actor.role !== "admin") throw new AppError(403, "forbidden", "Only administrators can manage all data.");
}

function view(row?: Target) {
  return {
    configured: Boolean(row), endpoint: row?.endpoint ?? "", username: row?.username ?? "",
    hasPassword: Boolean(row?.password_ciphertext), scope: row?.scope ?? "own",
    intervalHours: row?.interval_hours ?? 0, nextRunAt: row?.next_run_at?.toISOString() ?? null,
    lastRunAt: row?.last_run_at?.toISOString() ?? null, lastStatus: row?.last_status ?? null, lastError: row?.last_error ?? null,
  };
}
function historyView(row: History, endpoint?: string, role?: string, username?: string) {
  return { id: row.id, filename: row.filename, scope: row.scope, size: row.logical_size_bytes, createdAt: row.created_at.toISOString(),
    kind: row.kind, uploadedBytes: Number(row.uploaded_bytes), uploadedObjects: row.uploaded_objects,
    available: row.endpoint === endpoint && (row.destination_username === null || row.destination_username === username) && (row.scope !== "all" || role === "admin") };
}

export class WebdavBackups {
  private stopped = false;
  private pending = new Set<Promise<unknown>>();
  constructor(private readonly deps: {
    database: Database; storageRoot: string; installedApps: () => string[];
    request?: (input: DavRequest) => Promise<Buffer>;
    head?: (input: DavRequest) => Promise<number | null>;
    now?: () => Date;
  }) {}
  private now() { return this.deps.now?.() ?? new Date(); }
  private async target(userId: string): Promise<Target | undefined> {
    return (await this.deps.database.query<Target>("SELECT * FROM core.backup_targets WHERE user_id=$1", [userId])).rows[0];
  }
  private async activeActor(userId: string): Promise<BackupActor> {
    const row = (await this.deps.database.query<{ id: string; role: "admin" | "user"; status: string }>("SELECT id, role, status FROM core.users WHERE id=$1", [userId])).rows[0];
    if (!row || row.status !== "active") throw new AppError(403, "forbidden", "Backup owner is not active.");
    return row;
  }
  async config(actor: BackupActor) { return view(await this.target(actor.id)); }
  async save(actor: BackupActor, input: WebdavInput) {
    checkScope(await this.activeActor(actor.id), input.scope);
    const endpoint = normalizeEndpoint(input.endpoint);
    if (!input.username || input.username.includes(":") || /[\r\n]/.test(input.username) || input.username.length > 512) throw new AppError(422, "invalid_webdav_username", "Enter a valid WebDAV username without a colon or newline.");
    if (![0,1,6,12,24,168].includes(input.intervalHours)) throw new AppError(422, "invalid_interval", "Choose a supported backup interval.");
    const existing = await this.target(actor.id);
    if (input.password === undefined && (!existing || endpoint !== existing.endpoint || input.username !== existing.username)) {
      throw new AppError(422, "password_required", "Enter the password when configuring a new WebDAV destination or username.");
    }
    if (input.password !== undefined && (!input.password || input.password.length > 4096)) throw new AppError(422, "invalid_password", "Enter a non-empty WebDAV password (up to 4096 characters).");
    const encrypted = input.password === undefined ? existing!.password_ciphertext : encryptPassword(input.password, await backupKey(this.deps.storageRoot), actor.id);
    const now = this.now();
    const next = input.intervalHours ? new Date(now.getTime() + input.intervalHours * 3_600_000) : null;
    const result = await this.deps.database.query<Target>(`INSERT INTO core.backup_targets
      (user_id,endpoint,username,password_ciphertext,scope,interval_hours,next_run_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (user_id) DO UPDATE SET endpoint=EXCLUDED.endpoint, username=EXCLUDED.username,
      password_ciphertext=EXCLUDED.password_ciphertext, scope=EXCLUDED.scope, interval_hours=EXCLUDED.interval_hours,
      next_run_at=EXCLUDED.next_run_at, updated_at=$8, revision=core.backup_targets.revision+1
      WHERE (core.backup_targets.lease_until IS NULL OR core.backup_targets.lease_until <= $8)
      AND core.backup_targets.revision=$9 RETURNING *`,
      [actor.id, endpoint, input.username, encrypted, input.scope, input.intervalHours, next, now, existing?.revision ?? 0]);
    if (!result.rows[0]) throw new AppError(409, "backup_busy", "A backup is running. Wait before changing its configuration.");
    return view(result.rows[0]);
  }
  async remove(actor: BackupActor) {
    const row = await this.target(actor.id);
    if (!row) return;
    const deleted = await this.deps.database.query("DELETE FROM core.backup_targets WHERE user_id=$1 AND (lease_until IS NULL OR lease_until <= $2)", [actor.id, this.now()]);
    if (!deleted.rowCount) throw new AppError(409, "backup_busy", "A backup is running. Wait before removing its configuration.");
  }
  private async request(row: Target, method: DavRequest["method"], filename?: string, body?: Buffer, timeoutMs?: number) {
    const password = decryptPassword(row.password_ciphertext, await backupKey(this.deps.storageRoot), row.user_id);
    return (this.deps.request ?? davRequest)({ endpoint: row.endpoint, username: row.username, password, method, filename, body, timeoutMs });
  }
  private remote(row: Target) {
    const deadline = Date.now() + REMOTE_BUDGET_MS;
    let received = 0;
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw new AppError(504, "backup_timeout", "Backup remote operations exceeded their time budget. Retry or use a full backup.");
      return Math.min(value, 30_000);
    };
    return {
      request: async (method: DavRequest["method"], filename: string, body?: Buffer) => {
        const data = await this.request(row, method, filename, body, remaining());
        received += data.length;
        if (received > REMOTE_READ_LIMIT) throw new AppError(413, "backup_too_large", "Backup remote reads exceed the allowed total size.");
        remaining(); return data;
      },
      head: async (filename: string) => {
        const timeoutMs = remaining();
        const password = decryptPassword(row.password_ciphertext, await backupKey(this.deps.storageRoot), row.user_id);
        const size = await (this.deps.head ?? davHead)({ endpoint: row.endpoint, username: row.username, password, filename, method: "HEAD", timeoutMs });
        remaining(); return size;
      },
    };
  }
  async test(actor: BackupActor) {
    const row = await this.target(actor.id);
    if (!row) throw new AppError(422, "webdav_not_configured", "Save WebDAV configuration first.");
    checkScope(await this.activeActor(actor.id), row.scope);
    await this.request(row, "PROPFIND");
    return { ok: true };
  }
  async history(actor: BackupActor) {
    const target = await this.target(actor.id);
    const rows = (await this.deps.database.query<History>("SELECT * FROM core.backup_history WHERE user_id=$1 ORDER BY sequence DESC LIMIT 100", [actor.id])).rows;
    return { items: rows.map(row => historyView(row, target?.endpoint, actor.role, target?.username)) };
  }
  async download(actor: BackupActor, id: string) {
    const row = (await this.deps.database.query<History>("SELECT * FROM core.backup_history WHERE id=$1 AND user_id=$2", [id, actor.id])).rows[0];
    const target = await this.target(actor.id);
    if (!row || !target || row.endpoint !== target.endpoint || (row.destination_username !== null && row.destination_username !== target.username)) throw new AppError(404, "backup_not_found", "Backup is not available at the current configured destination.");
    checkScope(await this.activeActor(actor.id), row.scope);
    const remote = this.remote(target);
    let data = await remote.request("GET", row.filename);
    if (data.length !== row.size_bytes || createHash("sha256").update(data).digest("hex") !== row.sha256) throw new AppError(422, "backup_integrity_error", "Remote backup content differs from the uploaded backup.");
    if (row.kind === "incremental") {
      const namespace = backupNamespace(actor.id, target.endpoint, target.username, row.scope);
      if (namespace !== row.namespace) throw new AppError(422, "backup_integrity_error", "Backup namespace does not match its destination.");
      const manifest = parseManifest(data, namespace);
      if (manifest.source.id !== actor.id || manifest.scope !== row.scope || fingerprintManifest(manifest) !== row.content_fingerprint) throw new AppError(422, "backup_integrity_error", "Backup manifest identity or fingerprint does not match its history.");
      data = Buffer.from(JSON.stringify(await reconstructManifest(manifest, ref => remote.request("GET", ref.filename))));
      if (data.length > MAX_SNAPSHOT_BYTES) throw new AppError(413, "backup_too_large", "Reconstructed backup exceeds the 32 MiB limit.");
    }
    checkScope(await this.activeActor(actor.id), row.scope);
    return { data, filename: row.kind === "incremental" ? `pp-${actor.id}-${row.scope}-${row.id}.json` : row.filename };
  }
  run(actor: BackupActor, scheduled = false, mode: BackupMode = "incremental"): Promise<BackupRunResult> {
    if (this.stopped) return Promise.reject(new AppError(503, "backup_stopping", "Backup service is stopping."));
    if (!["incremental", "full"].includes(mode) || (scheduled && mode !== "incremental")) return Promise.reject(new AppError(422, "invalid_backup_mode", "Automatic backups use incremental mode; manual backups may use full mode."));
    const job = this.perform(actor, scheduled, mode);
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job)).catch(() => undefined);
    return job;
  }
  private async perform(actor: BackupActor, scheduled: boolean, mode: BackupMode): Promise<BackupRunResult> {
    const token = randomUUID();
    const now = this.now();
    const row = (await this.deps.database.query<Target>(`UPDATE core.backup_targets SET lease_token=$2, lease_until=$3
      WHERE user_id=$1 AND (lease_until IS NULL OR lease_until <= $4)
      ${scheduled ? "AND interval_hours > 0 AND next_run_at <= $4" : ""} RETURNING *`,
      [actor.id, token, new Date(now.getTime() + 10 * 60_000), now])).rows[0];
    if (!row) throw new AppError(409, "backup_busy", "Backup is already running, not due, or not configured.");
    let failure: string | null = null;
    let outcome = "success";
    try {
      const currentActor = await this.activeActor(actor.id);
      checkScope(currentActor, row.scope);
      const snapshot = await exportSnapshot({ database: this.deps.database, storageRoot: this.deps.storageRoot, actor: currentActor, scope: row.scope, installedApps: this.deps.installedApps() });
      const fullData = Buffer.from(JSON.stringify(snapshot));
      if (fullData.length > MAX_SNAPSHOT_BYTES) throw new AppError(413, "backup_too_large", "Backup exceeds the 32 MiB limit.");
      const namespace = backupNamespace(actor.id, row.endpoint, row.username, row.scope);
      const remote = this.remote(row);
      let uploadedBytes = 0, uploadedObjects = 0;
      let fingerprint: string | null = null;
      let data: Buffer = fullData;
      const id = randomUUID();
      const filename = `${mode === "incremental" ? "ppm" : "pp"}-${actor.id}-${row.scope}-${id}.json`;
      const ensureLease = async () => {
        const claim = await this.deps.database.query("SELECT user_id FROM core.backup_targets WHERE user_id=$1 AND lease_token=$2 AND lease_until>$3", [actor.id, token, this.now()]);
        if (!claim.rowCount) throw new AppError(409, "backup_busy", "Backup lease expired; retry after the current operation finishes.");
      };
      const put = async (name: string, bytes: Buffer) => {
        checkScope(await this.activeActor(actor.id), row.scope);
        await ensureLease();
        await remote.request("PUT", name, bytes); uploadedBytes += bytes.length; uploadedObjects++;
      };
      if (mode === "incremental") {
        const plan = buildIncremental(snapshot, namespace);
        fingerprint = plan.fingerprint; data = plan.manifestBytes;
        const previous = (await this.deps.database.query<History>(`SELECT * FROM core.backup_history
          WHERE user_id=$1 AND namespace=$2 AND kind='incremental' ORDER BY sequence DESC LIMIT 1`, [actor.id, namespace])).rows[0];
        const confirmed = new Map<string, ObjectRef>();
        if (previous) {
          let bytes: Buffer;
          try { bytes = await remote.request("GET", previous.filename); }
          catch { throw new AppError(422, "backup_baseline_unavailable", "The previous incremental manifest is unavailable. Restore that file on the drive or create a standalone full backup."); }
          if (bytes.length !== previous.size_bytes || createHash("sha256").update(bytes).digest("hex") !== previous.sha256) throw new AppError(422, "backup_integrity_error", "The previous incremental manifest has changed; restore it before continuing incremental backups.");
          const manifest = parseManifest(bytes, namespace);
          if (manifest.source.id !== actor.id || manifest.scope !== row.scope || fingerprintManifest(manifest) !== previous.content_fingerprint) throw new AppError(422, "backup_integrity_error", "Previous incremental manifest identity does not match.");
          for (const ref of getObjectRefs(manifest)) confirmed.set(ref.filename, ref);
        }
        for (const { ref, data: bytes } of plan.objects.values()) {
          const known = confirmed.get(ref.filename);
          if (known) {
            if (known.sha256 !== ref.sha256 || known.size !== ref.size || known.kind !== ref.kind) throw new AppError(422, "backup_integrity_error", "A backup object reference has changed unexpectedly.");
            const size = await remote.head(ref.filename);
            if (size === ref.size) continue;
            if (size !== null) throw new AppError(422, "backup_integrity_error", "A remote backup object has an incorrect size. Restore it or create a full backup.");
          }
          try { await put(ref.filename, bytes); }
          catch (error) {
            if (!(error instanceof AppError) || (error.details as {status?: number} | undefined)?.status !== 412) throw error;
            const existing = await remote.request("GET", ref.filename);
            if (existing.length !== ref.size || createHash("sha256").update(existing).digest("hex") !== ref.sha256) throw new AppError(422, "backup_integrity_error", "An existing immutable backup object differs; it was not overwritten.");
          }
        }
        if (previous && previous.content_fingerprint === fingerprint) {
          checkScope(await this.activeActor(actor.id), row.scope);
          await ensureLease();
          outcome = "unchanged";
          return { status: "unchanged", backup: historyView(previous, row.endpoint, currentActor.role, row.username), uploadedBytes, uploadedObjects };
        }
      }
      // Objects first, immutable manifest last. Only a committed history row
      // makes this backup visible; failed publication may leave safe orphans.
      await put(filename, data);
      const saved = await this.deps.database.withTransaction(async tx => {
        await tx.query("SET LOCAL lock_timeout='5s'");
        await tx.query("SET LOCAL statement_timeout='15s'");
        const claim = await tx.query("SELECT user_id FROM core.backup_targets WHERE user_id=$1 AND lease_token=$2 AND lease_until>$3 FOR UPDATE", [actor.id, token, this.now()]);
        if (!claim.rowCount) throw new AppError(409, "backup_busy", "Backup lease expired before publication; no successful history was recorded.");
        const owner = (await tx.query<{role: string; status: string}>("SELECT role,status FROM core.users WHERE id=$1", [actor.id])).rows[0];
        if (!owner || owner.status !== "active" || (row.scope === "all" && owner.role !== "admin")) throw new AppError(403, "forbidden", "Backup owner is no longer permitted to publish this scope.");
        return (await tx.query<History>(`INSERT INTO core.backup_history
          (id,user_id,endpoint,filename,scope,size_bytes,sha256,created_at,kind,namespace,content_fingerprint,destination_username,logical_size_bytes,uploaded_bytes,uploaded_objects)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [id, actor.id, row.endpoint, filename, row.scope, data.length, createHash("sha256").update(data).digest("hex"), this.now(), mode, namespace, fingerprint, row.username, fullData.length, uploadedBytes, uploadedObjects])).rows[0]!;
      });
      return { status: "created", backup: historyView(saved, row.endpoint, currentActor.role, row.username), uploadedBytes, uploadedObjects };
    } catch (error) {
      // Never retain arbitrary transport exceptions or remote bodies in state/logs.
      failure = error instanceof AppError ? `${error.code}: ${error.message}` : "backup_failed: Backup did not complete cleanly. Check history before retrying.";
      throw error instanceof AppError ? error : new AppError(500, "backup_failed", "Backup failed; check server storage and database availability.");
    } finally {
      const finished = this.now();
      await this.deps.database.query(`UPDATE core.backup_targets SET lease_token=NULL,lease_until=NULL,
        last_run_at=$3,last_status=$4,last_error=$5,
        next_run_at=CASE WHEN interval_hours > 0 THEN $3::timestamptz + interval_hours * interval '1 hour' ELSE NULL END
        WHERE user_id=$1 AND lease_token=$2`, [actor.id, token, finished, failure ? "failed" : outcome, failure]);
    }
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const due = (await this.deps.database.query<{ user_id: string }>(`SELECT user_id FROM core.backup_targets
      WHERE interval_hours > 0 AND next_run_at <= $1 AND (lease_until IS NULL OR lease_until <= $1) ORDER BY next_run_at LIMIT 10`, [this.now()])).rows;
    for (const row of due) {
      if (this.stopped) break;
      // perform() resolves the actual current role/status inside the claimed lease.
      await this.run({ id: row.user_id, role: "user" }, true).catch(() => undefined);
    }
  }
  async stop(): Promise<void> { this.stopped = true; await Promise.allSettled([...this.pending]); }
}
