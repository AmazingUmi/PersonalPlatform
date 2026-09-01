import type { WidgetDensity } from "../../shared/appTypes";
import { useAsync } from "../../shared/useAsync";
import { LoadingState } from "../../shared/ui/LoadingState";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { AnalogClock } from "./AnalogClock";
import { DigitalClock, type ClockFocusState } from "./DigitalClock";
import { useClockNow } from "./useClockNow";
import { useClockSettings, type ClockSettings } from "./useClockSettings";
import { fetchTasksPublicStatus } from "./tasksPublic";

/** Shared face rendering for the card and the page (same settings row). */
export function ClockFace({
  now,
  settings,
  variant,
  focus,
  density = "normal",
}: {
  now: Date;
  settings: ClockSettings;
  variant: "card" | "page";
  focus: ClockFocusState | null;
  /** Information density from the container (dashboard resize); page = normal. */
  density?: WidgetDensity;
}) {
  return settings.displayMode === "analog" ? (
    <AnalogClock now={now} settings={settings} variant={variant} focus={focus} density={density} />
  ) : (
    <DigitalClock now={now} settings={settings} variant={variant} focus={focus} density={density} />
  );
}

/** Tasks public status for the card: focus state plus the expanded-zone facts. */
export function useTasksStatus(minute: number) {
  const status = useAsync(() => fetchTasksPublicStatus(), [minute]);
  const current = status.data?.current ?? null;
  return {
    status,
    focus: current ? { title: current.title, startedAt: current.startAt } : null,
  };
}

/** How many todo tasks are still ahead today: next (if any) + the rest. */
function moreTodayCount(status: { next: { id: string } | null; today: { remainingCount: number } }): number {
  return status.today.remainingCount + (status.next ? 1 : 0);
}

/**
 * Dashboard clock card. Fetches the same settings row as the app page (one
 * source of truth — toggling here syncs everywhere), renders the current face
 * and switches to a second-level tick only when seconds are visible or a
 * task is running. The mode buttons are native <button>s, so Dashboard's
 * isInteractiveTarget keeps control presses from navigating the card.
 * Information density follows the container's layout context: compact keeps
 * only the time, expanded adds the Tasks zone (current / next / remaining).
 */
export function ClockWidget({ density = "normal" }: { density?: WidgetDensity }) {
  const { settings, loading, error, reload, save } = useClockSettings();
  const minuteNow = useClockNow(false);
  const { status, focus } = useTasksStatus(minuteNow.getMinutes());
  const faceNow = useClockNow(settings.showSeconds || focus !== null);

  if (loading) return <LoadingState label="Loading…" />;
  if (error) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{error}</p>
        </StatusMessage>
        <button type="button" className="px-button px-button--secondary px-button--sm" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }

  const setMode = (displayMode: ClockSettings["displayMode"]) => {
    if (displayMode !== settings.displayMode) void save({ ...settings, displayMode });
  };

  return (
    <div className="clock-card" data-density={density}>
      <ClockFace now={faceNow} settings={settings} variant="card" focus={focus} density={density} />
      {density === "expanded" && status.data ? (
        <div className="clock-card__tasks">
          <p className="clock-card__task">
            <span className="clock-card__task-label">CURRENT</span>
            <span className="clock-card__task-title">{status.data.current ? status.data.current.title : "None"}</span>
          </p>
          <p className="clock-card__task">
            <span className="clock-card__task-label">NEXT</span>
            <span className="clock-card__task-title">{status.data.next ? status.data.next.title : "None"}</span>
          </p>
          <p className="clock-card__count">{moreTodayCount(status.data)} MORE TASKS TODAY</p>
        </div>
      ) : null}
      {density !== "compact" ? (
        <div className="clock-card__footer">
          <div className="px-seg" role="group" aria-label="Clock display mode">
            <button
              type="button"
              className="px-seg__btn"
              aria-pressed={settings.displayMode === "digital"}
              onClick={() => setMode("digital")}
            >
              DIGITAL
            </button>
            <button
              type="button"
              className="px-seg__btn"
              aria-pressed={settings.displayMode === "analog"}
              onClick={() => setMode("analog")}
            >
              ANALOG
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
