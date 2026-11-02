import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n, type Translate } from "../shared/i18n";
import { localizeError } from "../shared/localizeError";
import { ApiError } from "../shared/api";
import { attachmentSummary, conflictFieldEntries, conflictRecordLabel, type SyncConflict, type SyncStatus } from "../shared/sync";
import { HelpPopover } from "../shared/ui/HelpPopover";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelInput } from "../shared/ui/PixelInput";
import { StatusMessage } from "../shared/ui/StatusMessage";
import { useSync } from "./SyncContext";

const TABLE_LABELS: Record<string, [string, string]> = {
  "tasks.tasks": ["Task", "任务"],
  "notes.notes": ["Note", "笔记"],
  "notes.tags": ["Note tag", "笔记标签"],
  "notes.note_tags": ["Note tag link", "笔记标签关联"],
  "assets.items": ["Asset", "资产"],
  "assets.categories": ["Asset category", "资产分类"],
  "assets.item_categories": ["Asset category link", "资产分类关联"],
  "assets.attachments": ["Attachment", "附件"],
  "clock.settings": ["Clock preferences", "时钟偏好"],
  "clock.alarms": ["Alarm", "闹钟"],
  "clock.world_clocks": ["World clock", "世界时钟"],
  "focus.settings": ["Focus preferences", "专注偏好"],
  "focus.sessions": ["Focus session", "专注记录"],
  "mini_game.saves": ["Game save", "游戏存档"],
};

const FIELD_LABELS: Record<string, [string, string]> = {
  title: ["Title", "标题"], name: ["Name", "名称"], text: ["Text", "正文"], body: ["Text", "正文"], content: ["Text", "正文"],
  notes: ["Notes", "备注"], done: ["Done", "已完成"], completed: ["Done", "已完成"],
  filename: ["File name", "文件名"], original_filename: ["File name", "文件名"],
  content_type: ["File type", "文件类型"], mime: ["File type", "文件类型"],
  size: ["Size in bytes", "大小（字节）"], byte_size: ["Size in bytes", "大小（字节）"],
  high_score: ["High score", "最高分"], label: ["Label", "标签"],
};

const REASONS: Record<string, [string, string]> = {
  diverged: ["This record was changed on this device and in the cloud.", "这条记录在本机和云端都有不同修改。"],
  tombstone: ["One side deleted this record while the other side still has it.", "一侧已删除这条记录，另一侧仍然保留。"],
  "deleted-locally": ["This device deleted the record, and the cloud still has a copy.", "本机已删除该记录，云端仍保留一份。"],
  resurrection: ["This record was removed and later recreated, so the two copies no longer match.", "这条记录曾被删除后又重新出现，两边已无法直接合并。"],
  "focus-active": ["A focus session is still running on one side. Sync will not stop a running timer.", "一侧的专注仍在进行。同步不会停止正在计时的专注。"],
};

