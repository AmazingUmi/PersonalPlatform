import { Link } from "react-router-dom";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelButton } from "../../shared/ui/PixelButton";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import type { PublicTaskView, TasksPublicStatus } from "./tasksPublic";
import { humanDuration, timeParts } from "./timeMath";

/** Slice of useAsync state the page already owns (single shared fetch). */
export interface TaskStatusSlice {
  data: TasksPublicStatus | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Tasks status zone (Clock page). Renders the Tasks public status contract —
 * current / next / remaining-today with deep links. It deliberately does NOT
 * list upcoming tasks; the Tasks app owns that view. `now` is the parent's
 * minute tick, which refreshes the elapsed/countdown labels.
 */
export function TaskStatusSection({ now, status }: { now: Date; status: TaskStatusSlice }) {
  if (status.loading && status.data === null) return <LoadingState label="Loading tasks…" />;
  if (status.error && status.data === null) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{status.error}</p>
        </StatusMessage>
        <PixelButton size="sm" variant="secondary" onClick={status.reload}>
          Retry
        </PixelButton>
      </div>
    );
  }
  if (status.data === null) {
    return (
      <EmptyState
        icon="tasks"
        title="Tasks unavailable"
        description="The Tasks app is disabled, so there is no task status to show."
      />
    );
  }

  const { current, next, today } = status.data;
  const remaining = today.remainingCount;
  if (!current && !next && remaining === 0) {
    return (
      <EmptyState icon="tasks" title="Nothing scheduled" description="No current or upcoming tasks today." />
    );
  }

  return (
    <div className="clock-tasks">
      {current ? <CurrentTaskBlock task={current} now={now} /> : null}
      {next ? <NextTaskBlock task={next} now={now} /> : null}
      {remaining > 0 ? (
        <Link className="clock-tasks__more" to="/tasks">
          {remaining} MORE TASK{remaining === 1 ? "" : "S"} TODAY →
        </Link>
      ) : null}
    </div>
  );
}

function CurrentTaskBlock({ task, now }: { task: PublicTaskView; now: Date }) {
  const elapsed = now.getTime() - new Date(task.startAt).getTime();
  return (
    <div className="clock-tasks__block clock-tasks__block--current">
      <span className="clock-tasks__label">
        <span className="clock-tasks__live-dot" aria-hidden="true" /> CURRENT TASK
      </span>
      <Link className="clock-tasks__title" to={`/tasks/${task.id}`}>
        {task.title}
      </Link>
      <span className="clock-tasks__hint">Started {humanDuration(elapsed)} ago</span>
    </div>
  );
}

function NextTaskBlock({ task, now }: { task: PublicTaskView; now: Date }) {
  const start = new Date(task.startAt);
  const until = start.getTime() - now.getTime();
  const parts = timeParts(start);
  return (
    <div className="clock-tasks__block clock-tasks__block--next">
      <span className="clock-tasks__label">NEXT</span>
      <Link className="clock-tasks__title" to={`/tasks/${task.id}`}>
        <span className="clock-tasks__next-time">
          {parts.hours24}:{parts.minutes}
        </span>{" "}
        · {task.title}
      </Link>
      <span className="clock-tasks__hint">Starts in {humanDuration(until)}</span>
    </div>
  );
}
