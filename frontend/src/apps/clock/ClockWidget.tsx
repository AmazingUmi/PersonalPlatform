import type { WidgetDensity } from "../../shared/appTypes";
import { useAsync } from "../../shared/useAsync";
import { LoadingState } from "../../shared/ui/LoadingState";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { AnalogClock } from "./AnalogClock";
import { DigitalClock, focusElapsedClock, type ClockFocusState } from "./DigitalClock";
import { dateLine, humanDuration, timeParts, weekdayLabel } from "./timeMath";
import { useClockNow } from "./useClockNow";
import { useClockSettings, type ClockSettings } from "./useClockSettings";
import { fetchTasksPublicStatus, type TasksPublicStatus } from "./tasksPublic";

/** Shared face rendering for the card and the page (same settings row).
 * The wrapper carries the display-mode key so switching digital↔analog remounts
 * the face and replays the `clock-face-in` entrance (apps.css) — a pure CSS
 * mount keyframe; both faces occupy the same box so layout never shifts. */
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
  return (
    <div className="clock-face" key={settings.displayMode}>
      {settings.displayMode === "analog" ? (
        <AnalogClock now={now} settings={settings} variant={variant} focus={focus} density={density} />
      ) : (
        <DigitalClock now={now} settings={settings} variant={variant} focus={focus} density={density} />
      )}
    </div>
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

/** Hero date bar: weekday on the left, month-day on the right. */
function HeroDateBar({ now }: { now: Date }) {
  const date = dateLine(now);
  return (
    <p className="clock-hero__datebar">
      <span className="clock-hero__weekday">{weekdayLabel(now)}</span>
      <span className="clock-hero__date">
        {date.monthDay} {date.year}
      </span>
    </p>
  );
}

/**
 * The hero agenda: the single place the current task is spelled out.
 * Deduplication rule (composition pass): the task title appears exactly
 * once and the elapsed time exactly once — both here, never again in the
 * clock face. "RUNNING" is a status chip next to the CURRENT label, not a
 * repeated title line. In the wide hero the elapsed becomes the agenda's
 * sub-metric (tabular MM:SS + ELAPSED label).
 */
function HeroAgenda({
  agenda,
  focus,
  now,
  wide,
}: {
  agenda: TasksPublicStatus;
  focus: ClockFocusState | null;
  now: Date;
  wide: boolean;
}) {
  const next = agenda.next;
  const nextAt = next ? new Date(Date.parse(next.startAt)) : null;
  const nextParts = nextAt ? timeParts(nextAt) : null;
  return (
    <div className="clock-hero__agenda">
      <section className="clock-hero__current">
        <p className="clock-hero__row-label">
          CURRENT
          {focus ? (
            <span className="clock-hero__live">
              <span className="clock-hero__live-dot" aria-hidden="true" />
              RUNNING
            </span>
          ) : null}
        </p>
        <p className="clock-hero__current-title">
          {agenda.current ? agenda.current.title : "Nothing running"}
        </p>
        {focus ? (
          wide ? (
            <p className="clock-hero__elapsed">
              <span className="clock-hero__elapsed-time">{focusElapsedClock(focus, now)}</span>
              <span className="clock-hero__elapsed-label">ELAPSED</span>
            </p>
          ) : (
            <p className="clock-hero__row-eta">
              {humanDuration(now.getTime() - Date.parse(focus.startedAt))} elapsed
            </p>
          )
        ) : null}
      </section>
      <section className="clock-hero__next">
        <p className="clock-hero__row-label">NEXT</p>
        <p className="clock-hero__next-title">
          {next ? next.title : "Nothing scheduled"}
          {next && nextParts ? (
            <span className="clock-hero__row-eta">
              {" "}
              {nextParts.hours24}:{nextParts.minutes} · in{" "}
              {humanDuration(Date.parse(next.startAt) - now.getTime())}
            </span>
          ) : null}
        </p>
      </section>
    </div>
  );
}

/**
 * Dashboard clock HERO card. The clock is the dashboard's visual anchor.
 * Wide (expanded) cards compose horizontally: date bar on top, face left,
 * CURRENT/NEXT agenda right, mode toggle + remaining strip in one bottom
 * row. Narrower cards stack the same zones vertically; compact (a
 * user-resized small card) degrades to time-only. All static — no data
 * required to look composed. Fetches the same settings row as the app page
 * (one source of truth — toggling here syncs everywhere) and ticks at
 * second precision only when seconds are visible or a task is running. The
 * mode buttons are native <button>s, so Dashboard's isInteractiveTarget
 * keeps control presses from navigating the card.
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

  const compact = density === "compact";
  const wide = density === "expanded";
  const agenda = !compact ? (status.data ?? null) : null;
  const remaining = agenda ? moreTodayCount(agenda) : 0;

  return (
    <div className="clock-card clock-hero" data-density={density}>
      {!compact ? <HeroDateBar now={minuteNow} /> : null}
      <div className="clock-hero__main">
        <ClockFace now={faceNow} settings={settings} variant="card" focus={focus} density={density} />
        {agenda ? <HeroAgenda agenda={agenda} focus={focus} now={minuteNow} wide={wide} /> : null}
      </div>
      {!compact ? (
        <div className="clock-hero__bottom">
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
          <p className="clock-hero__remaining">
            {remaining > 0 ? `${remaining} MORE TASKS TODAY` : "NOTHING ELSE TODAY"}
            <span className="clock-hero__remaining-arrow" aria-hidden="true" />
          </p>
        </div>
      ) : null}
    </div>
  );
}
