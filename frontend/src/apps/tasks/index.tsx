import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useAppDisplayName } from "../../shared/PresentationContext";
import type { FrontendAppModule, WidgetDensity } from "../../shared/appTypes";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useMutation } from "../../shared/useMutation";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge, type BadgeTone } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { appIconName } from "../../shared/ui/appIcons";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelMeter } from "../../shared/ui/PixelMeter";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";
import { SyncPendingNotice, armPendingIfSyncConflict, useCoherentDraft, useSyncModelRefresh } from "../../shared/sync-guard-client";
import { usePulseOnChange } from "../../shared/motion/usePulseOnChange";

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  start_at: string | null;
  due_at: string | null;
  priority: number;
  completed_at: string | null;
  baseHash?: string;
}

export const PRIORITIES = [
  { value: 0, label: "Low", zh: "低", tone: "neutral" as BadgeTone },
  { value: 1, label: "Normal", zh: "普通", tone: "info" as BadgeTone },
  { value: 2, label: "High", zh: "高", tone: "warning" as BadgeTone },
  { value: 3, label: "Urgent", zh: "紧急", tone: "danger" as BadgeTone },
] as const;

const SORT_OPTIONS = [
  { value: "createdAt", label: "Added", zh: "添加时间" },
  { value: "updatedAt", label: "Modified", zh: "修改时间" },
  { value: "startAt", label: "Start", zh: "开始时间" },
  { value: "dueAt", label: "Deadline", zh: "截止时间" },
  { value: "priority", label: "Priority", zh: "优先级" },
  { value: "title", label: "Title", zh: "标题" },
  { value: "status", label: "Status", zh: "状态" },
] as const;

const STATUS_FILTERS = [
  { value: "", label: "All", zh: "全部" },
  { value: "todo", label: "Todo", zh: "待办" },
  { value: "done", label: "Done", zh: "已完成" },
] as const;

/** Filter keys that count towards the collapsed Filters-button badge. */
const TASKS_FILTER_KEYS = ["q", "status", "priority", "dueAfter", "dueBefore"];

function countActiveFilters(params: URLSearchParams, keys: string[]): number {
  return keys.reduce((count, key) => (params.get(key) ? count + 1 : count), 0);
}

function priorityMeta(priority: number) {
  return PRIORITIES.find((entry) => entry.value === priority) ?? PRIORITIES[1]!;
}

function isOverdue(task: Task): boolean {
  return task.status !== "done" && task.due_at !== null && new Date(task.due_at).getTime() < Date.now();
}

