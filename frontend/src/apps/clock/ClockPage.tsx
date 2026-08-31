import { useState } from "react";
import { useAppDisplayName } from "../../shared/PresentationContext";
import { useAsync } from "../../shared/useAsync";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { AlarmSection } from "./AlarmSection";
import { ClockFace } from "./ClockWidget";
import { TaskStatusSection } from "./TaskStatusSection";
import { WorldClockSection } from "./WorldClockSection";
import { fetchTasksPublicStatus } from "./tasksPublic";
import { useClockNow } from "./useClockNow";
import type { ClockSettings } from "./useClockSettings";
import { useClockSettings } from "./useClockSettings";

/**
 * Clock app page: a bigger Main Clock plus the Task Status, Alarm and World
 * Clock zones. The faces and controls read/write the same settings row as the
 * dashboard card, so display mode / 12-24h / seconds are shared state.
 */
export function ClockPage() {
  const displayName = useAppDisplayName({ id: "clock", name: "Clock" });
  const [saveFailed, setSaveFailed] = useState(false);
  const { settings, loading, error, reload, save } = useClockSettings();
  const minuteNow = useClockNow(false);
  // One shared public-status fetch: it feeds both the face focus state and
  // the Task Status zone, and re-runs each minute so next→current transitions
  // happen without user action.
  const status = useAsync(() => fetchTasksPublicStatus(), [minuteNow.getMinutes()]);
  const current = status.data?.current ?? null;
  const focus = current ? { title: current.title, startedAt: current.startAt } : null;
  const faceNow = useClockNow(settings.showSeconds || focus !== null);

  if (loading) {
    return (
      <div className="page" data-app="clock">
        <LoadingState label="Loading clock…" />
      </div>
    );
  }

  const patch = (partial: Partial<ClockSettings>) => {
    void save({ ...settings, ...partial }).then((ok) => setSaveFailed(!ok));
  };

  return (
    <div className="page" data-app="clock">
      <header className="page-header">
        <div>
          <h1 className="page-header__title">{displayName}</h1>
          <p className="page-header__subtitle">Clock faces, alarms, world clocks and task status</p>
        </div>
      </header>

      <div className="clock-page__grid">
        <PixelWindow title="Main Clock" icon="clock" className="clock-page__main">
          {error ? (
            <StatusMessage tone="warning">
              <p>Settings could not be loaded — showing defaults. {error}</p>
            </StatusMessage>
          ) : null}
          {saveFailed ? (
            <StatusMessage tone="warning">
              <p>Settings could not be saved — check the connection and try again.</p>
            </StatusMessage>
          ) : null}
          <div className="clock-page__face">
            <ClockFace now={faceNow} settings={settings} variant="page" focus={focus} />
          </div>
          <div className="clock-controls">
            <div className="px-seg" role="group" aria-label="Display mode">
              <button
                type="button"
                className="px-seg__btn"
                aria-pressed={settings.displayMode === "digital"}
                onClick={() => patch({ displayMode: "digital" })}
              >
                DIGITAL
              </button>
              <button
                type="button"
                className="px-seg__btn"
                aria-pressed={settings.displayMode === "analog"}
                onClick={() => patch({ displayMode: "analog" })}
              >
                ANALOG
              </button>
            </div>
            <div className="px-seg" role="group" aria-label="Hour format">
              <button
                type="button"
                className="px-seg__btn"
                aria-pressed={settings.hourFormat === 24}
                onClick={() => patch({ hourFormat: 24 })}
              >
                24H
              </button>
              <button
                type="button"
                className="px-seg__btn"
                aria-pressed={settings.hourFormat === 12}
                onClick={() => patch({ hourFormat: 12 })}
              >
                12H
              </button>
            </div>
            <label className="clock-controls__check">
              <input
                type="checkbox"
                className="px-checkbox"
                checked={settings.showSeconds}
                onChange={(event) => patch({ showSeconds: event.target.checked })}
              />
              Seconds
            </label>
            <label className="clock-controls__check">
              <input
                type="checkbox"
                className="px-checkbox"
                checked={settings.showDate}
                onChange={(event) => patch({ showDate: event.target.checked })}
              />
              Date
            </label>
          </div>
        </PixelWindow>

        <PixelWindow title="Task Status" icon="tasks" className="clock-page__tasks">
          <TaskStatusSection now={minuteNow} status={status} />
        </PixelWindow>

        <PixelWindow title="Alarms" icon="clock" className="clock-page__alarms">
          <AlarmSection />
        </PixelWindow>

        <PixelWindow title="World Clock" icon="clock" className="clock-page__world">
          <WorldClockSection now={minuteNow} />
        </PixelWindow>
      </div>
    </div>
  );
}
