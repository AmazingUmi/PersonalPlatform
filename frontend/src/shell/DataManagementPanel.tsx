import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelInput } from "../shared/ui/PixelInput";
import { StatusMessage } from "../shared/ui/StatusMessage";
import {
  backupWebDav, deleteWebDav, downloadBackup, exportData, getBackupHistory, getWebDav,
  importSnapshot, parseBackup, previewMerge, saveDownload, saveWebDav, testWebDav,
  type BackupMode, type BackupRecord, type DataScope, type MergeReport, type WebDavConfig,
} from "../shared/dataManagement";
import "./dataManagement.css";

const message = (error: unknown) => error instanceof Error ? error.message : "The operation failed. Please try again.";
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const scopeLabel = (scope: DataScope) => scope === "all" ? "All users" : "My data";

// UI readiness only; the server independently validates the destination and credentials.
function connectionUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  } catch { return null; }
}

export function DataManagementPanel({ section }: { section: "data" | "webdav" | null }) {
  const [, setParams] = useSearchParams();
  const [webDavVisited, setWebDavVisited] = useState(section === "webdav");
  const dataRef = useRef<HTMLDivElement>(null);
  const focusData = useRef(false);
  useEffect(() => {
    if (section === "webdav") setWebDavVisited(true);
    if (section === "data" && focusData.current) { const heading = dataRef.current?.querySelector("h2"); if (heading) { heading.tabIndex = -1; heading.focus(); } focusData.current = false; }
  }, [section]);
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [scope, setScope] = useState<DataScope>("own");
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<MergeReport | null>(null);
  const [result, setResult] = useState<MergeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }
  function resetSelection() {
    setSnapshot(null); setSource(""); setPreview(null); setResult(null); setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }
  async function readSelection(file: File) {
    resetSelection();
    await perform(async () => { setSnapshot(await parseBackup(file)); setSource(file.name); });
  }
  async function prepareRemote(record: BackupRecord) {
    focusData.current = true;
    setParams((previous) => { const next = new URLSearchParams(previous); next.set("section", "data"); return next; });
    await perform(async () => {
      const downloaded = await downloadBackup(record.id);
      const data = await parseBackup(downloaded.blob);
      const nextPreview = await previewMerge(record.scope, data);
      setScope(record.scope); setSource(record.filename); setSnapshot(data);
      setPreview(nextPreview); setResult(null);
      if (fileRef.current) fileRef.current.value = "";
    });
  }

  return <>
    <div hidden={section !== "data"}>
    <div ref={dataRef} tabIndex={-1} className="settings-focus-target" aria-label="Data management">
    <PixelWindow title="Data management" icon="file" className="data-management">
      <p>Export a full JSON backup of your app data and attachments, or merge a previous full backup into this installation.</p>
      <div className="data-management__actions">
        <label className="data-management__field" htmlFor="data-scope">Data scope
          <select id="data-scope" className="px-input" value={scope} disabled={busy} onChange={(event) => {
            setScope(event.target.value as DataScope); resetSelection();
          }}>
            <option value="own">My data</option>
            {admin && <option value="all">All users (administrator)</option>}
          </select>
        </label>
        <PixelButton disabled={busy} onClick={() => void perform(async () => saveDownload(await exportData(scope)))}>Export backup</PixelButton>
      </div>
      {scope === "all" && <StatusMessage tone="warning">This backup includes all users' app data and account password hashes. Store it privately.</StatusMessage>}
      <p className="muted">Settings backups use JSON (up to 32 MiB, including attachments). Sessions, WebDAV passwords and server configuration are excluded. Old SQL/archive backups require offline conversion.</p>
      <div className="data-management__section">
        <h3>Merge a previous backup</h3>
        <p>Current records are kept. Missing records and relationships are added. A conflict that cannot be merged safely stops the entire import.</p>
        <input ref={fileRef} id="backup-file" aria-label="Backup file" type="file" hidden accept=".json,application/json" disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void readSelection(file);
        }} />
        <div className="data-management__file-picker">
          <PixelButton variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>Choose file</PixelButton>
          <span className="data-management__filename" aria-live="polite">{source ? `Selected: ${source}` : "No file selected"}</span>
        </div>
        <div className="data-management__actions">
          <PixelButton variant="secondary" disabled={busy || snapshot === null} onClick={() => void perform(async () => {
            setResult(null); setPreview(null); setPreview(await previewMerge(scope, snapshot));
          })}>Preview merge</PixelButton>
          {source && <PixelButton variant="ghost" disabled={busy} onClick={resetSelection}>Clear selection</PixelButton>}
        </div>
        {preview && <div className="data-management__preview" data-testid="merge-preview">
          <h3>Review merge</h3>
          <p>{scopeLabel(preview.scope)} · Created {dateLabel(preview.createdAt)} · {preview.files} attachment(s)</p>
          <MergeTable report={preview} />
          <p>Preview: {preview.inserted} to add, {preview.skipped} to keep. Counts are checked again when you merge.</p>
          <PixelButton disabled={busy} onClick={() => void perform(async () => {
            const imported = await importSnapshot(scope, snapshot);
            setPreview(null); setSnapshot(null); setSource("");
            if (fileRef.current) fileRef.current.value = "";
            setResult(imported);
          })}>Merge missing data</PixelButton>
        </div>}
        {result && <StatusMessage tone="success">Merge complete: {result.inserted} added, {result.skipped} existing records kept. Reload other app pages to see imported data.</StatusMessage>}
      </div>
      {busy && <p role="status">Working…</p>}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </PixelWindow>
    </div></div>
    {(webDavVisited || section === "webdav") && <div hidden={section !== "webdav"}><WebDavPanel admin={admin} onPrepare={prepareRemote} importBusy={busy} /></div>}
  </>;
}

