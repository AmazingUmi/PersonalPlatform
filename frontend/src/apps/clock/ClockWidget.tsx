import { AnalogClock } from "./AnalogClock";
import { DigitalClock, type ClockFocusState } from "./DigitalClock";
import { useClockNow } from "./useClockNow";
import { useClockSettings, type ClockSettings } from "./useClockSettings";
import { fetchTasksPublicStatus } from "./tasksPublic";
import { useAsync } from "../../shared/useAsync";
import { LoadingState } from "../../shared/ui/LoadingState";
import { StatusMessage } from "../../shared/ui/StatusMessage";

/** Shared face rendering for the card and the page (same settings row). */
export function ClockFace({
  now,
  settings,
  variant,
  focus,
}: {
  now: Date;
  settings: ClockSettings;
  variant: "card" | "page";
  focus: ClockFocusState | null;
}) {
  return settings.displayMode === "analog" ? (
    <AnalogClock now={now} settings={settings} variant={variant} focus={focus} />
  ) : (
    <DigitalClock now={now} settings={settings} variant={variant} focus={focus} />
  );
}

/** Derives the Active/Focus state from the Tasks public status fetch. */
export function useTaskFocus(minute: number): { focus: ClockFocusState | null } {
  const status = useAsync(() => fetchTasksPublicStatus(), [minute]);
  const current = status.data?.current ?? null;
  return {
    focus: current ? { title: current.title, startedAt: current.startAt } : null,
  };
}

/**
 * Dashboard clock card. Fetches the same settings row as the app page (one
 * source of truth — toggling here syncs everywhere), renders the current face
 * and switches to a second-level tick only when seconds are visible or a
 * task is running. The mode buttons are native <button>s, so Dashboard's
 * isInteractiveTarget keeps control presses from navigating the card.
 */
export function ClockWidget() {
  const { settings, loading, error, reload, save } = useClockSettings();
  const minuteNow = useClockNow(false);
  const { focus } = useTaskFocus(minuteNow.getMinutes());
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
    <div className="clock-card">
      <ClockFace now={faceNow} settings={settings} variant="card" focus={focus} />
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
    </div>
  );
}
