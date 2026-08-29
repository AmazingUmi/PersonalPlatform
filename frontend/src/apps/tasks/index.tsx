import { useState } from "react";
import { api } from "../../shared/api";
import type { FrontendAppModule } from "../../shared/appTypes";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge } from "../../shared/ui/PixelBadge";
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
  due_at: string | null;
  completed_at: string | null;
}

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "done", label: "Done" },
] as const;

function isOverdue(task: Task): boolean {
  return task.status !== "done" && task.due_at !== null && new Date(task.due_at).getTime() < Date.now();
}

function TasksPage() {
  const [title, setTitle] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const tasks = useAsync(
    () => api<{ items: Task[] }>(`/api/apps/tasks/tasks${statusFilter ? `?status=${statusFilter}` : ""}`),
    [statusFilter, reloadKey],
  );

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    await api("/api/apps/tasks/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    });
    setTitle("");
    setReloadKey((k) => k + 1);
  }

  async function setStatus(task: Task, status: string) {
    await api(`/api/apps/tasks/tasks/${task.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setReloadKey((k) => k + 1);
  }

  async function remove(task: Task) {
    await api(`/api/apps/tasks/tasks/${task.id}`, { method: "DELETE" });
    setReloadKey((k) => k + 1);
  }

  const items = tasks.data?.items ?? [];

  return (
    <div className="page" data-app="tasks">
      <header className="page-header">
        <h1 className="page-header__title">Tasks</h1>
        <p className="page-header__subtitle">Personal task manager</p>
      </header>

      <form onSubmit={createTask} className="task-form" aria-label="Add a task">
        <PixelInput
          placeholder="New task"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="New task title"
        />
        <PixelButton type="submit" disabled={!title.trim()}>
          + Add
        </PixelButton>
      </form>

      <div className="px-seg" role="group" aria-label="Filter tasks by status">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className="px-seg__btn"
            aria-pressed={statusFilter === filter.value}
            onClick={() => setStatusFilter(filter.value)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {tasks.loading ? (
        <LoadingState label="Loading tasks…" />
      ) : tasks.error ? (
        <StatusMessage tone="error">
          <p>{tasks.error}</p>
          <PixelButton size="sm" variant="secondary" onClick={tasks.reload}>
            Retry
          </PixelButton>
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          icon="tasks"
          title={statusFilter === "" ? "No tasks yet" : `No ${statusFilter} tasks`}
          description={
            statusFilter === ""
              ? "Add your first task above to start tracking your work."
              : "Switch the filter to see other tasks."
          }
        />
      ) : (
        <PixelWindow title="Task Log" icon="tasks" className="task-window">
          <ul className="task-list">
            {items.map((task) => {
              const done = task.status === "done";
              return (
                <li key={task.id} className={done ? "task task--done" : "task"}>
                  <input
                    type="checkbox"
                    className="px-checkbox"
                    checked={done}
                    onChange={() => void setStatus(task, done ? "todo" : "done")}
                    aria-label={done ? `Mark "${task.title}" as todo` : `Mark "${task.title}" as done`}
                  />
                  <span className="task__title">{task.title}</span>
                  <span className="task__side">
                    {task.due_at ? (
                      <PixelBadge tone={isOverdue(task) ? "danger" : "neutral"}>
                        Due {new Date(task.due_at).toLocaleDateString()}
                      </PixelBadge>
                    ) : null}
                    {done ? <PixelBadge tone="success">Done</PixelBadge> : null}
                    <PixelButton
                      variant="ghost"
                      size="sm"
                      className="px-button--icon task__delete"
                      aria-label={`Delete task "${task.title}"`}
                      onClick={() => void remove(task)}
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
