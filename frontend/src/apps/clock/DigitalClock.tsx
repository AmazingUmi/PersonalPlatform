import type { ClockSettings } from "./useClockSettings";
import { dateLine, humanDuration, timeParts, weekdayLabel } from "./timeMath";

/**
 * State that puts both clock faces into Active/Focus mode: a Tasks current
 * task is running. Read-only — the Clock never mutates Tasks state.
 */
export interface ClockFocusState {
  title: string;
  startedAt: string; // ISO instant from the Tasks public API
}

export function focusElapsedMs(focus: ClockFocusState, now: Date): number {
  return Math.max(0, now.getTime() - new Date(focus.startedAt).getTime());
}

/** Compact elapsed label for the focus line: "01:24" / "1:02:05". */
export function focusElapsedClock(focus: ClockFocusState, now: Date): string {
  const totalSeconds = Math.floor(focusElapsedMs(focus, now) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours >= 1 ? `${String(hours).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface DigitalClockProps {
  now: Date;
  settings: Pick<ClockSettings, "showSeconds" | "showDate" | "hourFormat">;
  variant: "card" | "page";
  focus: ClockFocusState | null;
}

/**
 * Pixel digital clock face. Visual hierarchy (guide §Pixel): pixel-font
 * tabular digits, blinking colon, amber focus mode when a task is running.
 * The colon blink and focus dot are CSS animations — both are neutralized by
 * the global prefers-reduced-motion override.
 */
export function DigitalClock({ now, settings, variant, focus }: DigitalClockProps) {
  const parts = timeParts(now);
  const date = dateLine(now);
  const hours = settings.hourFormat === 12 ? parts.hours12 : parts.hours24;
  return (
    <div
      className={[
        "clock-digital",
        `clock-digital--${variant}`,
        focus ? "clock-digital--focus" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="timer"
      aria-label={`Current time ${hours}:${parts.minutes}${
        settings.hourFormat === 12 ? ` ${parts.meridiem}` : ""
      }`}
    >
      <div className="clock-digital__top">
        <span className="clock-digital__label">
          {focus ? <span className="clock-digital__focus-dot" aria-hidden="true" /> : null}
          {focus ? "FOCUS" : "CLOCK"}
        </span>
        <span className="clock-digital__weekday">{weekdayLabel(now)}</span>
      </div>
      <div className="clock-digital__time">
        <span className="clock-digital__digits">{hours}</span>
        <span className="clock-digital__colon" aria-hidden="true">
          :
        </span>
        <span className="clock-digital__digits">{parts.minutes}</span>
        {settings.showSeconds ? (
          <span className="clock-digital__seconds">{parts.seconds}</span>
        ) : null}
        {settings.hourFormat === 12 ? (
          <span className="clock-digital__meridiem">{parts.meridiem}</span>
        ) : null}
      </div>
      {focus ? (
        <div className="clock-digital__focus-line">
          RUNNING · {focusElapsedClock(focus, now)}
          <span className="clock-digital__focus-title"> {focus.title}</span>
        </div>
      ) : null}
      {settings.showDate ? (
        <div className="clock-digital__date">
          {date.monthDay} · {date.year}
        </div>
      ) : null}
      {focus ? (
        <span className="visually-hidden">
          Task running for {humanDuration(focusElapsedMs(focus, now))}
        </span>
      ) : null}
    </div>
  );
}
