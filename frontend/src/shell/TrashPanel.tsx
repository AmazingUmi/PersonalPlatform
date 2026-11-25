import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type AppInfo } from "../shared/api";
import { useI18n, type Translate } from "../shared/i18n";
import { appName } from "../shared/localizedMetadata";
import { useAsync } from "../shared/useAsync";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { LoadingState } from "../shared/ui/LoadingState";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { StatusChip } from "../shared/ui/StatusChip";
import { StatusMessage } from "../shared/ui/StatusMessage";

const trashUrl = "/api/core/trash";
const pageSize = 20;
const dayInMs = 24 * 60 * 60 * 1000;
const coveredApps = [
  { id: "tasks", name: "Tasks" },
  { id: "notes", name: "Notes" },
  { id: "assets", name: "Assets" },
  { id: "clock", name: "Clock" },
];

interface TrashEntry {
  id: string;
  appId: string;
  title: string;
  summary: string | null;
  deletedByType: "user" | "agent";
  deletedByLabel: string;
  deletedAt: string;
  expiresAt: string;
}

interface RestoredItem {
  appId: string;
  entityType: string;
  restoredId: string;
}

type Confirmation = { kind: "purge"; entry: TrashEntry } | { kind: "empty" };
type Action = Confirmation | { kind: "restore"; entry: TrashEntry };
type Success = { kind: "restore"; restored: RestoredItem } | { kind: Confirmation["kind"] };

function restoredItemPath(item: RestoredItem): string | undefined {
  const id = encodeURIComponent(item.restoredId);
  switch (`${item.appId}/${item.entityType}`) {
    case "tasks/task": return `/tasks/${id}`;
    case "notes/note": return `/notes/${id}`;
    case "assets/asset_item": return `/assets/items/${id}`;
    case "clock/clock_alarm": return `/clock?alarm=${id}`;
  }
}

function actionError(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "not_found":
        return t("This item is no longer in Trash.", "此项目已不在回收站中。");
      case "app_disabled":
        return t("Enable this app in App Center before restoring the item.", "请先在应用中心启用此应用，再恢复项目。");
      case "app_unavailable":
        return t("This app is currently unavailable for restore.", "此应用目前无法恢复项目。");
      case "original_live":
        return t("The original item is already present in the app.", "原项目已存在于应用中。");
      case "trash_payload_invalid":
        return t("The app cannot restore this archived item.", "应用无法恢复此归档项目。");
    }
  }
  return t("The Trash action could not be completed. Reload the list and try again.", "无法完成回收站操作。请刷新列表后重试。");
}