function formatDateTime(value: string | null, locale: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** ISO instant -> value usable by <input type="datetime-local"> in local time. */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local value -> ISO instant (null when empty). */
function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function tasksQueryString(params: URLSearchParams): string {
  const query = new URLSearchParams();
  for (const key of ["q", "status", "priority", "startAfter", "startBefore", "dueAfter", "dueBefore", "sortBy", "order"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

interface TaskEditorState {
  title: string;
  description: string;
  status: string;
  startAt: string;
  dueAt: string;
  priority: number;
}

function emptyEditorState(): TaskEditorState {
  return { title: "", description: "", status: "todo", startAt: "", dueAt: "", priority: 1 };
}

function editorStateFromTask(task: Task): TaskEditorState {
  return {
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    startAt: toLocalInputValue(task.start_at),
    dueAt: toLocalInputValue(task.due_at),
    priority: task.priority,
  };
}

/** Create/edit task dialog (FP-4.3). Empty optional fields are omitted on
 * create and sent as null on edit so nullable columns can be cleared. */
function TaskEditor({
  task,
  onClose,
  onSaved,
  pending = false,
  onReload,
  onDismiss,
  onDirtyChange,
  onSyncConflict,
}: {
  task: Task | null;
  onClose: () => void;
  onSaved: () => void;
  pending?: boolean;
  onReload?: () => Promise<boolean> | boolean | void;
  onDismiss?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSyncConflict?: () => void;
}) {
  const { t } = useI18n();
  const baseHash = useRef(task?.baseHash);
  const [form, setForm] = useState<TaskEditorState>(() =>
    task ? editorStateFromTask(task) : emptyEditorState(),
  );
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const signature = task ? `${task.id}\0${task.baseHash ?? ""}` : null;
  const draft = useCoherentDraft(task, signature, dirty, (incoming) => {
    baseHash.current = incoming.baseHash;
    setForm(editorStateFromTask(incoming));
    setDirty(false);
  }, onDismiss);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const set = <K extends keyof TaskEditorState>(key: K, value: TaskEditorState[K]) => {
    draft.cancelAdopt();
    dirtyRef.current = true;
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = useMutation(async () => {
    const base: Record<string, unknown> = {
      title: form.title.trim(),
      description: form.description.trim() === "" ? null : form.description.trim(),
      startAt: fromLocalInputValue(form.startAt),
      dueAt: fromLocalInputValue(form.dueAt),
      priority: form.priority,
    };
    const body = task ? { ...base, status: form.status, ...(baseHash.current ? { baseHash: baseHash.current } : {}) } : base;
    if (task) {
      try {
        await api(`/api/apps/tasks/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        armPendingIfSyncConflict(error, () => onSyncConflict?.());
        throw error;
      }
    } else {
      await api("/api/apps/tasks/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || save.busy) return;
    if (await save.mutate()) onSaved();
  };

  return (
    <div className="px-dialog-backdrop" role="presentation">
      <PixelWindow
        title={task ? t("Edit Task", "编辑任务") : t("New Task", "新建任务")}
        icon="tasks"
        className="px-dialog px-dialog--form"
        data-testid="task-editor"
      >
        <SyncPendingNotice
          pending={pending || draft.stale}
          discard={dirty}
          onReload={() => {
            draft.requestAdopt();
            void Promise.resolve(onReload?.()).then((ok) => {
              if (ok === false) draft.cancelAdopt();
            });
          }}
        />
        <form className="px-form" onSubmit={submit} aria-label={task ? t("Edit task", "编辑任务") : t("Create task", "创建任务")}>
          <label className="px-form__row">
            <span className="px-form__label">{t("Title", "标题")}</span>
            <PixelInput
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              aria-label={t("Task title", "任务标题")}
              required
              autoFocus
            />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">{t("Description", "描述")}</span>
            <textarea
              className="px-textarea"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              aria-label={t("Task description", "任务描述")}
            />
          </label>
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">{t("Status", "状态")}</span>
              <select
                className="px-select"
                value={form.status}
                onChange={(e) => set("status", e.target.value)}
                aria-label={t("Status", "状态")}
              >
                <option value="todo">{t("Todo", "待办")}</option>
                <option value="done">{t("Done", "已完成")}</option>
              </select>
            </label>
            <label className="px-form__row">
              <span className="px-form__label">{t("Priority", "优先级")}</span>
              <select
                className="px-select"
                value={form.priority}
                onChange={(e) => set("priority", Number(e.target.value))}
                aria-label={t("Priority", "优先级")}
              >
                {PRIORITIES.map((priority) => (
                  <option key={priority.value} value={priority.value}>
                    {t(priority.label, priority.zh)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">{t("Start", "开始")}</span>
              <PixelInput
                type="datetime-local"
                value={form.startAt}
                onChange={(e) => set("startAt", e.target.value)}
                aria-label={t("Start time", "开始时间")}
              />
            </label>
            <label className="px-form__row">
              <span className="px-form__label">{t("Deadline", "截止时间")}</span>
              <PixelInput
                type="datetime-local"
                value={form.dueAt}
                onChange={(e) => set("dueAt", e.target.value)}
                aria-label={t("Deadline", "截止时间")}
              />
            </label>
          </div>
          {save.error ? (
            <StatusMessage tone="error">
              <p>{save.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={save.busy}>
              {t("Cancel", "取消")}</PixelButton>
            <PixelButton type="submit" size="sm" disabled={!form.title.trim() || save.busy}>
              {save.busy ? t("Saving…", "正在保存…") : task ? t("Save changes", "保存修改") : t("Create task", "创建任务")}
            </PixelButton>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}

function TasksPage() {
  const { t, locale } = useI18n();
  const displayName = useAppDisplayName({ id: "tasks", name: "Tasks" });
  const [searchParams, setSearchParams] = useSearchParams();
  const [editorFor, setEditorFor] = useState<Task | null | undefined>(undefined);
  const [editorDirty, setEditorDirty] = useState(false);
  const [deleting, setDeleting] = useState<Task | null>(null);
  // Filters collapse into a header button; a deep link with active filters
  // starts expanded.
  const [filtersOpen, setFiltersOpen] = useState(
    () => countActiveFilters(new URLSearchParams(window.location.search), TASKS_FILTER_KEYS) > 0,
  );

  const setParam = (key: string, value: string) => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  // Debounced search -> URL (FP-4/FP-7.1).
  const rawSearch = searchParams.get("q") ?? "";
  const [searchInput, setSearchInput] = useState(rawSearch);
  const debouncedSearch = useDebouncedValue(searchInput, 250);
  const appliedSearch = searchParams.get("q") ?? "";
  useEffect(() => {
    if (debouncedSearch !== appliedSearch) setParam("q", debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);
  useEffect(() => {
    setSearchInput(rawSearch);
  }, [rawSearch]);

  const statusFilter = searchParams.get("status") ?? "";
  const sortBy = searchParams.get("sortBy") ?? "createdAt";
  const order = searchParams.get("order") ?? "desc";

  const tasks = useAsync(
    () => api<{ items: Task[] }>(`/api/apps/tasks/tasks${tasksQueryString(searchParams)}`),
    [searchParams.toString()],
    { retainOnReload: true },
  );
  const refresh = () => { void tasks.reload(); };
  const sync = useSyncModelRefresh(editorDirty, refresh);
  useEffect(() => {
    if (!tasks.data || editorFor == null) return;
    const fresh = tasks.data.items.find((item) => item.id === editorFor.id);
    if (fresh && fresh !== editorFor) setEditorFor(fresh);
  }, [tasks.data, editorFor]);

  const setStatus = async (task: Task, status: string) => {
    try {
      await api(`/api/apps/tasks/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, ...(task.baseHash ? { baseHash: task.baseHash } : {}) }),
      });
      refresh();
    } catch {
      refresh();
    }
  };

  const remove = useMutation(async () => {
    if (!deleting) return;
    await api(`/api/apps/tasks/tasks/${deleting.id}`, {
      method: "DELETE",
      headers: deleting.baseHash ? { "x-base-hash": deleting.baseHash } : undefined,
    });
  });

  const resetFilters = () => {
    setSearchParams(new URLSearchParams(), { replace: true });
    setSearchInput("");
  };

  const items = tasks.data?.items ?? [];
  const activeFilterCount = countActiveFilters(searchParams, TASKS_FILTER_KEYS);
  const hasFilters = Boolean(tasksQueryString(searchParams));

  return (
    <div className="page" data-app="tasks">
      <SyncPendingNotice pending={sync.pending} onReload={sync.reload} />
      <header className="page-header">
        <div className="px-inline-help">
          <h1 className="page-header__title">
            <PixelIcon name={appIconName("tasks")} size={20} className="page-header__app-icon" aria-hidden="true" /> {displayName}
          </h1>
          <HelpPopover label={t("About tasks", "关于任务")}><p>{t("Personal task manager", "管理个人任务、优先级与截止时间。")}</p></HelpPopover>
        </div>
        <div className="page-header__actions">
          <PixelButton
            size="sm"
            variant="secondary"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <PixelIcon name="search" /> {t("Filters", "筛选")}{activeFilterCount > 0 ? <PixelBadge tone="warning">{activeFilterCount.toLocaleString(locale)}</PixelBadge> : null}
          </PixelButton>
          <PixelButton size="sm" onClick={() => setEditorFor(null)}>
            <PixelIcon name="plus" /> {t("New Task", "新建任务")}</PixelButton>
        </div>
      </header>

      {filtersOpen ? (
      <PixelWindow title={t("Filters", "筛选")} icon="search" className="assets-filters" actions={
        <PixelButton variant="ghost" size="sm" onClick={resetFilters} disabled={activeFilterCount === 0}>
          {t("Reset", "重置")}</PixelButton>
      }>
        <div className="assets-filters__row">
          <div className="assets-search">
            <PixelIcon name="search" />
            <PixelInput
              placeholder={t("Search tasks…", "搜索任务…")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label={t("Search tasks", "搜索任务")}
            />
          </div>
          <div className="px-seg" role="group" aria-label={t("Filter tasks by status", "按状态筛选任务")}>
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className="px-seg__btn"
                aria-pressed={statusFilter === filter.value}
                onClick={() => setParam("status", filter.value)}
              >
                {t(filter.label, filter.zh)}
              </button>
            ))}
          </div>
          <select
            className="px-select"
            value={searchParams.get("priority") ?? ""}
            onChange={(e) => setParam("priority", e.target.value)}
            aria-label={t("Filter by priority", "按优先级筛选")}
          >
            <option value="">{t("All priorities", "全部优先级")}</option>
            {PRIORITIES.map((priority) => (
              <option key={priority.value} value={priority.value}>
                {t(priority.label, priority.zh)}
              </option>
            ))}
          </select>
        </div>
        <div className="assets-filters__row">
          <label className="assets-filters__date">
            <span>{t("Due from", "截止日期从")}</span>
            <PixelInput
              type="date"
              value={searchParams.get("dueAfter")?.slice(0, 10) ?? ""}
              onChange={(e) =>
                setParam("dueAfter", e.target.value ? new Date(`${e.target.value}T00:00`).toISOString() : "")
              }
              aria-label={t("Due after", "截止日期起点")}
            />
          </label>
          <label className="assets-filters__date">
            <span>{t("to", "至")}</span>
            <PixelInput
              type="date"
              value={searchParams.get("dueBefore")?.slice(0, 10) ?? ""}
              onChange={(e) =>
                setParam("dueBefore", e.target.value ? new Date(`${e.target.value}T23:59`).toISOString() : "")
              }
              aria-label={t("Due before", "截止日期终点")}
            />
          </label>
          <select
            className="px-select"
            value={sortBy}
            onChange={(e) => setParam("sortBy", e.target.value)}
            aria-label={t("Sort by", "排序依据")}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(`Sort: ${option.label}`, `排序：${option.zh}`)}
              </option>
            ))}
          </select>
          <PixelButton
            size="sm"
            variant="secondary"
            onClick={() => setParam("order", order === "asc" ? "desc" : "asc")}
            aria-label={t(`Sort order: ${order}. Click to switch.`, `排序方向：${order === "asc" ? "升序" : "降序"}，点击切换。`)}
          >
            <PixelIcon name={order === "asc" ? "up" : "down"} />
            {order === "asc" ? t("Asc", "升序") : t("Desc", "降序")}
          </PixelButton>
          <span className="assets-filters__spacer" />
          <PixelButton size="sm" variant="secondary" onClick={() => setFiltersOpen(false)}>
            {t("Close", "关闭")}</PixelButton>
        </div>
      </PixelWindow>
      ) : null}

      {tasks.loading ? (
        <LoadingState label={t("Loading tasks…", "正在加载任务…")} />
      ) : tasks.error ? (
        <StatusMessage tone="error">
          <p>{tasks.error}</p>
          <PixelButton size="sm" variant="secondary" onClick={tasks.reload}>
            {t("Retry", "重试")}</PixelButton>
        </StatusMessage>
      ) : items.length === 0 && !hasFilters ? (
        <EmptyState
          icon="tasks"
          title={t("No tasks yet", "暂无任务")}
          description={t("Create your first task to start tracking your work.", "创建第一个任务，开始记录工作。")}
          action={
            <PixelButton size="sm" onClick={() => setEditorFor(null)}>
              <PixelIcon name="plus" /> {t("New Task", "新建任务")}</PixelButton>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState icon="search" title={t("No matching tasks", "没有匹配的任务")} description={t("Switch the filters to see other tasks.", "调整筛选条件以查看其他任务。")} />
      ) : (
        <PixelWindow title={t("Task Log", "任务列表")} icon="tasks" className="task-window">
          <ul className="task-list">
            {items.map((task) => {
              const done = task.status === "done";
              const priority = priorityMeta(task.priority);
              return (
                <li key={task.id} className={done ? "task task--done" : "task"}>
                  <input
                    type="checkbox"
                    className="px-checkbox"
                    checked={done}
                    onChange={() => void setStatus(task, done ? "todo" : "done")}
                    aria-label={done ? t(`Mark "${task.title}" as todo`, `将“${task.title}”标为待办`) : t(`Mark "${task.title}" as done`, `将“${task.title}”标为已完成`)}
                  />
                  <span className="task__body">
                    <span className="task__title">{task.title}</span>
                    <span className="task__meta">
                      <PixelBadge tone={priority.tone}>{t(priority.label, priority.zh)}</PixelBadge>
                      {task.start_at ? (
                        <PixelBadge tone="neutral">{t("Start", "开始")} {formatDateTime(task.start_at, locale)}</PixelBadge>
                      ) : null}
                      {task.due_at ? (
                        <PixelBadge tone={isOverdue(task) ? "danger" : "neutral"}>
                          {t("Due", "截止")} {formatDateTime(task.due_at, locale)}
                        </PixelBadge>
                      ) : null}
                      {done ? <PixelBadge tone="success">{t("Done", "已完成")}</PixelBadge> : null}
                    </span>
                  </span>
                  <span className="task__side">
                    <PixelButton
                      variant="ghost"
                      size="sm"
                      className="px-button--icon"
                      aria-label={t(`Edit task "${task.title}"`, `编辑任务“${task.title}”`)}
                      onClick={() => setEditorFor(task)}
                    >
                      <PixelIcon name="edit" />
                    </PixelButton>
                    <PixelButton
                      variant="ghost"
                      size="sm"
                      className="px-button--icon task__delete"
                      aria-label={t(`Delete task "${task.title}"`, `删除任务“${task.title}”`)}
                      onClick={() => setDeleting(task)}
                    >
                      <PixelIcon name="trash" />
                    </PixelButton>
                  </span>
                </li>
              );
            })}
          </ul>
        </PixelWindow>
      )}

      {editorFor !== undefined ? (
        <TaskEditor
          key={editorFor === null ? "new" : editorFor.id}
          task={editorFor}
          pending={sync.pending}
          onDirtyChange={setEditorDirty}
          onReload={() => tasks.reload()}
          onDismiss={sync.dismiss}
          onSyncConflict={sync.markPending}
          onClose={() => {
            setEditorDirty(false);
            setEditorFor(undefined);
          }}
          onSaved={() => {
            setEditorDirty(false);
            setEditorFor(undefined);
            refresh();
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={t("Delete task", "删除任务")}
          message={t(`Delete "${deleting.title}"? This cannot be undone.`, `删除“${deleting.title}”？此操作无法撤销。`)}
          busy={remove.busy}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (await remove.mutate()) {
              setDeleting(null);
              refresh();
            }
          }}
        />
      ) : null}
    </div>
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Read-only task detail at /tasks/:id — the deep-link target for other apps
 * (Clock's current/next task). Editing reuses the same TaskEditor dialog as
 * the list page.
 */
function TaskDetailPage() {
  const { t, locale } = useI18n();
  const { id } = useParams();
  const [editing, setEditing] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const task = useAsync(
    () => api<Task>(`/api/apps/tasks/tasks/${id}`),
    [id],
    { retainOnReload: true },
  );
  const refresh = () => { void task.reload(); };
  const sync = useSyncModelRefresh(editorDirty, refresh);

  if (task.loading && !task.data) {
    return (
      <div className="page page--detail" data-app="tasks">
        <LoadingState label={t("Loading task…", "正在加载任务…")} />
      </div>
    );
  }
  if ((task.error && !task.data) || !task.data) {
    return (
      <div className="page page--detail" data-app="tasks">
        <EmptyState
          icon="warning"
          title={t("Task not found", "任务不存在")}
          description={t("It may have been deleted, or the Tasks app was restarted.", "任务可能已删除，或任务应用已重新启动。")}
          action={
            <Link className="px-button px-button--secondary px-button--md" to="/tasks">
              {t("Back to Tasks", "返回任务")}</Link>
          }
        />
      </div>
    );
  }

  const current = task.data;
  const priority = priorityMeta(current.priority);

  const toggleStatus = async () => {
    try {
      await api(`/api/apps/tasks/tasks/${current.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: current.status === "done" ? "todo" : "done",
          ...(current.baseHash ? { baseHash: current.baseHash } : {}),
        }),
      });
    } finally {
      refresh();
    }
  };

  return (
    <div className="page page--detail" data-app="tasks">
      <header className="page-header">
        <div className="px-inline-help">
          <h1 className="page-header__title">{current.title}</h1>
          <HelpPopover label={t("Task detail", "任务详情")}><p>{t("Review the task schedule and status, edit its details or mark it complete.", "查看任务计划和状态，编辑详情或标记完成。")}</p></HelpPopover>
        </div>
        <div className="page-header__actions">
          <PixelButton variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <PixelIcon name="edit" /> {t("Edit", "编辑")}</PixelButton>
          <PixelButton
            variant={current.status === "done" ? "secondary" : "primary"}
            size="sm"
            onClick={toggleStatus}
          >
            {current.status === "done" ? t("Reopen", "重新打开") : t("Complete", "完成")}
          </PixelButton>
          <Link className="px-button px-button--secondary px-button--sm" to="/tasks">
            <PixelIcon name="back" /> {t("Tasks", "任务")}</Link>
        </div>
      </header>

      <PixelWindow title={t("Task", "任务")} icon="tasks">
        <dl className="px-deflist">
          <div className="task-detail__field">
            <dt>{t("Status", "状态")}</dt>
            <dd>
              {current.status === "done" ? (
                <PixelBadge tone="success">{t("Done", "已完成")}</PixelBadge>
              ) : (
                <PixelBadge tone="warning">{t("Todo", "待办")}</PixelBadge>
              )}
            </dd>
          </div>
          <div className="task-detail__field">
            <dt>{t("Priority", "优先级")}</dt>
            <dd>
              <PixelBadge tone={priority.tone}>{t(priority.label, priority.zh)}</PixelBadge>
            </dd>
          </div>
          <div className="task-detail__field">
            <dt>{t("Start", "开始")}</dt>
            <dd>{formatDateTime(current.start_at, locale)}</dd>
          </div>
          <div className="task-detail__field">
            <dt>{t("Deadline", "截止时间")}</dt>
            <dd>
              {formatDateTime(current.due_at, locale)}
              {isOverdue(current) ? (
                <>
                  {" "}
                  <PixelBadge tone="danger">{t("Overdue", "已逾期")}</PixelBadge>
                </>
              ) : null}
            </dd>
          </div>
          {current.completed_at ? (
            <div className="task-detail__field">
              <dt>{t("Completed", "完成时间")}</dt>
              <dd>{formatDateTime(current.completed_at, locale)}</dd>
            </div>
          ) : null}
        </dl>
        {current.description ? (
          <div className="task-detail__description">
            <h3 className="task-detail__description-title">{t("Notes", "备注")}</h3>
            <p>{current.description}</p>
          </div>
        ) : null}
      </PixelWindow>

      {editing ? (
        <TaskEditor
          key={current.id}
          task={current}
          pending={sync.pending}
          onDirtyChange={setEditorDirty}
          onReload={() => task.reload()}
          onDismiss={sync.dismiss}
          onSyncConflict={sync.markPending}
          onClose={() => {
            setEditorDirty(false);
            setEditing(false);
          }}
          onSaved={() => {
            setEditorDirty(false);
            setEditing(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** View of this app's own public status route (contract: apps/tasks/README.md). */
interface PublicTaskView {
  id: string;
  title: string;
  startAt: string;
}

interface PublicStatusView {
  current: PublicTaskView | null;
  next: PublicTaskView | null;
  today: { remainingCount: number };
}

/** /summary response. doneToday/overdueBeforeToday are the disjoint meter
 * segments (see the backend route) — additive, older payloads default 0. */
interface TasksSummaryView {
  today: number;
  overdue: number;
  done: number;
  doneToday?: number;
  overdueBeforeToday?: number;
}

const PUBLIC_STATUS_URL = "/api/apps/tasks/public/status";
const SUMMARY_URL = "/api/apps/tasks/summary";

/** Tasks still ahead today after the current one: next (if any) + the rest. */
function moreTodayCount(status: PublicStatusView | null): number {
  if (!status) return 0;
  return status.today.remainingCount + (status.next ? 1 : 0);
}

/**
 * Tasks Today dashboard card. Information density follows the container's
 * layout context: compact keeps the running task plus a one-line outlook,
 * normal shows the Today/Overdue/Done counters, expanded adds the
 * current/next/remaining block. The fetches follow the density so a compact
 * card never pays for data it cannot show.
 */
function TasksTodayWidget({ density = "normal" }: { density?: WidgetDensity }) {
  const { t, locale } = useI18n();
  const wantStatus = density !== "normal";
  const wantSummary = density !== "compact";
  const status = useAsync(
    () => (wantStatus ? api<PublicStatusView>(PUBLIC_STATUS_URL) : Promise.resolve(null)),
    [density],
  );
  const summary = useAsync(
    () =>
      wantSummary
        ? api<TasksSummaryView>(SUMMARY_URL)
        : Promise.resolve(null),
    [density],
  );
  // Counter pulses (motion system): one pop when a number actually changes.
  const todayPulse = usePulseOnChange<number, HTMLSpanElement>(summary.data?.today ?? 0);
  const overduePulse = usePulseOnChange<number, HTMLSpanElement>(summary.data?.overdue ?? 0);
  const donePulse = usePulseOnChange<number, HTMLSpanElement>(summary.data?.done ?? 0);
  useSyncModelRefresh(false, () => {
    status.reload();
    summary.reload();
  });
  if ((wantStatus && status.loading) || (wantSummary && summary.loading)) {
    return <LoadingState label={t("Loading…", "正在加载…")} />;
  }
  const statusError = wantStatus ? status.error : null;
  const summaryError = wantSummary ? summary.error : null;
  const error = statusError ?? summaryError;
  if (error) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{error}</p>
        </StatusMessage>
        <PixelButton size="sm" variant="secondary" onClick={status.error ? status.reload : summary.reload}>
          {t("Retry", "重试")}</PixelButton>
      </div>
    );
  }

  if (density === "compact") {
    const current = status.data?.current ?? null;
    return (
      <div className="tasks-widget tasks-widget--compact">
        <span className="tasks-widget__label">{t("CURRENT", "当前")}</span>
        <span className="tasks-widget__title">{current ? current.title : t("No running task", "当前没有任务")}</span>
        <span className="tasks-widget__more">{t(`${moreTodayCount(status.data).toLocaleString(locale)} MORE TODAY`, `今天还有 ${moreTodayCount(status.data).toLocaleString(locale)} 个任务`)}</span>
      </div>
    );
  }

  const data = summary.data ?? { today: 0, overdue: 0, done: 0 };
  // Today's completion meter over DISJOINT segments (backend contract):
  // completed today + still open due today + still open from before today.
  const doneToday = data.doneToday ?? 0;
  const meterTotal = doneToday + data.today + (data.overdueBeforeToday ?? 0);
  const meterPercent = meterTotal > 0 ? Math.round((doneToday / meterTotal) * 100) : 0;
  return (
    <div className="tasks-widget">
      {/* Planner head (PXOS 2.1 §6): one ruled index line instead of boxed
       * stat cards — the lead count first, overdue/done as margin notes. */}
      <div className="tasks-widget__head">
        <span className="tasks-widget__lead-label">{t("Today", "今天")}</span>
        <span className="tasks-widget__lead-value" ref={todayPulse}>{data.today.toLocaleString(locale, { minimumIntegerDigits: 2 })}</span>
        <span className="tasks-widget__note tasks-widget__note--overdue">
          <span className="tasks-widget__note-label">{t("Overdue", "已逾期")}</span>
          <b ref={overduePulse}>{data.overdue.toLocaleString(locale, { minimumIntegerDigits: 2 })}</b>
        </span>
        <span className="tasks-widget__note tasks-widget__note--done">
          <span className="tasks-widget__note-label">{t("Done", "已完成")}</span>
          <b ref={donePulse}>{data.done.toLocaleString(locale)}</b>
        </span>
      </div>
      {meterTotal > 0 ? (
        <div className="tasks-widget__progress">
          <PixelMeter
            value={doneToday}
            max={meterTotal}
            accent="mint"
            label={t(`Today: ${doneToday.toLocaleString(locale)} of ${meterTotal.toLocaleString(locale)} done`, `今天：已完成 ${doneToday.toLocaleString(locale)} / ${meterTotal.toLocaleString(locale)} 个任务`)}
          />
          <span className="tasks-widget__progress-value">{meterPercent}%</span>
        </div>
      ) : (
        /* Empty days keep the meter's silhouette (ten hollow segments) so the
         * card never collapses into blank space (dashboard empty-state rule). */
        <div className="tasks-widget__progress">
          <PixelMeter value={0} max={1} accent="mint" label={t("No tasks scheduled today", "今天没有计划任务")} />
          <span className="tasks-widget__progress-value tasks-widget__progress-value--empty">
            {t("NO TASKS SCHEDULED", "暂无计划任务")}</span>
        </div>
      )}
      {density !== "expanded" ? (
        /* Summary line at normal density (the expanded block carries the
         * richer CURRENT/NEXT zone instead): open work, spelled out so a
         * zero-data day still reads as a complete sentence. */
        <p className="tasks-widget__summary">
          {data.today + data.overdue > 0
            ? t(`${(data.today + data.overdue).toLocaleString(locale)} TASK${data.today + data.overdue === 1 ? "" : "S"} REMAINING`, `还有 ${(data.today + data.overdue).toLocaleString(locale)} 个任务`)
            : t("ALL DONE FOR TODAY", "今天的任务已全部完成")}
        </p>
      ) : (
        /* Checklist zone: current/next as ruled rows with checkbox rhythm. */
        <ul className="tasks-widget__checklist">
          <li className="tasks-widget__check">
            <span className="tasks-widget__check-box" aria-hidden="true" />
            <span className="tasks-widget__check-label">{t("CURRENT", "当前")}</span>
            <span className="tasks-widget__check-title">{status.data?.current ? status.data.current.title : t("None", "无")}</span>
          </li>
          <li className="tasks-widget__check">
            <span className="tasks-widget__check-box" aria-hidden="true" />
            <span className="tasks-widget__check-label">{t("NEXT", "下一个")}</span>
            <span className="tasks-widget__check-title">{status.data?.next ? status.data.next.title : t("None", "无")}</span>
          </li>
        </ul>
      )}
      {density === "expanded" ? (
        <p className="tasks-widget__count">{t(`${moreTodayCount(status.data).toLocaleString(locale)} MORE TODAY`, `今天还有 ${moreTodayCount(status.data).toLocaleString(locale)} 个任务`)}</p>
      ) : null}
    </div>
  );
}

const app: FrontendAppModule = {
  id: "tasks",
  routes: [
    { path: "", label: "Tasks", element: <TasksPage /> },
    { path: ":id", label: "Task Detail", element: <TaskDetailPage /> },
  ],
  widgets: [
    {
      id: "today",
      title: "Tasks Today",
      render: (context) => <TasksTodayWidget density={context?.layout.density ?? "normal"} />,
      layout: {
        minW: 16,
        minH: 10,
        defaultW: 26,
        defaultH: 18,
        defaultOrder: 20,
        density: {
          normal: { minW: 18, minH: 12 },
          expanded: { minW: 20, minH: 16 },
        },
      },
    },
  ],
  status: {
    // Dock/top-bar chip: open tasks due today (hidden at zero — an empty
    // day needs no badge). Same /summary endpoint the widget already uses.
    load: async () => {
      const summary = await api<{ today: number }>("/api/apps/tasks/summary");
      return summary.today > 0
        ? [{ id: "today", label: String(summary.today), tone: "info", title: `${summary.today} tasks due today` }]
        : [];
    },
  },
};

export default app;
