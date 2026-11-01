import { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelInput } from "../shared/ui/PixelInput";
import { StatusMessage } from "../shared/ui/StatusMessage";
import {
  backupWebDav, deleteWebDav, downloadBackup, exportData, getBackupHistory, getWebDav,
  importSnapshot, parseBackup, previewMerge, saveDownload, saveWebDav, testWebDav,
  type BackupRecord, type DataScope, type MergeReport, type WebDavConfig,
} from "../shared/dataManagement";
import "./dataManagement.css";

const message = (error: unknown) => error instanceof Error ? error.message : "The operation failed. Please try again.";
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const scopeLabel = (scope: DataScope) => scope === "all" ? "All users" : "My data";

export function DataManagementPanel() {
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
    resetSelection();
    await perform(async () => {
      const downloaded = await downloadBackup(record.id);
      const data = await parseBackup(downloaded.blob);
      setScope(record.scope); setSource(record.filename); setSnapshot(data);
      setPreview(await previewMerge(record.scope, data));
    });
  }

  return <>
    <PixelWindow title="Data management" icon="file" className="data-management">
      <p>Export your app data and attachments, or merge a previous backup into this installation.</p>
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
        <label className="data-management__field" htmlFor="backup-file">Backup file
          <input ref={fileRef} id="backup-file" type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readSelection(file); else resetSelection();
          }} />
        </label>
        {source && <p className="data-management__filename">Selected: {source}</p>}
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
    <WebDavPanel admin={admin} onPrepare={prepareRemote} importBusy={busy} />
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
  const [config, setConfig] = useState<WebDavConfig | null>(null);
  const [history, setHistory] = useState<BackupRecord[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [scope, setScope] = useState<DataScope>("own");
  const [intervalHours, setIntervalHours] = useState(0);
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

  const dirty = !config || endpoint !== config.endpoint || username !== config.username || scope !== config.scope || intervalHours !== config.intervalHours || password !== "";
  const disabled = busy || importBusy || loading;
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
    <p>Save backups to your WebDAV drive. Each account has its own connection and backup history.</p>
    {loading ? <p role="status">Loading backup settings…</p> : loadError ? <StatusMessage tone="error">
      <p>Could not load backup settings: {loadError}</p><PixelButton variant="secondary" onClick={() => void load()}>Retry backup settings</PixelButton>
    </StatusMessage> : <>
      <form className="data-management__form" onSubmit={(event) => { event.preventDefault(); void perform(async () => {
        applyConfig(await saveWebDav({ endpoint: endpoint.trim(), username, ...(password ? { password } : {}), scope, intervalHours }));
        setHistory((await getBackupHistory()).items); setNotice("Backup settings saved."); setConfirmDelete(false);
      }); }}>
        <label className="data-management__field" htmlFor="webdav-endpoint">WebDAV folder URL
          <PixelInput id="webdav-endpoint" type="url" required value={endpoint} disabled={disabled} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://drive.example.com/backups/" autoComplete="off" />
        </label>
        <label className="data-management__field" htmlFor="webdav-username">WebDAV username
          <PixelInput id="webdav-username" required value={username} disabled={disabled} onChange={(event) => setUsername(event.target.value)} autoComplete="off" />
        </label>
        <label className="data-management__field" htmlFor="webdav-password">WebDAV password or app token
          <PixelInput id="webdav-password" type="password" value={password} disabled={disabled} required={!config?.hasPassword || endpoint !== config.endpoint || username !== config.username} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder={config?.hasPassword ? "Saved — leave blank to keep" : "Enter password or app token"} />
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
        <div className="data-management__actions"><PixelButton type="submit" disabled={disabled || !dirty}>Save backup settings</PixelButton></div>
      </form>
      <p className="muted">Use an existing WebDAV folder. Passwords are encrypted on the server and are never displayed here. Public HTTPS works by default; private or HTTP servers require the administrator's server allowlist.</p>
      {endpoint.trim().startsWith("http:") && <StatusMessage tone="warning">HTTP sends your credentials and backup without transport encryption.</StatusMessage>}
      {scope === "all" && <StatusMessage tone="warning">All-users backups include account password hashes and everyone's app data. Only administrators can use this scope.</StatusMessage>}
      <p className="muted">Automatic backups run every selected number of hours while the server is running. After downtime, one overdue backup runs when the server resumes. Existing remote backups are not deleted automatically.</p>
      {config?.configured && <>
        {dirty && <p className="muted">Save your changes before testing the connection or creating a backup.</p>}
        <div className="data-management__actions">
          <PixelButton variant="secondary" disabled={disabled || dirty} onClick={() => void perform(async () => { await testWebDav(); setNotice("WebDAV connection successful."); })}>Test connection</PixelButton>
          <PixelButton disabled={disabled || dirty} onClick={() => void perform(async () => {
            try { const record = await backupWebDav(); setNotice(`Backup saved: ${record.filename}`); }
            finally { await refreshStatus(); }
          })}>Back up now</PixelButton>
          <PixelButton variant="ghost" disabled={disabled || dirty} onClick={() => void perform(refreshStatus)}>Refresh backup status</PixelButton>
          <PixelButton variant="danger" disabled={disabled} onClick={() => setConfirmDelete(true)}>Remove connection</PixelButton>
        </div>
        {confirmDelete && <StatusMessage tone="warning"><p>Remove the saved connection and stop automatic backups? Files already on your drive remain there.</p>
          <div className="data-management__actions"><PixelButton variant="danger" disabled={disabled} onClick={() => void perform(async () => { await deleteWebDav(); await refreshStatus(); setConfirmDelete(false); setNotice("Connection removed. Automatic backups are off."); })}>Confirm remove connection</PixelButton>
          <PixelButton variant="secondary" disabled={disabled} onClick={() => setConfirmDelete(false)}>Cancel</PixelButton></div>
        </StatusMessage>}
        <dl className="px-deflist">
          <div><dt>Next automatic backup</dt><dd>{dateLabel(config.nextRunAt)}</dd></div>
          <div><dt>Last backup attempt</dt><dd>{dateLabel(config.lastRunAt)}</dd></div>
          <div><dt>Last result</dt><dd>{config.lastStatus ?? "No backup yet"}</dd></div>
        </dl>
        {config.lastError && <StatusMessage tone="error">Last backup failed: {config.lastError}</StatusMessage>}
      </>}
      <div className="data-management__section">
        <h3>Backup history</h3>
        <p className="muted">Backups created by this account on this installation. To import other backups, download the JSON file from your drive and select it above.</p>
        {history.length === 0 ? <p>No backups recorded yet.</p> : <ul className="data-management__history">{history.map((record) => <li key={record.id}>
          <div><strong className="data-management__filename">{record.filename}</strong><p className="muted">{scopeLabel(record.scope)} · {dateLabel(record.createdAt)} · {(record.size / 1024).toFixed(1)} KiB</p></div>
          {record.available ? <div className="data-management__actions">
            <PixelButton variant="secondary" size="sm" disabled={disabled || dirty} onClick={() => void perform(async () => saveDownload(await downloadBackup(record.id)))}>Download {record.filename}</PixelButton>
            <PixelButton variant="secondary" size="sm" disabled={disabled || dirty} onClick={() => void perform(async () => { await onPrepare(record); })}>Review {record.filename} for import</PixelButton>
          </div> : <p className="muted">Unavailable with the current connection or permissions.</p>}
        </li>)}</ul>}
      </div>
    </>}
    {busy && <p role="status">Working on WebDAV…</p>}
    {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
    {error && <StatusMessage tone="error">{error}</StatusMessage>}
  </PixelWindow>;
}
