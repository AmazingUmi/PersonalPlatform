import { useEffect, useRef, useState } from "react";
import { localizeError } from "../shared/localizeError";
import { useI18n, type Translate } from "../shared/i18n";
import { HelpPopover } from "../shared/ui/HelpPopover";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelInput } from "../shared/ui/PixelInput";
import { StatusMessage } from "../shared/ui/StatusMessage";
import {
  backupWebDav, deleteWebDav, downloadBackup, exportData, getBackupHistory, getWebDav,
  importSnapshot, parseBackup, previewMerge, saveDownload, saveWebDav, testWebDav,
  type BackupResult, type BackupMode, type BackupRecord, type DataScope, type MergeReport, type WebDavConfig,
} from "../shared/dataManagement";
import { SyncPanel } from "./SyncPanel";
import "./dataManagement.css";

const errorValue = (error: unknown) => error instanceof Error ? error : new Error("The operation failed. Please try again.");
const dateLabel = (value: string | null, locale: string) => value ? new Date(value).toLocaleString(locale) : "—";
const scopeLabel = (scope: DataScope, t: Translate) => scope === "all" ? t("All users", "所有用户") : t("My data", "我的数据");
const kibLabel = (bytes: number, locale: string) => (bytes / 1024).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
type Notice = { kind: "saved" | "connected" | "removed" } | { kind: "backup"; result: BackupResult };
function noticeLabel(notice: Notice, t: Translate, locale: string): string {
  if (notice.kind === "saved") return t("Backup settings saved.", "备份设置已保存。");
  if (notice.kind === "connected") return t("Connection successful. WebDAV directory is reachable. This test did not save settings or verify backup writes.", "连接成功，WebDAV 目录可访问。本次测试未保存设置，也未验证备份写入权限。");
  if (notice.kind === "removed") return t("Connection removed. Automatic backups are off.", "连接已移除，自动备份已关闭。");
  if (notice.kind !== "backup") return "";
  const result = notice.result;
  const objects = result.uploadedObjects.toLocaleString(locale);
  const size = kibLabel(result.uploadedBytes, locale);
  if (result.status === "unchanged") return result.uploadedObjects > 0
    ? t(`Data is unchanged. Repaired ${objects} missing object(s), uploading ${size} KiB. No new backup was created.`, `数据未变化。已修复 ${objects} 个缺失对象，上传 ${size} KiB，未创建新备份。`)
    : t("Data is unchanged. Nothing was uploaded and no new backup was created.", "数据未变化，未上传任何内容，也未创建新备份。");
  const filename = result.backup?.filename ?? t("completed", "完成");
  return t(`Backup saved: ${filename}. Uploaded ${size} KiB in ${objects} object(s).`, `备份已保存：${filename}。已上传 ${size} KiB，共 ${objects} 个对象。`);
}
function backupStatusLabel(status: string | null, t: Translate): string {
  if (status === null) return t("No backup yet", "暂无备份");
  return ({ success: t("success", "成功"), failed: t("failed", "失败"), unchanged: t("unchanged", "无变化") } as Record<string, string>)[status] ?? status;
}

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
  const { t, locale, language } = useI18n();
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
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch (err) { setError(errorValue(err)); }
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
    <div ref={dataRef} tabIndex={-1} className="settings-focus-target" aria-label={t("Data management", "数据管理")}>
    <PixelWindow title={t("Data management", "数据管理")} icon="file" className="data-management" titleHelp={<HelpPopover label={t("About data backups", "关于数据备份")}><p>{t("Export a full JSON backup of your app data and attachments, or merge a previous full backup into this installation.", "导出包含应用数据和附件的完整 JSON 备份，或将历史全量备份合并到当前平台。")}</p><p className="muted">{t("Settings backups use JSON (up to 32 MiB, including attachments). Sessions, WebDAV passwords and server configuration are excluded. Old SQL/archive backups require offline conversion.", "备份为 JSON 格式，含附件最大 32 MiB。不包含登录会话、WebDAV 密码和服务器配置。旧 SQL 或归档备份需要先离线转换。")}</p></HelpPopover>}>
      <div className="data-management__actions">
        <label className="data-management__field" htmlFor="data-scope">{t("Data scope", "数据范围")} <select id="data-scope" className="px-input" value={scope} disabled={busy} onChange={(event) => {
            setScope(event.target.value as DataScope); resetSelection();
          }}>
            <option value="own">{t("My data", "我的数据")}</option>
            {admin && <option value="all">{t("All users (administrator)", "所有用户（管理员）")}</option>}
          </select>
        </label>
        <PixelButton disabled={busy} onClick={() => void perform(async () => saveDownload(await exportData(scope)))}>{t("Export backup", "导出备份")}</PixelButton>
      </div>
      {scope === "all" && <StatusMessage tone="warning">{t("This backup includes all users' app data and account password hashes. Store it privately.", "此备份包含所有用户的应用数据和账号密码散列，请妥善保密。")}</StatusMessage>}
      <div className="data-management__section">
        <div className="px-inline-help"><h3>{t("Merge a previous backup", "合并历史备份")}</h3><HelpPopover label={t("About merging backups", "关于备份合并")}><p>{t("Current records are kept. Missing records and relationships are added. A conflict that cannot be merged safely stops the entire import.", "保留当前记录，补入缺失的数据和关联。遇到无法安全合并的冲突时，会停止整批导入。")}</p></HelpPopover></div>
        <input ref={fileRef} id="backup-file" aria-label={t("Backup file", "备份文件")} type="file" hidden accept=".json,application/json" disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void readSelection(file);
        }} />
        <div className="data-management__file-picker">
          <PixelButton variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>{t("Choose file", "选择文件")}</PixelButton>
          <span className="data-management__filename" aria-live="polite">{source ? t(`Selected: ${source}`, `已选择：${source}`) : t("No file selected", "未选择文件")}</span>
        </div>
        <div className="data-management__actions">
          <PixelButton variant="secondary" disabled={busy || snapshot === null} onClick={() => void perform(async () => {
            setResult(null); setPreview(null); setPreview(await previewMerge(scope, snapshot));
          })}>{t("Preview merge", "预览合并")}</PixelButton>
          {source && <PixelButton variant="ghost" disabled={busy} onClick={resetSelection}>{t("Clear selection", "清除选择")}</PixelButton>}
        </div>
        {preview && <div className="data-management__preview" data-testid="merge-preview">
          <h3>{t("Review merge", "检查合并内容")}</h3>
          <p>{scopeLabel(preview.scope, t)} {t("· Created", "· 创建于")} {dateLabel(preview.createdAt, locale)} · {preview.files.toLocaleString(locale)} {t("attachment(s)", "个附件")}</p>
          <MergeTable report={preview} />
          <p>{t("Preview:", "预览：")} {preview.inserted.toLocaleString(locale)} {t("to add,", "条待添加，")} {preview.skipped.toLocaleString(locale)} {t("to keep. Counts are checked again when you merge.", "条保留。合并时会重新核对数量。")}</p>
          <PixelButton disabled={busy} onClick={() => void perform(async () => {
            const imported = await importSnapshot(scope, snapshot);
            setPreview(null); setSnapshot(null); setSource("");
            if (fileRef.current) fileRef.current.value = "";
            setResult(imported);
          })}>{t("Merge missing data", "合并缺失数据")}</PixelButton>
        </div>}
        {result && <StatusMessage tone="success">{t("Merge complete:", "合并完成：")} {result.inserted.toLocaleString(locale)} {t("added,", "条已添加，")} {result.skipped.toLocaleString(locale)} {t("existing records kept. Reload other app pages to see imported data.", "条现有记录已保留。重新打开其他应用页面可查看导入数据。")}</StatusMessage>}
      </div>
      {busy && <p role="status">{t("Working…", "处理中…")}</p>}
      {error && <StatusMessage tone="error">{localizeError(error, language)}</StatusMessage>}
    </PixelWindow>
    </div></div>
    {(webDavVisited || section === "webdav") && <div hidden={section !== "webdav"}><WebDavPanel admin={admin} onPrepare={prepareRemote} importBusy={busy} /></div>}
  </>;
}

