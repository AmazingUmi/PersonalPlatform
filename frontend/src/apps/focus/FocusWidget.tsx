import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelButton } from "../../shared/ui/PixelButton";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { formatDuration, kindLabel, type FocusSettings, type SessionKind } from "./api";
import { useFocusState } from "./useFocusState";

/** Compact human label for the daily summary: "1h 30m" / "30m" / "45s". */
function secondsToHumanLabel(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${total}s`;
}

/** Frozen contract defaults (APP-1 F04) for the pre-first-load edge case. */
const FALLBACK_SETTINGS: FocusSettings = {
  focusDurationSeconds: 1500,
  shortBreakDurationSeconds: 300,
  longBreakDurationSeconds: 900,
  longBreakInterval: 4,
};

/** Planned length of a not-yet-started session of `kind` (idle preview). */
function defaultSecondsFor(kind: SessionKind, settings: FocusSettings): number {
  switch (kind) {
    case "focus":
      return settings.focusDurationSeconds;
    case "short_break":
      return settings.shortBreakDurationSeconds;
    case "long_break":
      return settings.longBreakDurationSeconds;
  }
}

/**
 * Compact Focus dashboard widget (APP-1 F08a): state line, big countdown,
 * today summary, inline controls. All data comes from useFocusState (its
 * BroadcastChannel + visibility-gated poll keeps widget, /focus page and
 * other tabs coherent). Every interactive element is a native <button>
 * (PixelButton), so Dashboard's isInteractiveTarget swallows the clicks and
 * the surrounding card never navigates on a control press.
 */
export function FocusWidget() {
  const { state, loading, error, busy, remainingSeconds, dispatch } = useFocusState();
  if (loading) return <LoadingState label="Loading…" />;

  const active = state?.active ?? null;
  const nextKind = state?.nextKind ?? "focus";
  const settings = state?.settings ?? FALLBACK_SETTINGS;
  const today = state?.today ?? { focusedSeconds: 0, completedRounds: 0, sessionsEnded: 0 };
  const kind = active?.kind ?? nextKind;

  const stateLabel = active === null ? "READY" : active.status === "running" ? "FOCUSING" : "PAUSED";
  const time =
    active === null
      ? formatDuration(defaultSecondsFor(kind, settings))
      : active.status === "running"
        ? formatDuration(remainingSeconds)
        : formatDuration(active.remainingSeconds);

  return (
    <div>
      <div className="focus-widget__state">
        {stateLabel} · {kindLabel(kind)}
      </div>
      <div className="focus-widget__time">{time}</div>
      <div className="focus-widget__meta">
        Focused {secondsToHumanLabel(today.focusedSeconds)} · {today.completedRounds} rounds
      </div>
      {error !== null ? (
        <StatusMessage tone="error">
          <p>{error}</p>
        </StatusMessage>
      ) : null}
      <div className="focus-widget__controls">
        {active === null ? (
          <PixelButton
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void dispatch("start", nextKind)}
          >
            Start
          </PixelButton>
        ) : active.status === "running" ? (
          <>
            <PixelButton size="sm" variant="secondary" disabled={busy} onClick={() => void dispatch("pause")}>
              Pause
            </PixelButton>
            <PixelButton size="sm" variant="danger" disabled={busy} onClick={() => void dispatch("stop")}>
              Stop
            </PixelButton>
          </>
        ) : (
          <>
            <PixelButton size="sm" variant="primary" disabled={busy} onClick={() => void dispatch("resume")}>
              Resume
            </PixelButton>
            <PixelButton size="sm" variant="danger" disabled={busy} onClick={() => void dispatch("stop")}>
              Stop
            </PixelButton>
          </>
        )}
      </div>
    </div>
  );
}
