import { api, ApiError, UNAUTHORIZED_EVENT } from "./api";

const BASE = "/api/core/data";
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export type DataScope = "own" | "all";
export interface MergeReport {
  scope: DataScope;
  createdAt: string;
  files: number;
  inserted: number;
  skipped: number;
  tables: { table: string; inserted: number; skipped: number; conflicts: number }[];
}
export interface WebDavConfig {
  configured: boolean;
  endpoint: string;
  username: string;
  hasPassword: boolean;
  scope: DataScope;
  intervalHours: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}
export interface WebDavInput {
  endpoint: string;
  username: string;
  password?: string;
  scope: DataScope;
  intervalHours: number;
}
export interface BackupRecord {
  id: string;
  filename: string;
  scope: DataScope;
  createdAt: string;
  size: number;
  available: boolean;
  kind: "full" | "incremental";
  uploadedBytes: number;
  uploadedObjects: number;
}
export type BackupMode = "incremental" | "full";
export interface BackupResult {
  status: "created" | "unchanged";
  backup: BackupRecord | null;
  uploadedBytes: number;
  uploadedObjects: number;
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
export const previewMerge = (scope: DataScope, snapshot: unknown) =>
  api<MergeReport>(`${BASE}/preview`, json("POST", { scope, snapshot }));
export const importSnapshot = (scope: DataScope, snapshot: unknown) =>
  api<MergeReport>(`${BASE}/import`, json("POST", { scope, snapshot }));
export const getWebDav = () => api<WebDavConfig>(`${BASE}/webdav`);
export const saveWebDav = (input: WebDavInput) => api<WebDavConfig>(`${BASE}/webdav`, json("PUT", input));
export const deleteWebDav = () => api<unknown>(`${BASE}/webdav`, { method: "DELETE" });
export const testWebDav = () => api<{ ok: boolean }>(`${BASE}/webdav/test`, json("POST", {}));
export const backupWebDav = (mode: BackupMode = "incremental") => api<BackupResult>(`${BASE}/webdav/backup`, json("POST", { mode }));
export const getBackupHistory = () => api<{ items: BackupRecord[] }>(`${BASE}/webdav/history`);

/** Bound the download before retaining it in browser memory, including chunked responses. */
async function download(path: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(path);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string; details?: unknown } } | null;
    throw new ApiError(body?.error?.message ?? `HTTP ${response.status}`, response.status, body?.error?.code ?? null, body?.error?.details);
  }
  if (Number(response.headers.get("content-length")) > MAX_SNAPSHOT_BYTES) {
    await response.body?.cancel();
    throw new Error("The backup exceeds the 32 MiB limit.");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  if (!reader) throw new Error("Could not read the backup download.");
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_SNAPSHOT_BYTES) {
        await reader.cancel();
        throw new Error("The backup exceeds the 32 MiB limit.");
      }
      chunks.push(new Uint8Array(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const candidate = disposition.match(/filename="?([a-zA-Z0-9_.-]+\.json)"?/)?.[1];
  return { blob: new Blob(chunks, { type: "application/json" }), filename: candidate ?? "personal-platform-backup.json" };
}
export const exportData = (scope: DataScope) => download(`${BASE}/export?scope=${scope}`);
export const downloadBackup = (id: string) => download(`${BASE}/webdav/files/${encodeURIComponent(id)}`);

export function saveDownload({ blob, filename }: { blob: Blob; filename: string }): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Keep the URL alive until the browser has consumed the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function parseBackup(file: Blob): Promise<unknown> {
  if (file.size > MAX_SNAPSHOT_BYTES) throw new Error("The backup exceeds the 32 MiB limit.");
  try {
    const value: unknown = JSON.parse(await file.text());
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid snapshot");
    return value;
  }
  catch { throw new Error("Select a valid Settings JSON backup. SQL and archive backups need offline conversion first."); }
}