const dataLabels: Record<string, [string, string]> = {
  "core.users": ["User accounts", "用户账号"], "core.settings": ["Platform preferences", "平台偏好"], "tasks.tasks": ["Tasks", "任务"],
  "notes.notes": ["Notes", "笔记"], "notes.tags": ["Note tags", "笔记标签"], "notes.note_tags": ["Note tag links", "笔记标签关联"],
  "assets.items": ["Assets", "资产"], "assets.categories": ["Asset categories", "资产分类"], "assets.item_categories": ["Asset category links", "资产分类关联"],
  "assets.attachments": ["Attachments", "附件"], "clock.settings": ["Clock preferences", "时钟偏好"], "clock.alarms": ["Alarms", "闹钟"],
  "clock.world_clocks": ["World clocks", "世界时钟"], "focus.settings": ["Focus preferences", "专注偏好"], "focus.sessions": ["Focus sessions", "专注记录"],
  "mini_game.saves": ["Game saves", "游戏存档"],
};

function MergeTable({ report }: { report: MergeReport }) {
  const { t, locale } = useI18n();
  return <div className="data-management__table-wrap"><table className="data-management__table">
    <thead><tr><th>{t("Data", "数据")}</th><th>{t("Add", "添加")}</th><th>{t("Keep", "保留")}</th><th>{t("Conflicts", "冲突")}</th></tr></thead>
    <tbody>{report.tables.map((row) => <tr key={row.table}><td>{dataLabels[row.table] ? t(...dataLabels[row.table]!) : row.table}</td><td>{row.inserted.toLocaleString(locale)}</td><td>{row.skipped.toLocaleString(locale)}</td><td>{row.conflicts.toLocaleString(locale)}</td></tr>)}</tbody>
  </table></div>;
}