function syncErrorText(error: unknown, language: "en" | "zh"): string {
  const code = error instanceof ApiError && error.code ? error.code : error instanceof Error && "code" in error ? String(error.code) : "";
  const detail = error instanceof Error ? error.message : "";
  const known: Record<string, [string, string]> = {
    sync_already_linked: ["This account is already linked. Unlink before choosing another identity.", "此账号已关联。请先取消关联，再选择另一个同步身份。"],
    sync_not_linked: ["Continuous sync is not set up yet.", "尚未设置持续同步。"],
    invalid_pairing_code: ["Enter the pairing code from the device that created this sync identity.", "请输入创建该同步身份的设备上显示的配对码。"],
    sync_identity_taken: ["That sync identity is already linked to another account on this server.", "该同步身份已关联到此服务器上的另一个账号。"],
    invalid_interval: ["Choose 2 minutes, 1 minute, or manual only.", "请选择 2 分钟、1 分钟或仅手动。"],
    sync_not_ready: ["Sync stays off until the WebDAV folder accepts safe updates.", "在 WebDAV 目录接受安全更新之前，同步保持关闭。"],
    sync_disabled: ["Turn sync on before choosing a version or syncing now.", "请先开启同步，再选择版本或立即同步。"],
    sync_conflict_missing: ["That conflict is no longer open. The list was refreshed.", "该冲突已不再待处理，列表已刷新。"],
    sync_stale: ["The record changed before the choice was saved. Review it again. The conflict is still open.", "选择保存前记录已变化，请重新查看。冲突仍然保留。"],
    sync_busy: ["Sync is already running for this account. It will try again after a short pause.", "此账号的同步已在进行。短暂停顿后会再试。"],
    sync_busy_local: ["Sync is already running in another open tab.", "另一个打开的标签页正在同步。"],
    sync_destination_locked: ["Unlink continuous sync before using a different WebDAV folder or username.", "更换 WebDAV 目录或用户名之前，请先取消持续同步的关联。"],
    sync_remote_missing: ["The cloud sync copy is missing. Local data was kept.", "云端同步副本缺失，本机数据已保留。"],
    sync_remote_exists: ["This folder already has sync data. Join it with the pairing code instead of creating a new one.", "该文件夹已有同步数据。请使用配对码加入，不要新建一份。"],
    sync_stopped: ["Continuous sync stopped before this step finished.", "持续同步在这一步完成前已停止。"],
    sync_foreign_owner: ["A record belongs to another account. Nothing from this sync was applied.", "有一条记录属于其他账号，这次同步没有写入。"],
    webdav_cas_unsupported: ["This WebDAV folder cannot safely store sync data. Sync was not left running. Check the folder permissions or use a server that supports conditional updates.", "此 WebDAV 目录无法安全保存同步数据，同步未保持开启。请检查目录权限，或改用支持条件更新的服务。"],
    webdav_not_configured: ["Save a WebDAV connection before starting sync.", "请先保存 WebDAV 连接，再开始同步。"],
    invalid_sync: ["The cloud copy could not be checked. Sync did not change your data.", "无法核对云端副本，同步没有改动你的数据。"],
    invalid_sync_request: ["The sync request was incomplete. Nothing was linked.", "同步请求不完整，没有建立关联。"],
    sync_generation_regressed: ["The cloud copy looks older than the last confirmed sync. Local data was kept.", "云端副本比上次已确认的同步更旧，本机数据已保留。"],
  };
  if (code && known[code]) {
    const text = language === "zh" ? known[code][1] : known[code][0];
    return code === "webdav_cas_unsupported" && detail ? `${text}\n${detail}` : text;
  }
  return localizeError(error, language);
}

function phaseLabel(status: SyncStatus, t: Translate): string {
  if (!status.linked || status.phase === "unlinked") return t("Not linked", "未关联");
  if (status.phase === "bootstrap" && !status.baseline) return t("First sync in progress", "正在进行首次同步");
  if (status.phase === "publication_unknown") return t("Waiting to confirm the cloud copy", "正在等待确认云端副本");
  if (status.phase === "linked" || status.baseline) return t("Linked", "已关联");
  return t("Linked", "已关联");
}

function fieldLabel(key: string, t: Translate): string {
  const known = FIELD_LABELS[key];
  if (known) return t(...known);
  return key.replaceAll("_", " ");
}

function ConflictCard({ item, disabled, onChoose }: { item: SyncConflict; disabled: boolean; onChoose: (choice: "keep-local" | "keep-remote") => void }) {
  const { t } = useI18n();
  const { table } = conflictRecordLabel(item.syncKey);
  const tableLabel = TABLE_LABELS[table] ? t(...TABLE_LABELS[table]) : table.replaceAll("_", " ");
  const reason = REASONS[item.reason] ? t(...REASONS[item.reason]) : t("This record needs a choice before sync can continue for it.", "这条记录需要你做出选择后，同步才能继续处理它。");
  const link = table.endsWith("_tags") || table.endsWith("item_categories") || table.includes("note_tags");
  return <article className="data-management__section" aria-label={tableLabel}>
    <div className="px-inline-help">
      <h4>{tableLabel}</h4>
      <HelpPopover label={t("About this conflict", "关于此冲突")}>
        <p>{link
          ? t("This choice updates one relationship. If the server rejects it, the conflict stays and other records are left as they are.", "此选择只更新一条关联。如果服务器拒绝，冲突会保留，其他记录保持原样。")
          : t("Keep this device or keep the cloud copy. If the server rejects the choice, this conflict stays open.", "保留本机或保留云端。如果服务器拒绝该选择，此冲突会继续保留。")}</p>
      </HelpPopover>
    </div>
    <p>{reason}</p>
    <div className="data-management__actions">
      <Side title={t("This device", "本机")} row={item.local} deletedLabel={t("Deleted on this device", "已在本机删除")} />
      <Side title={t("Cloud", "云端")} row={item.remote} deletedLabel={t("Deleted in the cloud", "已在云端删除")} />
    </div>
    <div className="data-management__actions">
      <PixelButton variant="secondary" disabled={disabled} onClick={() => onChoose("keep-local")}>{item.local === null ? t("Accept deletion on this device", "接受本机删除") : t("Keep this device", "保留本机")}</PixelButton>
      <PixelButton variant="secondary" disabled={disabled} onClick={() => onChoose("keep-remote")}>{item.remote === null ? t("Accept cloud deletion", "接受云端删除") : t("Keep cloud", "保留云端")}</PixelButton>
    </div>
    <p className="muted">{item.remote === null
      ? t("Accepting the cloud deletion removes the copy on this device after the server accepts the choice. If that fails, the conflict stays.", "接受云端删除会在服务器接受该选择后删除本机副本。如果失败，冲突会保留。")
      : item.local === null
        ? t("Accepting deletion on this device confirms the record stays deleted here. If the server rejects the choice, the conflict stays.", "接受本机删除表示这条记录在本机保持删除。如果服务器拒绝该选择，冲突会保留。")
        : t("The chosen copy is kept only after the server accepts it. A failure leaves both the conflict and your unsaved work in place.", "只有服务器接受后，才会保留所选副本。如果失败，冲突和未保存的内容都会留下。")}</p>
  </article>;
}

