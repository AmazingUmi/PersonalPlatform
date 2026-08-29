import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../shared/api";
import type { FrontendAppModule } from "../../shared/appTypes";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useMutation } from "../../shared/useMutation";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge, type BadgeTone } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  start_at: string | null;
  due_at: string | null;
  priority: number;
  completed_at: string | null;
}

export const PRIORITIES = [
  { value: 0, label: "Low", tone: "neutral" as BadgeTone },
  { value: 1, label: "Normal", tone: "info" as BadgeTone },
  { value: 2, label: "High", tone: "warning" as BadgeTone },
  { value: 3, label: "Urgent", tone: "danger" as BadgeTone },
] as const;

const SORT_OPTIONS = [
  { value: "createdAt", label: "Added" },
  { value: "updatedAt", label: "Modified" },
  { value: "startAt", label: "Start" },
  { value: "dueAt", label: "Deadline" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
  { value: "status", label: "Status" },
] as const;

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "done", label: "Done" },
] as const;

function priorityMeta(priority: number) {
  return PRIORITIES.find((entry) => entry.value === priority) ?? PRIORITIES[1]!;
}

function isOverdue(task: Task): boolean {
  return task.status !== "done" && task.due_at !== null && new Date(task.due_at).getTime() < Date.now();
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
}: {
  task: Task | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<TaskEditorState>(() =>
    task ? editorStateFromTask(task) : emptyEditorState(),
  );
  const set = <K extends keyof TaskEditorState>(key: K, value: TaskEditorState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = useMutation(async () => {
    const base: Record<string, unknown> = {
      title: form.title.trim(),
      description: form.description.trim() === "" ? null : form.description.trim(),
      startAt: fromLocalInputValue(form.startAt),
      dueAt: fromLocalInputValue(form.dueAt),
      priority: form.priority,
    };
    const body = task ? { ...base, status: form.status } : base;
    if (task) {
      await api(`/api/apps/tasks/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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
        title={task ? "Edit Task" : "New Task"}
        icon="tasks"
        className="px-dialog px-dialog--form"
        data-testid="task-editor"
      >
        <form className="px-form" onSubmit={submit} aria-label={task ? "Edit task" : "Create task"}>
          <label className="px-form__row">
            <span className="px-form__label">Title</span>
            <PixelInput
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              aria-label="Task title"
              required
              autoFocus
            />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">Description</span>
            <textarea
              className="px-textarea"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              aria-label="Task description"
            />
          </label>
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">Status</span>
              <select
                className="px-select"
                value={form.status}
                onChange={(e) => set("status", e.target.value)}
                aria-label="Status"
              >
                <option value="todo">Todo</option>
                <option value="done">Done</option>
              </select>
            </label>
            <label className="px-form__row">
              <span className="px-form__label">Priority</span>
              <select
                className="px-select"
                value={form.priority}
                onChange={(e) => set("priority", Number(e.target.value))}
                aria-label="Priority"
              >
                {PRIORITIES.map((priority) => (
                  <option key={priority.value} value={priority.value}>
                    {priority.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">Start</span>
              <PixelInput
                type="datetime-local"
                value={form.startAt}
                onChange={(e) => set("startAt", e.target.value)}
                aria-label="Start time"
              />
            </label>
            <label className="px-form__row">
              <span className="px-form__label">Deadline</span>
              <PixelInput
                type="datetime-local"
                value={form.dueAt}
                onChange={(e) => set("dueAt", e.target.value)}
                aria-label="Deadline"
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
              Cancel
            </PixelButton>
            <PixelButton type="submit" size="sm" disabled={!form.title.trim() || save.busy}>
              {save.busy ? "Saving…" : task ? "Save changes" : "Create task"}
            </PixelButton>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}

function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [reloadKey, setReloadKey] = useState(0);
  const [editorFor, setEditorFor] = useState<Task | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Task | null>(null);

  const refresh = () => setReloadKey((key) => key + 1);
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
    [searchParams.toString(), reloadKey],
  );

  const setStatus = async (task: Task, status: string) => {
    try {
      await api(`/api/apps/tasks/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      refresh();
    } catch {
      refresh();
    }
  };

  const remove = useMutation(async () => {
    if (!deleting) return;
    await api(`/api/apps/tasks/tasks/${deleting.id}`, { method: "DELETE" });
  });

  const items = tasks.data?.items ?? [];
  const hasFilters = Boolean(tasksQueryString(searchParams));

  return (
    <div className="page" data-app="tasks">
      <header className="page-header">
        <h1 className="page-header__title">Tasks</h1>
        <p className="page-header__subtitle">Personal task manager</p>
        <div className="page-header__actions">
          <PixelButton size="sm" onClick={() => setEditorFor(null)}>
            <PixelIcon name="plus" /> New Task
          </PixelButton>
        </div>
      </header>

      <PixelWindow title="Filters" icon="search" className="assets-filters">
        <div className="assets-filters__row">
          <div className="assets-search">
            <PixelIcon name="search" />
            <PixelInput
              placeholder="Search tasks…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Search tasks"
            />
          </div>
          <div className="px-seg" role="group" aria-label="Filter tasks by status">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className="px-seg__btn"
                aria-pressed={statusFilter === filter.value}
                onClick={() => setParam("status", filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <select
            className="px-select"
            value={searchParams.get("priority") ?? ""}
            onChange={(e) => setParam("priority", e.target.value)}
            aria-label="Filter by priority"
          >
            <option value="">All priorities</option>
            {PRIORITIES.map((priority) => (
              <option key={priority.value} value={priority.value}>
                {priority.label}
              </option>
            ))}
          </select>
        </div>
        <div className="assets-filters__row">
          <label className="assets-filters__date">
            <span>Due from</span>
            <PixelInput
              type="date"
              value={searchParams.get("dueAfter")?.slice(0, 10) ?? ""}
              onChange={(e) =>
                setParam("dueAfter", e.target.value ? new Date(`${e.target.value}T00:00`).toISOString() : "")
              }
              aria-label="Due after"
            />
          </label>
          <label className="assets-filters__date">
            <span>to</span>
            <PixelInput
              type="date"
              value={searchParams.get("dueBefore")?.slice(0, 10) ?? ""}
              onChange={(e) =>
                setParam("dueBefore", e.target.value ? new Date(`${e.target.value}T23:59`).toISOString() : "")
              }
              aria-label="Due before"
            />
          </label>
          <select
            className="px-select"
            value={sortBy}
            onChange={(e) => setParam("sortBy", e.target.value)}
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                Sort: {option.label}
              </option>
            ))}
          </select>
          <PixelButton
            size="sm"
            variant="secondary"
            onClick={() => setParam("order", order === "asc" ? "desc" : "asc")}
            aria-label={`Sort order: ${order}. Click to switch.`}
          >
            <PixelIcon name={order === "asc" ? "up" : "down"} />
            {order === "asc" ? "Asc" : "Desc"}
          </PixelButton>
        </div>
      </PixelWindow>

      {tasks.loading ? (
        <LoadingState label="Loading tasks…" />
      ) : tasks.error ? (
        <StatusMessage tone="error">
          <p>{tasks.error}</p>
          <PixelButton size="sm" variant="secondary" onClick={tasks.reload}>
            Retry
          </PixelButton>
        </StatusMessage>
      ) : items.length === 0 && !hasFilters ? (
        <EmptyState
          icon="tasks"
          title="No tasks yet"
          description="Create your first task to start tracking your work."
          action={
            <PixelButton size="sm" onClick={() => setEditorFor(null)}>
              <PixelIcon name="plus" /> New Task
            </PixelButton>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState icon="search" title="No matching tasks" description="Switch the filters to see other tasks." />
      ) : (
        <PixelWindow title="Task Log" icon="tasks" className="task-window">
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
                    aria-label={done ? `Mark "${task.title}" as todo` : `Mark "${task.title}" as done`}
                  />
                  <span className="task__body">
                    <span className="task__title">{task.title}</span>
                    <span className="task__meta">
                      <PixelBadge tone={priority.tone}>{priority.label}</PixelBadge>
                      {task.start_at ? (
                        <PixelBadge tone="neutral">Start {formatDateTime(task.start_at)}</PixelBadge>
                      ) : null}
                      {task.due_at ? (
                        <PixelBadge tone={isOverdue(task) ? "danger" : "neutral"}>
                          Due {formatDateTime(task.due_at)}
                        </PixelBadge>
                      ) : null}
                      {done ? <PixelBadge tone="success">Done</PixelBadge> : null}
                    </span>
                  </span>
                  <span className="task__side">
                    <PixelButton
                      variant="ghost"
                      size="sm"
                      className="px-button--icon"
                      aria-label={`Edit task "${task.title}"`}
                      onClick={() => setEditorFor(task)}
                    >
                      <PixelIcon name="edit" />
                    </PixelButton>
                    <PixelButton
                      variant="ghost"
                      size="sm"
                      className="px-button--icon task__delete"
                      aria-label={`Delete task "${task.title}"`}
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
          task={editorFor}
          onClose={() => setEditorFor(undefined)}
          onSaved={() => {
            setEditorFor(undefined);
            refresh();
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete task"
          message={`Delete "${deleting.title}"? This cannot be undone.`}
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

function TasksTodayWidget() {
  const summary = useAsync(() => api<{ today: number; overdue: number; done: number }>("/api/apps/tasks/summary"));
  if (summary.loading) return <LoadingState label="Loading…" />;
  if (summary.error) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{summary.error}</p>
        </StatusMessage>
        <PixelButton size="sm" variant="secondary" onClick={summary.reload}>
          Retry
        </PixelButton>
      </div>
    );
  }
  const data = summary.data ?? { today: 0, overdue: 0, done: 0 };
  return (
    <div className="px-stats">
      <div className="px-stat">
        <span className="px-stat__label">Today</span>
        <span className="px-stat__value">{pad(data.today)}</span>
      </div>
      <div className="px-stat px-stat--danger">
        <span className="px-stat__label">Overdue</span>
        <span className="px-stat__value">{pad(data.overdue)}</span>
      </div>
      <div className="px-stat px-stat--success">
        <span className="px-stat__label">Done</span>
        <span className="px-stat__value">{data.done}</span>
      </div>
    </div>
  );
}

const app: FrontendAppModule = {
  id: "tasks",
  routes: [{ path: "", label: "Tasks", element: <TasksPage /> }],
  widgets: [{ id: "today", title: "Tasks Today", render: () => <TasksTodayWidget /> }],
};

export default app;