function WebDavPanel({ admin, onPrepare, importBusy }: { admin: boolean; onPrepare: (record: BackupRecord) => Promise<void>; importBusy: boolean }) {
  const { t, locale, language } = useI18n();
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view");
  const view = requestedView === "backup" || requestedView === "history" || requestedView === "sync" ? requestedView : "connection";
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
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
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
    } catch (err) { if (mounted.current) setLoadError(errorValue(err)); }
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
    try { await action(); } catch (err) { setError(errorValue(err)); }
    finally { setBusy(false); }
  }
  async function refreshStatus() {
    const [next, list] = await Promise.all([getWebDav(), getBackupHistory()]);
    applyConfig(next); setHistory(list.items);
  }

  return <PixelWindow title={t("WebDAV backup", "WebDAV 备份")} icon="file" className="data-management" titleHelp={<HelpPopover label={t("About WebDAV backup", "关于 WebDAV 备份")}><p>{t("Save backups to your WebDAV drive.", "将备份保存到支持 WebDAV 的网盘。")}</p></HelpPopover>}>
    <nav className="settings-subnav" aria-label={t("WebDAV sections", "WebDAV 分区")}>
      {(["connection", "backup", "history", "sync"] as const).map((item) => <Link key={item} to={viewUrl(item)} aria-current={view === item ? "page" : undefined} className={`px-button px-button--${view === item ? "primary" : "secondary"} px-button--md`}>{item === "connection" ? t("Connection", "连接") : item === "backup" ? t("Backup", "备份") : item === "history" ? t("History", "历史") : t("Sync", "同步")}</Link>)}
    </nav>
    {loading ? <p role="status">{t("Loading backup settings…", "正在加载备份设置…")}</p> : loadError ? <StatusMessage tone="error">
      <p>{t("Could not load backup settings:", "无法加载备份设置：")} {localizeError(loadError, language)}</p><PixelButton variant="secondary" onClick={() => void load()}>{t("Retry backup settings", "重新加载备份设置")}</PixelButton>
    </StatusMessage> : <>
      <div hidden={view !== "connection"}>
      <form className="data-management__form" onSubmit={(event) => { event.preventDefault(); void perform(async () => {
        applyConfig(await saveWebDav({ endpoint: endpoint.trim(), username, ...(password ? { password } : {}), scope, intervalHours }));
        setHistory((await getBackupHistory()).items); setNotice({ kind: "saved" }); setConfirmDelete(false);
      }); }}>
        <div className="data-management__field">
          <span className="px-inline-help">
            <label htmlFor="webdav-endpoint">{t("WebDAV folder URL", "WebDAV 目录地址")}</label>
            <HelpPopover label={t("Connection setup", "连接设置")}>
              <p className="muted">{t("Test the entered connection before saving. Testing does not save settings or enable automatic backups.", "可先测试当前输入再保存。测试不会保存设置或开启自动备份。")}</p>
              <h4>{t("Nutstore (坚果云) setup", "坚果云设置方法")}</h4>
              <p>{t("Use", "使用")} <code>https://dav.jianguoyun.com/dav/</code> {t("or an existing folder under it, your account email, and an app password from Account information → Security → Third-party applications. Use the app password rather than your sign-in password.", "或其下已有目录，填写账号邮箱和在“账号信息 → 安全选项 → 第三方应用管理”生成的应用密码，而非登录密码。")} <a href="https://help.jianguoyun.com/?p=3234" target="_blank" rel="noreferrer">{t("Nutstore instructions", "坚果云官方说明")}</a></p>
              <p className="muted">{t("Use an existing WebDAV folder. Passwords are encrypted on the server and are never displayed here. Public HTTPS works by default; private or HTTP servers require the administrator's server allowlist.", "请使用已存在的 WebDAV 目录。密码加密存储且不回显。默认允许公网 HTTPS，内网或 HTTP 服务需要由管理员配置精确地址例外。")}</p>
            </HelpPopover>
          </span>
          <PixelInput id="webdav-endpoint" type="url" required value={endpoint} disabled={disabled} onChange={(event) => { setEndpoint(event.target.value); clearConnectionFeedback(); }} placeholder="https://drive.example.com/backups/" autoComplete="off" />
        </div>
        <label className="data-management__field" htmlFor="webdav-username">{t("WebDAV username", "WebDAV 用户名")} <PixelInput id="webdav-username" required value={username} disabled={disabled} onChange={(event) => { setUsername(event.target.value); clearConnectionFeedback(); }} autoComplete="off" />
        </label>
        <label className="data-management__field" htmlFor="webdav-password">{t("WebDAV password or app token", "WebDAV 密码或应用授权密码")} <PixelInput id="webdav-password" type="password" value={password} disabled={disabled} required={!canReusePassword} onChange={(event) => { setPassword(event.target.value); clearConnectionFeedback(); }} autoComplete="new-password" placeholder={config?.hasPassword ? t("Saved — leave blank to keep", "已保存，留空以保留") : t("Enter password or app token", "输入密码或应用授权密码")} />
        </label>
        <label className="data-management__field" htmlFor="webdav-scope">{t("Backup scope", "备份范围")} <select id="webdav-scope" className="px-input" value={scope} disabled={disabled} onChange={(event) => setScope(event.target.value as DataScope)}>
            <option value="own">{t("My data", "我的数据")}</option>{admin && <option value="all">{t("All users (administrator)", "所有用户（管理员）")}</option>}
          </select>
        </label>
        <div className="data-management__field">
          <span className="px-inline-help">
            <label htmlFor="webdav-interval">{t("Automatic backup", "自动备份")}</label>
            <HelpPopover label={t("About automatic backups", "关于自动备份")}><p className="muted">{t("Automatic backups are incremental. The first backup establishes a baseline; later backups upload changed data blocks and new attachments. Unchanged data creates no new backup. After downtime, one overdue backup runs when the server resumes. Existing remote files are not deleted automatically.", "自动备份采用增量方式：首次建立基线，之后上传变化的数据块和新增附件；无变化不新增备份。服务恢复后会补做一次到期备份，不会自动删除网盘现有文件。")}</p></HelpPopover>
          </span>
          <select id="webdav-interval" className="px-input" value={intervalHours} disabled={disabled} onChange={(event) => setIntervalHours(Number(event.target.value))}>
            <option value={0}>{t("Off — manual only", "关闭——仅手动备份")}</option>
            {[1, 6, 12, 24, 168].map((hours) => <option key={hours} value={hours}>{t(`Every ${hours.toLocaleString(locale)} hour${hours === 1 ? "" : "s"}`, `每 ${hours.toLocaleString(locale)} 小时`)}</option>)}
          </select>
        </div>
        <div className="data-management__actions">
          <PixelButton variant="secondary" disabled={disabled || !canTest} onClick={() => void perform(async () => {
            await testWebDav({ endpoint: endpoint.trim(), username, ...(password ? { password } : {}) });
            setNotice({ kind: "connected" });
          })}>{t("Test connection", "测试连接")}</PixelButton>
          <PixelButton type="submit" disabled={disabled || !dirty}>{t("Save backup settings", "保存备份设置")}</PixelButton>
        </div>
      </form>
      {endpoint.trim().startsWith("http:") && <StatusMessage tone="warning">{t("HTTP sends your credentials and backup without transport encryption.", "HTTP 会以未加密的方式传输凭据和备份。")}</StatusMessage>}
      {scope === "all" && <StatusMessage tone="warning">{t("All-users backups include account password hashes and everyone's app data. Only administrators can use this scope.", "所有用户备份包含账号密码散列及每个人的应用数据，仅管理员可使用。")}</StatusMessage>}
      {config?.configured && <div className="data-management__actions">
        <PixelButton variant="danger" disabled={disabled} onClick={() => setConfirmDelete(true)}>{t("Remove connection", "移除连接")}</PixelButton>
      </div>}
      {confirmDelete && <StatusMessage tone="warning"><p>{t("Remove the saved connection and stop automatic backups? Files already on your drive remain there.", "移除已保存的连接并停止自动备份？网盘上的现有文件会保留。")}</p>
        <div className="data-management__actions"><PixelButton variant="danger" disabled={disabled} onClick={() => void perform(async () => { await deleteWebDav(); await refreshStatus(); setConfirmDelete(false); setNotice({ kind: "removed" }); })}>{t("Confirm remove connection", "确认移除连接")}</PixelButton>
        <PixelButton variant="secondary" disabled={disabled} onClick={() => setConfirmDelete(false)}>{t("Cancel", "取消")}</PixelButton></div>
      </StatusMessage>}
      </div>
      <div hidden={view !== "backup"}>
      {!config?.configured && <p>{t("Set up a connection to start backing up your data.", "请先配置连接以开始备份。")}</p>}
      {config?.configured && <>
        {dirty && <p className="muted">{t("Save your changes before creating a backup.", "请先保存修改，再创建备份。")}</p>}
        <div className="data-management__field">
          <span className="px-inline-help">
            <label htmlFor="webdav-mode">{t("Manual backup mode", "手动备份方式")}</label>
            <HelpPopover label={t("About backup modes", "关于备份方式")}><p className="muted">{t("Full mode uploads an independent complete file. It does not change the automatic incremental schedule.", "全量方式上传独立的完整备份文件，不改变自动增量备份计划。")}</p></HelpPopover>
          </span>
          <select id="webdav-mode" className="px-input" value={backupMode} disabled={disabled} onChange={(event) => setBackupMode(event.target.value as BackupMode)}>
            <option value="incremental">{t("Incremental — changed data only", "增量——仅变化的数据")}</option>
            <option value="full">{t("Full — independent JSON file", "全量——独立 JSON 文件")}</option>
          </select>
        </div>
        <div className="data-management__actions">
          <PixelButton disabled={disabled || dirty} onClick={() => void perform(async () => {
            try {
              const result = await backupWebDav(backupMode);
              setNotice({ kind: "backup", result });
            }
            finally { await refreshStatus(); }
          })}>{t("Back up now", "立即备份")}</PixelButton>
          <PixelButton variant="ghost" disabled={disabled || dirty} onClick={() => void perform(refreshStatus)}>{t("Refresh backup status", "刷新备份状态")}</PixelButton>
        </div>
        <dl className="px-deflist">
          <div><dt>{t("Next automatic backup", "下次自动备份")}</dt><dd>{dateLabel(config.nextRunAt, locale)}</dd></div>
          <div><dt>{t("Last backup attempt", "最近备份尝试")}</dt><dd>{dateLabel(config.lastRunAt, locale)}</dd></div>
          <div><dt>{t("Last result", "最近结果")}</dt><dd>{backupStatusLabel(config.lastStatus, t)}</dd></div>
        </dl>
        {config.lastError && <StatusMessage tone="error">{t("Last backup failed:", "最近备份失败：")} {localizeError(config.lastError, language)}</StatusMessage>}
      </>}
      </div>
      <div hidden={view !== "history"}>
        <div className="px-inline-help"><h3>{t("Backup history", "备份历史")}</h3><HelpPopover label={t("About backup history", "关于备份历史")}><p className="muted">{t("Download and Review reconstruct an incremental backup as a full JSON file. Keep its remote manifest and all referenced objects together. For backups outside this history, a full JSON file can be imported in Data; incremental manifests need the offline reconstruction tool.", "下载和预览会将增量备份重组为完整 JSON，请保留网盘上的清单及其引用对象。不在此历史中的完整 JSON 可在“数据”中导入；增量清单需先离线重组。")}</p></HelpPopover></div>
        <p className="muted">{t("Showing the latest", "当前显示最近")} {history.length.toLocaleString(locale)} {t("recorded backups (up to 100).", "条备份记录（最多 100 条）。")}</p>
        <PixelButton variant="secondary" disabled={disabled || dirty} onClick={() => void perform(refreshStatus)}>{t("Refresh history", "刷新历史")}</PixelButton>
        {history.length === 0 ? <p>{t("No backups recorded yet.", "暂无备份记录。")}</p> : <ul className="data-management__history">{history.slice((page - 1) * 10, page * 10).map((record) => <li key={record.id}>
          <div><strong className="data-management__filename">{record.filename}</strong><p className="muted">{record.kind === "incremental" ? t("Incremental", "增量") : t("Full", "全量")} · {scopeLabel(record.scope, t)} · {dateLabel(record.createdAt, locale)} {t("· Full data", "· 完整数据")} {kibLabel(record.size, locale)} {t("KiB · Uploaded", "KiB · 已上传")} {kibLabel(record.uploadedBytes, locale)} KiB</p></div>
          {record.available ? <div className="data-management__actions">
            <PixelButton variant="secondary" aria-label={t(`Download ${record.filename}`, `下载 ${record.filename}`)} disabled={disabled || dirty} onClick={() => void perform(async () => saveDownload(await downloadBackup(record.id)))}>{t("Download", "下载")}</PixelButton>
            <PixelButton variant="secondary" aria-label={t(`Review ${record.filename} for import`, `预览 ${record.filename} 以导入`)} disabled={disabled || dirty} onClick={() => void perform(async () => { await onPrepare(record); })}>{t("Review", "预览")}</PixelButton>
          </div> : <p className="muted">{t("Unavailable with the current connection or permissions.", "当前连接或权限下不可用。")}</p>}
        </li>)}</ul>}
        {history.length > 0 && <nav className="data-management__actions" aria-label={t("Backup history pages", "备份历史分页")}>
          <PixelButton variant="secondary" disabled={disabled || page === 1} onClick={() => changePage(page - 1)}>{t("Previous page", "上一页")}</PixelButton>
          <span role="status">{t("Page", "第")} {page.toLocaleString(locale)} {t("of", "/")} {pageCount.toLocaleString(locale)} · {history.length.toLocaleString(locale)} {t("records", "条记录")}</span>
          <PixelButton variant="secondary" disabled={disabled || page === pageCount} onClick={() => changePage(page + 1)}>{t("Next page", "下一页")}</PixelButton>
        </nav>}
      </div>
      <div hidden={view !== "sync"}>
        <SyncPanel configured={Boolean(config?.configured)} connectionLoading={false} />
      </div>
    </>}
    {busy && <p role="status">{t("Working on WebDAV…", "正在处理 WebDAV…")}</p>}
    {notice && <StatusMessage tone="success">{noticeLabel(notice, t, locale)}</StatusMessage>}
    {error && <StatusMessage tone="error">{localizeError(error, language)}</StatusMessage>}
  </PixelWindow>;
}
