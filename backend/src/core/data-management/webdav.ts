import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../database/index.js";
import { AppError } from "../api/errors.js";
import { backupKey, decryptPassword, encryptPassword } from "./credentials.js";
import { davRequest, normalizeEndpoint, type DavRequest } from "./webdav-http.js";
import { exportSnapshot, MAX_SNAPSHOT_BYTES } from "./snapshot.js";

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
interface History { id: string; endpoint: string; filename: string; scope: BackupScope; size_bytes: number; sha256: string; created_at: Date }

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
function historyView(row: History, endpoint?: string, role?: string) {
  return { id: row.id, filename: row.filename, scope: row.scope, size: row.size_bytes, createdAt: row.created_at.toISOString(), available: row.endpoint === endpoint && (row.scope !== "all" || role === "admin") };
}

export class WebdavBackups {
  private stopped = false;
  private pending = new Set<Promise<unknown>>();
  constructor(private readonly deps: {
    database: Database; storageRoot: string; installedApps: () => string[];
    request?: (input: DavRequest) => Promise<Buffer>;
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
  private async request(row: Target, method: DavRequest["method"], filename?: string, body?: Buffer) {
    const password = decryptPassword(row.password_ciphertext, await backupKey(this.deps.storageRoot), row.user_id);
    return (this.deps.request ?? davRequest)({ endpoint: row.endpoint, username: row.username, password, method, filename, body });
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
    const rows = (await this.deps.database.query<History>("SELECT * FROM core.backup_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [actor.id])).rows;
    return { items: rows.map(row => historyView(row, target?.endpoint, actor.role)) };
  }
  async download(actor: BackupActor, id: string) {
    const row = (await this.deps.database.query<History>("SELECT * FROM core.backup_history WHERE id=$1 AND user_id=$2", [id, actor.id])).rows[0];
    const target = await this.target(actor.id);
    if (!row || !target || row.endpoint !== target.endpoint) throw new AppError(404, "backup_not_found", "Backup is not available at the current configured destination.");
    checkScope(await this.activeActor(actor.id), row.scope);
    const data = await this.request(target, "GET", row.filename);
    if (data.length !== row.size_bytes || createHash("sha256").update(data).digest("hex") !== row.sha256) throw new AppError(422, "backup_integrity_error", "Remote backup content differs from the uploaded backup.");
    return { data, filename: row.filename };
  }
  run(actor: BackupActor, scheduled = false): Promise<ReturnType<typeof historyView>> {
    if (this.stopped) return Promise.reject(new AppError(503, "backup_stopping", "Backup service is stopping."));
    const job = this.perform(actor, scheduled);
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job)).catch(() => undefined);
    return job;
  }
  private async perform(actor: BackupActor, scheduled: boolean) {
    const token = randomUUID();
    const now = this.now();
    const row = (await this.deps.database.query<Target>(`UPDATE core.backup_targets SET lease_token=$2, lease_until=$3
      WHERE user_id=$1 AND (lease_until IS NULL OR lease_until <= $4)
      ${scheduled ? "AND interval_hours > 0 AND next_run_at <= $4" : ""} RETURNING *`,
      [actor.id, token, new Date(now.getTime() + 10 * 60_000), now])).rows[0];
    if (!row) throw new AppError(409, "backup_busy", "Backup is already running, not due, or not configured.");
    let failure: string | null = null;
    try {
      const currentActor = await this.activeActor(actor.id);
      checkScope(currentActor, row.scope);
      const snapshot = await exportSnapshot({ database: this.deps.database, storageRoot: this.deps.storageRoot, actor: currentActor, scope: row.scope, installedApps: this.deps.installedApps() });
      const data = Buffer.from(JSON.stringify(snapshot));
      if (data.length > MAX_SNAPSHOT_BYTES) throw new AppError(413, "backup_too_large", "Backup exceeds the 32 MiB limit.");
      // Check immediately before publishing too: export may take some time.
      checkScope(await this.activeActor(actor.id), row.scope);
      const id = randomUUID();
      const filename = `pp-${actor.id}-${row.scope}-${id}.json`;
      await this.request(row, "PUT", filename, data);
      const saved = (await this.deps.database.query<History>(`INSERT INTO core.backup_history
        (id,user_id,endpoint,filename,scope,size_bytes,sha256,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, actor.id, row.endpoint, filename, row.scope, data.length, createHash("sha256").update(data).digest("hex"), this.now()])).rows[0]!;
      return historyView(saved, row.endpoint, currentActor.role);
    } catch (error) {
      // Never retain arbitrary transport exceptions or remote bodies in state/logs.
      failure = error instanceof AppError ? `${error.code}: ${error.message}` : "backup_failed: Backup failed; no successful history entry was recorded.";
      throw error instanceof AppError ? error : new AppError(500, "backup_failed", "Backup failed; check server storage and database availability.");
    } finally {
      const finished = this.now();
      await this.deps.database.query(`UPDATE core.backup_targets SET lease_token=NULL,lease_until=NULL,
        last_run_at=$3,last_status=$4,last_error=$5,
        next_run_at=CASE WHEN interval_hours > 0 THEN $3::timestamptz + interval_hours * interval '1 hour' ELSE NULL END
        WHERE user_id=$1 AND lease_token=$2`, [actor.id, token, finished, failure ? "failed" : "success", failure]);
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