const dataLabels: Record<string, string> = {
  "core.users": "User accounts", "core.settings": "Platform preferences", "tasks.tasks": "Tasks",
  "notes.notes": "Notes", "notes.tags": "Note tags", "notes.note_tags": "Note tag links",
  "assets.items": "Assets", "assets.categories": "Asset categories", "assets.item_categories": "Asset category links",
  "assets.attachments": "Attachments", "clock.settings": "Clock preferences", "clock.alarms": "Alarms",
  "clock.world_clocks": "World clocks", "focus.settings": "Focus preferences", "focus.sessions": "Focus sessions",
  "mini_game.saves": "Game saves",
};

function MergeTable({ report }: { report: MergeReport }) {
  return <div className="data-management__table-wrap"><table className="data-management__table">
    <thead><tr><th>Data</th><th>Add</th><th>Keep</th><th>Conflicts</th></tr></thead>
    <tbody>{report.tables.map((row) => <tr key={row.table}><td>{dataLabels[row.table] ?? row.table}</td><td>{row.inserted}</td><td>{row.skipped}</td><td>{row.conflicts}</td></tr>)}</tbody>
  </table></div>;
}

function WebDavPanel({ admin, onPrepare, importBusy }: { admin: boolean; onPrepare: (record: BackupRecord) => Promise<void>; importBusy: boolean }) {
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view");
  const view = requestedView === "backup" || requestedView === "history" ? requestedView : "connection";
  function viewUrl(nextView: string) { const next = new URLSearchParams(params); next.set("section", "webdav"); next.set("view", nextView); return `?${next}`; }
  const [config, setConfig] = useState<WebDavConfig | null>(null);
  const [history, setHistory] = useState<BackupRecord[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [scope, setScope] = useState<DataScope>("own");
  const [intervalHours, setIntervalHours] = useState(0);
  const [backupMode, setBackupMode] = useState<BackupMode>("incremental");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);

  function applyConfig(value: WebDavConfig) {
    setConfig(value); setEndpoint(value.endpoint); setUsername(value.username); setScope(!admin && value.scope === "all" ? "own" : value.scope); setIntervalHours(value.intervalHours); setPassword("");
  }
  async function load() {
    setLoading(true); setLoadError(null);
    try {
      const [next, list] = await Promise.all([getWebDav(), getBackupHistory()]);
      if (mounted.current) { applyConfig(next); setHistory(list.items); }
    } catch (err) { if (mounted.current) setLoadError(message(err)); }
    finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, []);

  const normalizedEndpoint = connectionUrl(endpoint);
  const canReusePassword = Boolean(config?.hasPassword && normalizedEndpoint === config.endpoint && username === config.username);
  const canTest = Boolean(normalizedEndpoint && username.trim() && (password || canReusePassword));
  function clearConnectionFeedback() { setNotice(null); setError(null); }
  const dirty = !config || endpoint !== config.endpoint || username !== config.username || scope !== config.scope || intervalHours !== config.intervalHours || password !== "";
  const disabled = busy || importBusy || loading;
  const pageCount = Math.max(1, Math.ceil(history.length / 10));
  const requestedPage = Number(params.get("page") ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pageCount) : 1;
  function changePage(nextPage: number) { setParams((previous) => { const next = new URLSearchParams(previous); next.set("page", String(nextPage)); return next; }); }
  useEffect(() => {
    if (!loading && params.has("page") && params.get("page") !== String(page)) {
      setParams((previous) => { const next = new URLSearchParams(previous); next.set("page", String(page)); return next; }, { replace: true });
    }
  }, [loading, page, params, setParams]);
  async function perform(action: () => Promise<void>) {
    if (disabled) return;
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }
  async function refreshStatus() {
    const [next, list] = await Promise.all([getWebDav(), getBackupHistory()]);
    applyConfig(next); setHistory(list.items);
  }

  return <PixelWindow title="WebDAV backup" icon="file" className="data-management">
    <p>Save backups to your WebDAV drive.</p>
    <nav className="settings-subnav" aria-label="WebDAV sections">
      {["connection", "backup", "history"].map((item) => <Link key={item} to={viewUrl(item)} aria-current={view === item ? "page" : undefined} className={`px-button px-button--${view === item ? "primary" : "secondary"} px-button--md`}>{item === "connection" ? "Connection" : item === "backup" ? "Backup" : "History"}</Link>)}
    </nav>
    {loading ? <p role="status">Loading backup settings…</p> : loadError ? <StatusMessage tone="error">
      <p>Could not load backup settings: {loadError}</p><PixelButton variant="secondary" onClick={() => void load()}>Retry backup settings</PixelButton>
    </StatusMessage> : <>
      <div hidden={view !== "connection"}>
      <form className="data-management__form" onSubmit={(event) => { event.preventDefault(); void perform(async () => {
        applyConfig(await saveWebDav({ endpoint: endpoint.trim(), username, ...(password ? { password } : {}), scope, intervalHours }));
        setHistory((await getBackupHistory()).items); setNotice("Backup settings saved."); setConfirmDelete(false);
      }); }}>
        <label className="data-management__field" htmlFor="webdav-endpoint">WebDAV folder URL
          <PixelInput id="webdav-endpoint" type="url" required value={endpoint} disabled={disabled} onChange={(event) => { setEndpoint(event.target.value); clearConnectionFeedback(); }} placeholder="https://drive.example.com/backups/" autoComplete="off" />
        </label>
        <label className="data-management__field" htmlFor="webdav-username">WebDAV username
          <PixelInput id="webdav-username" required value={username} disabled={disabled} onChange={(event) => { setUsername(event.target.value); clearConnectionFeedback(); }} autoComplete="off" />
        </label>
        <label className="data-management__field" htmlFor="webdav-password">WebDAV password or app token
          <PixelInput id="webdav-password" type="password" value={password} disabled={disabled} required={!canReusePassword} onChange={(event) => { setPassword(event.target.value); clearConnectionFeedback(); }} autoComplete="new-password" placeholder={config?.hasPassword ? "Saved — leave blank to keep" : "Enter password or app token"} />
        </label>
        <label className="data-management__field" htmlFor="webdav-scope">Backup scope
          <select id="webdav-scope" className="px-input" value={scope} disabled={disabled} onChange={(event) => setScope(event.target.value as DataScope)}>
            <option value="own">My data</option>{admin && <option value="all">All users (administrator)</option>}
          </select>
        </label>
        <label className="data-management__field" htmlFor="webdav-interval">Automatic backup
          <select id="webdav-interval" className="px-input" value={intervalHours} disabled={disabled} onChange={(event) => setIntervalHours(Number(event.target.value))}>
            <option value={0}>Off — manual only</option>
            {[1, 6, 12, 24, 168].map((hours) => <option key={hours} value={hours}>Every {hours} hour{hours === 1 ? "" : "s"}</option>)}
          </select>
        </label>
        <div className="data-management__actions">
          <PixelButton variant="secondary" disabled={disabled || !canTest} onClick={() => void perform(async () => {
            await testWebDav({ endpoint: endpoint.trim(), username, ...(password ? { password } : {}) });
            setNotice("Connection successful. WebDAV directory is reachable. This test did not save settings or verify backup writes.");
          })}>Test connection</PixelButton>
          <PixelButton type="submit" disabled={disabled || !dirty}>Save backup settings</PixelButton>
        </div>
      </form>
      <p className="muted">Test the entered connection before saving. Testing does not save settings or enable automatic backups.</p>
      <details>
        <summary>Nutstore (坚果云) setup</summary>
        <p>Use <code>https://dav.jianguoyun.com/dav/</code> or an existing folder under it, your account email, and an app password from Account information → Security → Third-party applications. Use the app password rather than your sign-in password. <a href="https://help.jianguoyun.com/?p=3234" target="_blank" rel="noreferrer">Nutstore instructions</a></p>
      </details>
      <p className="muted">Use an existing WebDAV folder. Passwords are encrypted on the server and are never displayed here. Public HTTPS works by default; private or HTTP servers require the administrator's server allowlist.</p>
      {endpoint.trim().startsWith("http:") && <StatusMessage tone="warning">HTTP sends your credentials and backup without transport encryption.</StatusMessage>}
      {scope === "all" && <StatusMessage tone="warning">All-users backups include account password hashes and everyone's app data. Only administrators can use this scope.</StatusMessage>}
      <p className="muted">Automatic backups are incremental. The first backup establishes a baseline; later backups upload changed data blocks and new attachments. Unchanged data creates no new backup. After downtime, one overdue backup runs when the server resumes. Existing remote files are not deleted automatically.</p>
      {config?.configured && <div className="data-management__actions">
        <PixelButton variant="danger" disabled={disabled} onClick={() => setConfirmDelete(true)}>Remove connection</PixelButton>
      </div>}
      {confirmDelete && <StatusMessage tone="warning"><p>Remove the saved connection and stop automatic backups? Files already on your drive remain there.</p>
        <div className="data-management__actions"><PixelButton variant="danger" disabled={disabled} onClick={() => void perform(async () => { await deleteWebDav(); await refreshStatus(); setConfirmDelete(false); setNotice("Connection removed. Automatic backups are off."); })}>Confirm remove connection</PixelButton>
        <PixelButton variant="secondary" disabled={disabled} onClick={() => setConfirmDelete(false)}>Cancel</PixelButton></div>
      </StatusMessage>}
      </div>
      <div hidden={view !== "backup"}>
      {!config?.configured && <p>Set up a connection to start backing up your data.</p>}
      {config?.configured && <>
        {dirty && <p className="muted">Save your changes before creating a backup.</p>}
        <label className="data-management__field" htmlFor="webdav-mode">Manual backup mode
          <select id="webdav-mode" className="px-input" value={backupMode} disabled={disabled} onChange={(event) => setBackupMode(event.target.value as BackupMode)}>
            <option value="incremental">Incremental — changed data only</option>
            <option value="full">Full — independent JSON file</option>
          </select>
        </label>
        <p className="muted">Full mode uploads an independent complete file. It does not change the automatic incremental schedule.</p>
        <div className="data-management__actions">
          <PixelButton disabled={disabled || dirty} onClick={() => void perform(async () => {
            try {
              const result = await backupWebDav(backupMode);
              if (result.status === "unchanged") {
                setNotice(result.uploadedObjects > 0
                  ? `Data is unchanged. Repaired ${result.uploadedObjects} missing object(s), uploading ${(result.uploadedBytes / 1024).toFixed(1)} KiB. No new backup was created.`
                  : "Data is unchanged. Nothing was uploaded and no new backup was created.");
              } else {
                setNotice(`Backup saved: ${result.backup?.filename ?? "completed"}. Uploaded ${(result.uploadedBytes / 1024).toFixed(1)} KiB in ${result.uploadedObjects} object(s).`);
              }
            }
            finally { await refreshStatus(); }
          })}>Back up now</PixelButton>
          <PixelButton variant="ghost" disabled={disabled || dirty} onClick={() => void perform(refreshStatus)}>Refresh backup status</PixelButton>
        </div>
        <dl className="px-deflist">
          <div><dt>Next automatic backup</dt><dd>{dateLabel(config.nextRunAt)}</dd></div>
          <div><dt>Last backup attempt</dt><dd>{dateLabel(config.lastRunAt)}</dd></div>
          <div><dt>Last result</dt><dd>{config.lastStatus ?? "No backup yet"}</dd></div>
        </dl>
        {config.lastError && <StatusMessage tone="error">Last backup failed: {config.lastError}</StatusMessage>}
      </>}
      </div>
      <div hidden={view !== "history"}>
        <h3>Backup history</h3>
        <p className="muted">Showing the latest {history.length} recorded backups (up to 100).</p>
        <PixelButton variant="secondary" disabled={disabled || dirty} onClick={() => void perform(refreshStatus)}>Refresh history</PixelButton>
        <p className="muted">Download and Review reconstruct an incremental backup as a full JSON file. Keep its remote manifest and all referenced objects together. For backups outside this history, a full JSON file can be imported in Data; incremental manifests need the offline reconstruction tool.</p>
        {history.length === 0 ? <p>No backups recorded yet.</p> : <ul className="data-management__history">{history.slice((page - 1) * 10, page * 10).map((record) => <li key={record.id}>
          <div><strong className="data-management__filename">{record.filename}</strong><p className="muted">{record.kind === "incremental" ? "Incremental" : "Full"} · {scopeLabel(record.scope)} · {dateLabel(record.createdAt)} · Full data {(record.size / 1024).toFixed(1)} KiB · Uploaded {(record.uploadedBytes / 1024).toFixed(1)} KiB</p></div>
          {record.available ? <div className="data-management__actions">
            <PixelButton variant="secondary" aria-label={`Download ${record.filename}`} disabled={disabled || dirty} onClick={() => void perform(async () => saveDownload(await downloadBackup(record.id)))}>Download</PixelButton>
            <PixelButton variant="secondary" aria-label={`Review ${record.filename} for import`} disabled={disabled || dirty} onClick={() => void perform(async () => { await onPrepare(record); })}>Review</PixelButton>
          </div> : <p className="muted">Unavailable with the current connection or permissions.</p>}
        </li>)}</ul>}
        {history.length > 0 && <nav className="data-management__actions" aria-label="Backup history pages">
          <PixelButton variant="secondary" disabled={disabled || page === 1} onClick={() => changePage(page - 1)}>Previous page</PixelButton>
          <span role="status">Page {page} of {pageCount} · {history.length} records</span>
          <PixelButton variant="secondary" disabled={disabled || page === pageCount} onClick={() => changePage(page + 1)}>Next page</PixelButton>
        </nav>}
      </div>
    </>}
    {busy && <p role="status">Working on WebDAV…</p>}
    {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
    {error && <StatusMessage tone="error">{error}</StatusMessage>}
  </PixelWindow>;
}