function FieldValue({ value }: { value: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (value.length <= 240) return <>{value}</>;
  return <>{expanded ? value : `${value.slice(0, 240)}…`} <PixelButton variant="ghost" size="sm" onClick={() => setExpanded((open) => !open)}>{expanded ? t("Show less", "收起") : t("Show all", "展开全部")}</PixelButton></>;
}

function Side({ title, row, deletedLabel }: { title: string; row: Record<string, unknown> | null; deletedLabel: string }) {
  const { t } = useI18n();
  const attachment = attachmentSummary(row);
  const fields = conflictFieldEntries(row).filter((field) => !attachment || !["filename", "original_filename", "name", "content_type", "mime", "size", "byte_size"].includes(field.key));
  return <div>
    <h5>{title}</h5>
    {row === null ? <p>{deletedLabel}</p> : <>
      {attachment && <p>{t("File", "文件")}: {attachment.filename}{attachment.type ? ` · ${attachment.type}` : ""}{attachment.size ? ` · ${attachment.size} ${t("bytes", "字节")}` : ""}</p>}
      {fields.length > 0 && <dl className="px-deflist">{fields.map((field) => <div key={field.key}><dt>{fieldLabel(field.key, t)}</dt><dd><FieldValue value={field.value} /></dd></div>)}</dl>}
      {!attachment && fields.length === 0 && <p className="muted">{t("No readable fields on this copy.", "此副本没有可阅读的字段。")}</p>}
    </>}
  </div>;
}

export function SyncPanel({ configured, connectionLoading }: { configured: boolean; connectionLoading: boolean }) {
  const { t, language } = useI18n();
  const [params] = useSearchParams();
  const sync = useSync();
  const [pairingInput, setPairingInput] = useState("");
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const connectionUrl = (() => {
    const next = new URLSearchParams(params);
    next.set("section", "webdav");
    next.set("view", "connection");
    return `?${next}`;
  })();
  const status = sync.status;
  const firstSyncOpen = Boolean(status?.linked && status.phase === "bootstrap" && !status.baseline);
  const dataReady = Boolean(status?.baseline || status?.result === "bootstrap" || status?.result === "published" || status?.result === "committed");

  const attempt = (work: Promise<unknown>) => { void work.catch(() => undefined); };
  async function copyCode() {
    if (!sync.pairingCode) return;
    try {
      await navigator.clipboard.writeText(sync.pairingCode);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return <section aria-labelledby="webdav-sync-heading">
    <div className="px-inline-help">
      <h3 id="webdav-sync-heading">{t("Continuous sync", "持续同步")}</h3>
      <HelpPopover label={t("About continuous sync", "关于持续同步")}>
        <p>{t("Sync copies this signed-in account both ways while the platform remains open. Create a cloud sync identity on the first device, or join with the pairing code from the device that created it. Each local account links once, even when the usernames differ. People can share one WebDAV folder by using separate identities. Sync stays off until you choose Create or Join. Administrator backup of every account stays on the Backup tab.", "同步在平台页面保持打开期间，双向复制当前登录账号的数据。第一台设备创建云端同步身份，其他部署用配对码加入。每个本地账号只关联一次，即使用户名不同。多人可以共用一个 WebDAV 目录，但各自使用不同的同步身份。在你选择创建或加入之前，同步保持关闭。管理员的全部账号备份仍在“备份”页。")}</p>
      </HelpPopover>
    </div>
    {connectionLoading ? <p role="status">{t("Loading sync…", "正在加载同步…")}</p> : !configured ? <StatusMessage tone="warning">
      <p>{t("Save a WebDAV connection first. Sync uses that saved connection and does not ask for the password again.", "请先保存 WebDAV 连接。同步使用已保存的连接，不会再次询问密码。")}</p>
      <Link to={connectionUrl} className="px-button px-button--secondary px-button--md">{t("Open connection", "打开连接")}</Link>
    </StatusMessage> : <>
      {!status && !sync.loadError && <p role="status">{t("Loading sync status…", "正在加载同步状态…")}</p>}
      {sync.loadError && !status && <StatusMessage tone="error"><p>{syncErrorText(sync.loadError, language)}</p><PixelButton variant="secondary" onClick={() => attempt(sync.refresh())}>{t("Retry sync status", "重试同步状态")}</PixelButton></StatusMessage>}
      {status && !status.linked && <form className="data-management__form" onSubmit={(event) => { event.preventDefault(); attempt(sync.joinIdentity(pairingInput.trim())); }}>
        <p>{t("This account is not linked. Nothing syncs until you create or join a cloud sync identity.", "此账号尚未关联。在创建或加入云端同步身份之前，不会同步任何内容。")}</p>
        <div className="data-management__actions">
          <PixelButton type="button" disabled={sync.busy} onClick={() => attempt(sync.createIdentity())}>{t("Create cloud sync identity", "创建云端同步身份")}</PixelButton>
        </div>
        <div className="data-management__field">
          <span className="px-inline-help">
            <label htmlFor="sync-pairing-code">{t("Pairing code", "配对码")}</label>
            <HelpPopover label={t("About joining", "关于加入")}>
              <p>{t("Use the code shown on the device that created the identity. The code links this local account to that identity. It is not guessed from your username.", "使用创建该身份的设备上显示的配对码。配对码把这个本地账号关联到该身份，不会根据用户名猜测。")}</p>
            </HelpPopover>
          </span>
          <PixelInput id="sync-pairing-code" value={pairingInput} disabled={sync.busy} autoComplete="off" onChange={(event) => setPairingInput(event.target.value)} />
          <PixelButton type="submit" variant="secondary" disabled={sync.busy || pairingInput.trim() === ""}>{t("Join with pairing code", "使用配对码加入")}</PixelButton>
        </div>
      </form>}
      {status?.linked && <>
        <dl className="px-deflist">
          <div><dt>{t("Status", "状态")}</dt><dd>{phaseLabel(status, t)}{status.enabled ? "" : t(" · paused", " · 已暂停")}</dd></div>
          <div><dt>{t("Open choices", "待选择")}</dt><dd>{status.openConflicts.toLocaleString()}</dd></div>
        </dl>
        {firstSyncOpen && <p role="status">{t("The link is saved. The first sync has not finished, so cloud data is not shown as present yet.", "关联已保存。首次同步尚未完成，因此还不能把云端数据视为已经到达。")}</p>}
        {dataReady && status.result === "bootstrap" && <p role="status">{t("The first sync finished downloading the cloud copy.", "首次同步已下载云端副本。")}</p>}
        {status.pending && <p role="status">{t("An upload is still being confirmed.", "一次上传仍在确认中。")}</p>}
        {status.backoffUntil && Date.parse(status.backoffUntil) > Date.now() && <p role="status">{t("Sync is pausing after a connection problem.", "连接出现问题后，同步正在暂停。")}</p>}
        {status.lastError && <StatusMessage tone="error">{t("Last sync problem:", "最近的同步问题：")} {syncErrorText(new Error(status.lastError), language)}</StatusMessage>}
        <div className="data-management__field">
          <span className="px-inline-help">
            <label htmlFor="sync-interval">{t("Sync timing", "同步间隔")}</label>
            <HelpPopover label={t("About sync timing", "关于同步间隔")}>
              <p>{t("Automatic sync runs only while you are signed in and the platform remains open. Manual waits until you press Sync now. Closing the platform stops later sync. A request already sent cannot be undone.", "自动同步只在你已登录且平台页面保持打开时运行。手动方式会等到你按下“立即同步”。关闭平台页面会停止之后的同步。已经发出的请求无法撤回。")}</p>
            </HelpPopover>
          </span>
          <select id="sync-interval" className="px-input" value={status.intervalSeconds === 60 || status.intervalSeconds === 0 ? status.intervalSeconds : 120} disabled={sync.busy} onChange={(event) => attempt(sync.setIntervalSeconds(Number(event.target.value) as 0 | 60 | 120))}>
            <option value={120}>{t("Every 2 minutes", "每 2 分钟")}</option>
            <option value={60}>{t("Every 1 minute", "每 1 分钟")}</option>
            <option value={0}>{t("Manual only", "仅手动")}</option>
          </select>
        </div>
        <div className="data-management__actions">
          <PixelButton variant="secondary" disabled={sync.busy} aria-pressed={status.enabled} onClick={() => attempt(sync.setEnabled(!status.enabled))}>{status.enabled ? t("Pause sync", "暂停同步") : t("Resume sync", "恢复同步")}</PixelButton>
          <PixelButton disabled={sync.busy || !status.enabled} onClick={() => attempt(sync.syncNow())}>{t("Sync now", "立即同步")}</PixelButton>
          <PixelButton variant="secondary" disabled={sync.busy} onClick={() => attempt(sync.refresh())}>{t("Refresh sync status", "刷新同步状态")}</PixelButton>
        </div>
        <div className="data-management__section">
          <div className="px-inline-help">
            <h4>{t("Pairing code", "配对码")}</h4>
            <HelpPopover label={t("About the pairing code", "关于配对码")}>
              <p>{t("Show the code only when you are ready to link another deployment of this same account. It is cleared when you hide it, sign out, or unlink.", "只在准备把同一账号的另一次部署关联进来时显示配对码。隐藏、退出登录或取消关联时会清除显示。")}</p>
            </HelpPopover>
          </div>
          <div className="data-management__actions">
            {!sync.pairingCode && <PixelButton variant="secondary" disabled={sync.busy} onClick={() => { setCopyState("idle"); attempt(sync.revealPairing()); }}>{t("Show pairing code", "显示配对码")}</PixelButton>}
            {sync.pairingCode && <>
              <PixelButton variant="secondary" disabled={sync.busy} onClick={() => void copyCode()}>{t("Copy pairing code", "复制配对码")}</PixelButton>
              <PixelButton variant="ghost" onClick={() => { setCopyState("idle"); sync.hidePairing(); }}>{t("Hide pairing code", "隐藏配对码")}</PixelButton>
            </>}
          </div>
          {sync.pairingCode && <div className="data-management__field">
            <label htmlFor="sync-pairing-visible">{t("Pairing code", "配对码")}</label>
            <PixelInput id="sync-pairing-visible" readOnly value={sync.pairingCode} onFocus={(event) => event.currentTarget.select()} />
          </div>}
          {copyState === "copied" && <p role="status">{t("Pairing code copied.", "配对码已复制。")}</p>}
          {copyState === "failed" && <p role="status">{t("Could not copy automatically. Select the code above and copy it yourself.", "无法自动复制。请选中上方配对码并手动复制。")}</p>}
        </div>
        {!confirmUnlink ? <PixelButton variant="danger" disabled={sync.busy} onClick={() => setConfirmUnlink(true)}>{t("Unlink this account", "取消此账号的关联")}</PixelButton> : <StatusMessage tone="warning">
          <p>{t("Unlink this account from the cloud sync identity? Data on this device and in the cloud is kept. Sync stops until you create or join again.", "取消此账号与云端同步身份的关联？本机和云端的数据都会保留。在再次创建或加入之前，同步会停止。")}</p>
          <div className="data-management__actions">
            <PixelButton variant="danger" disabled={sync.busy} onClick={() => void sync.unlink().then(() => setConfirmUnlink(false)).catch(() => undefined)}>{t("Confirm unlink", "确认取消关联")}</PixelButton>
            <PixelButton variant="secondary" disabled={sync.busy} onClick={() => setConfirmUnlink(false)}>{t("Cancel", "取消")}</PixelButton>
          </div>
        </StatusMessage>}
        {sync.conflictsError && <StatusMessage tone="error">{syncErrorText(sync.conflictsError, language)}</StatusMessage>}
        {sync.conflicts.map((item) => <ConflictCard key={item.id} item={item} disabled={sync.busy || !status.enabled} onChoose={(choice) => attempt(sync.resolveConflict(item.id, choice))} />)}
      </>}
      {sync.busy && <p role="status">{t("Working on sync…", "正在处理同步…")}</p>}
      {sync.actionError && <StatusMessage tone="error">{syncErrorText(sync.actionError, language)}</StatusMessage>}
    </>}
  </section>;
}
