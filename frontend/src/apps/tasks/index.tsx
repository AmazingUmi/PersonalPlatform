import { useState } from "react";
import { api } from "../../shared/api";
import type { FrontendAppModule } from "../../shared/appTypes";
import { useAsync } from "../../shared/useAsync";

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_at: string | null;
  completed_at: string | null;
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

  return (
    <div className="page">
      <h1>Tasks</h1>
      <form onSubmit={createTask} className="inline-form">
        <input placeholder="New task" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
        <option value="">All</option>
        <option value="todo">Todo</option>
        <option value="done">Done</option>
      </select>

      {tasks.loading ? (
        <p className="muted">Loading…</p>
      ) : tasks.error ? (
        <p className="error-text">{tasks.error}</p>
      ) : (
        <ul className="item-list">
          {(tasks.data?.items ?? []).map((task) => (
            <li key={task.id} className={task.status === "done" ? "task task--done" : "task"}>
              <input
                type="checkbox"
                checked={task.status === "done"}
                onChange={() => void setStatus(task, task.status === "done" ? "todo" : "done")}
              />
              <span>{task.title}</span>
              {task.due_at && <span className="muted">due {new Date(task.due_at).toLocaleDateString()}</span>}
              <button type="button" onClick={() => void remove(task)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TasksTodayWidget() {
  const summary = useAsync(() => api<{ today: number; overdue: number; done: number }>("/api/apps/tasks/summary"));
  if (summary.loading) return <p className="muted">Loading…</p>;
  if (summary.error) return <p className="error-text">{summary.error}</p>;
  return (
    <p>
      {summary.data?.today ?? 0} due today · {summary.data?.overdue ?? 0} overdue · {summary.data?.done ?? 0} done
    </p>
  );
}

const app: FrontendAppModule = {
  id: "tasks",
  routes: [{ path: "", label: "Tasks", element: <TasksPage /> }],
  widgets: [{ id: "today", title: "Tasks Today", render: () => <TasksTodayWidget /> }],
};

export default app;
