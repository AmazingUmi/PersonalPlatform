import { useI18n } from "../../shared/i18n";
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
  const { t } = useI18n();
  if (status.loading && status.data === null) return <LoadingState label={t("Loading tasks…", "正在加载任务…")} />;
  if (status.error && status.data === null) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{status.error}</p>
        </StatusMessage>
        <PixelButton size="sm" variant="secondary" onClick={status.reload}>
          {t("Retry", "重试")}
        </PixelButton>
      </div>
    );
  }
  if (status.data === null) {
    return (
      <EmptyState
        icon="tasks"
        title={t("Tasks unavailable", "任务不可用")}
        description={t("The Tasks app is disabled, so there is no task status to show.", "任务应用已停用，无法显示任务状态。")}
      />
    );
  }

  const { current, next, today } = status.data;
  const remaining = today.remainingCount;
  if (!current && !next && remaining === 0) {
    return (
      <EmptyState icon="tasks" title={t("Nothing scheduled", "暂无已安排任务")} description={t("No current or upcoming tasks today.", "今天没有正在进行或待开始的任务。")} />
    );
  }

  return (
    <div className="clock-tasks">
      {current ? <CurrentTaskBlock task={current} now={now} /> : null}
      {next ? <NextTaskBlock task={next} now={now} /> : null}
      {remaining > 0 ? (
        <Link className="clock-tasks__more" to="/tasks">
          {t(`${remaining} MORE TASK${remaining === 1 ? "" : "S"} TODAY →`, `今天还有 ${remaining} 项任务 →`)}
        </Link>
      ) : null}
    </div>
  );
}

function CurrentTaskBlock({ task, now }: { task: PublicTaskView; now: Date }) {
  const { t, language } = useI18n();
  const elapsed = now.getTime() - new Date(task.startAt).getTime();
  return (
    <div className="clock-tasks__block clock-tasks__block--current">
      <span className="clock-tasks__label">
        <span className="clock-tasks__live-dot" aria-hidden="true" /> {t("CURRENT TASK", "当前任务")}
      </span>
      <Link className="clock-tasks__title" to={`/tasks/${task.id}`}>
        {task.title}
      </Link>
      <span className="clock-tasks__hint">{t(`Started ${humanDuration(elapsed)} ago`, `已开始 ${humanDuration(elapsed, language)}`)}</span>
    </div>
  );
}

function NextTaskBlock({ task, now }: { task: PublicTaskView; now: Date }) {
  const { t, language } = useI18n();
  const start = new Date(task.startAt);
  const until = start.getTime() - now.getTime();
  const parts = timeParts(start);
  return (
    <div className="clock-tasks__block clock-tasks__block--next">
      <span className="clock-tasks__label">{t("NEXT", "下一项")}</span>
      <Link className="clock-tasks__title" to={`/tasks/${task.id}`}>
        <span className="clock-tasks__next-time">
          {parts.hours24}:{parts.minutes}
        </span>{" "}
        · {task.title}
      </Link>
      <span className="clock-tasks__hint">{t("Starts in", "距离开始")} {humanDuration(until, language)}</span>
    </div>
  );
}