export function TrashPanel({ apps }: { apps: AppInfo[] }) {
  const { t, locale, language } = useI18n();
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [success, setSuccess] = useState<Success | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const records = useAsync(() => {
    const query = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (filter) query.set("appId", filter);
    return api<{ items: TrashEntry[]; hasMore: boolean }>(`${trashUrl}?${query}`);
  }, [filter, page]);
  const items = records.data?.items ?? [];

  function labelFor(appId: string): string {
    const installed = apps.find((entry) => entry.id === appId);
    const fallback = coveredApps.find((entry) => entry.id === appId)?.name ?? appId;
    return appName(appId, installed?.name ?? fallback, language);
  }

  async function perform(action: Action): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setSuccess(null);
    setError(null);
    try {
      if (action.kind === "restore") {
        const restored = await api<RestoredItem>(`${trashUrl}/${encodeURIComponent(action.entry.id)}/restore`, { method: "POST" });
        setSuccess({ kind: "restore", restored });
      } else {
        const path = action.kind === "empty" ? trashUrl : `${trashUrl}/${encodeURIComponent(action.entry.id)}`;
        await api(path, { method: "DELETE" });
        setSuccess({ kind: action.kind });
      }
      if (page > 0 && action.kind === "empty") setPage(0);
      else if (page > 0 && items.length === 1 && !records.data?.hasMore) setPage(page - 1);
      else await records.reload();
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiError && failure.code === "not_found") await records.reload();
    } finally {
      setConfirmation(null);
      inFlight.current = false;
      setBusy(false);
    }
  }

  const openPath = success?.kind === "restore" ? restoredItemPath(success.restored) : undefined;
  const canEmpty = records.data !== null && (items.length > 0 || page > 0 || filter !== "");

  return (
    <PixelWindow title={t("Trash", "回收站")} icon="trash" className="trash-panel">
      <div className="trash-panel__toolbar">
        <div className="trash-panel__filter">
          <label htmlFor="trash-app-filter">{t("App", "应用")}</label>
          <select id="trash-app-filter" className="px-input" value={filter} disabled={busy} onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}>
            <option value="">{t("All apps", "全部应用")}</option>
            {coveredApps.map(({ id }) => <option key={id} value={id}>{labelFor(id)}</option>)}
          </select>
        </div>
        <PixelButton size="sm" variant="danger" disabled={busy || !canEmpty} onClick={() => setConfirmation({ kind: "empty" })}>
          {t("Empty Trash", "清空回收站")}
        </PixelButton>
      </div>

      {success && (
        <StatusMessage tone="success">
          {success.kind === "restore" && t("Item restored.", "项目已恢复。")}
          {success.kind === "purge" && t("Item permanently deleted.", "项目已永久删除。")}
          {success.kind === "empty" && t("Trash emptied.", "回收站已清空。")}
          {openPath && <> <Link to={openPath}>{t("Open restored item", "打开已恢复的项目")}</Link></>}
        </StatusMessage>
      )}
      {error !== null && <StatusMessage tone="error">{actionError(error, t)}</StatusMessage>}
      {records.loading && <LoadingState label={t("Loading Trash…", "正在加载回收站…")} />}
      {records.error && (
        <StatusMessage tone="error">
          <p>{t("Could not load Trash.", "无法加载回收站。")}</p>
          <PixelButton size="sm" variant="secondary" disabled={busy} onClick={records.reload}>{t("Retry", "重试")}</PixelButton>
        </StatusMessage>
      )}
      {records.data && items.length === 0 && (
        <EmptyState icon="trash" title={filter ? t("No items from this app", "此应用没有已删除的项目") : t("No items in Trash", "回收站没有项目")} />
      )}
      {items.length > 0 && (
        <ul className="trash-panel__list">
          {items.map((entry) => {
            const title = entry.title || t("Untitled", "无标题");
            const deletedAt = new Date(entry.deletedAt);
            const expiresAt = new Date(entry.expiresAt);
            const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / dayInMs));
            const actor = entry.deletedByType === "agent" ? t(`Agent: ${entry.deletedByLabel}`, `Agent：${entry.deletedByLabel}`) : t("You", "你");
            return (
              <li key={entry.id} className="trash-panel__entry">
                <div className="trash-panel__description">
                  <h3>{title}</h3>
                  {entry.summary && <p>{entry.summary}</p>}
                  <div className="trash-panel__metadata">
                    <span>{labelFor(entry.appId)}</span>
                    <StatusChip chip={{ id: entry.deletedByType, label: actor, tone: entry.deletedByType === "agent" ? "info" : "neutral", title: entry.deletedByLabel }} />
                    <time dateTime={entry.deletedAt}>{deletedAt.toLocaleString(locale)}</time>
                    <time dateTime={entry.expiresAt} title={expiresAt.toLocaleString(locale)}>
                      {daysLeft === 1 ? t("1 day left", "还剩 1 天") : t(`${daysLeft} days left`, `还剩 ${daysLeft} 天`)}
                    </time>
                  </div>
                </div>
                <div className="trash-panel__actions">
                  <PixelButton size="sm" disabled={busy} aria-label={t(`Restore ${title}`, `恢复${title}`)} onClick={() => void perform({ kind: "restore", entry })}>
                    {t("Restore", "恢复")}
                  </PixelButton>
                  <PixelButton size="sm" variant="secondary" disabled={busy} aria-label={t(`Permanently delete ${title}`, `永久删除${title}`)} onClick={() => setConfirmation({ kind: "purge", entry })}>
                    {t("Permanent Delete", "永久删除")}
                  </PixelButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {(page > 0 || records.data?.hasMore) && (
        <nav className="trash-panel__actions" aria-label={t("Trash pages", "回收站分页")}>
          <PixelButton variant="secondary" size="sm" disabled={busy || records.loading || page === 0} onClick={() => setPage(page - 1)}>{t("Previous", "上一页")}</PixelButton>
          <span>{t(`Page ${page + 1}`, `第 ${page + 1} 页`)}</span>
          <PixelButton variant="secondary" size="sm" disabled={busy || !records.data?.hasMore} onClick={() => setPage(page + 1)}>{t("Next", "下一页")}</PixelButton>
        </nav>
      )}
      {confirmation && (
        <ConfirmDialog
          title={confirmation.kind === "empty" ? t("Empty Trash", "清空回收站") : t("Permanently delete item", "永久删除项目")}
          message={confirmation.kind === "empty"
            ? t("Permanently delete all items in your Trash across all apps? This cannot be undone.", "永久删除回收站中所有应用的项目？此操作无法撤销。")
            : t(`Permanently delete “${confirmation.entry.title || "Untitled"}”? This cannot be undone.`, `永久删除“${confirmation.entry.title || "无标题"}”？此操作无法撤销。`)}
          confirmLabel={confirmation.kind === "empty" ? t("Empty Trash", "清空回收站") : t("Permanent Delete", "永久删除")}
          busy={busy}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void perform(confirmation)}
        />
      )}
    </PixelWindow>
  );
}
