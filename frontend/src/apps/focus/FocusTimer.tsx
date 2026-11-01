import { useI18n } from "../../shared/i18n";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { formatDuration, kindLabel, type FocusState, type SessionKind } from "./api";
import type { FocusAction } from "./useFocusState";

/** Duration (seconds) a fresh session of `kind` runs with the current settings. */
function plannedForKind(state: FocusState, kind: SessionKind): number {
  const { settings } = state;
  if (kind === "short_break") return settings.shortBreakDurationSeconds;
  if (kind === "long_break") return settings.longBreakDurationSeconds;
  return settings.focusDurationSeconds;
}

/** Header badge while a session is open (guide §16: text carries the state). */
function activeBadgeLabel(kind: SessionKind, paused: boolean, language: string): string {
  if (paused) return language === "zh" ? "已暂停" : "PAUSED";
  if (kind === "focus") return language === "zh" ? "专注中" : "FOCUSING";
  if (kind === "short_break") return language === "zh" ? "短休息" : "SHORT BREAK";
  return language === "zh" ? "长休息" : "LONG BREAK";
}

/**
 * UI hint for the stage that follows. From idle the server's `nextKind` is
 * authoritative; during a session this applies the standard pomodoro rule
 * (long break every N-th completed round) — the server decides for real when
 * the session ends.
 */
function nextStageLabel(state: FocusState, language: string): string {
  const active = state.active;
  if (!active) return kindLabel(state.nextKind, language);
  if (active.kind !== "focus") return kindLabel("focus", language);
  const roundsAfterThis = state.today.completedRounds + 1;
  return kindLabel(
    roundsAfterThis % state.settings.longBreakInterval === 0 ? "long_break" : "short_break", language,
  );
}

export interface FocusTimerProps {
  state: FocusState;
  remainingSeconds: number;
  busy: boolean;
  error: string | null;
  dispatch: (action: FocusAction, kind?: SessionKind) => Promise<void>;
}

/** Timer zone (APP-1 F07): big clock, progress bar, transport controls. */
export function FocusTimer({ state, remainingSeconds, busy, error, dispatch }: FocusTimerProps) {
  const { t, language } = useI18n();
  const active = state.active;
  const paused = active?.status === "paused";
  const planned = active ? active.plannedDurationSeconds : plannedForKind(state, state.nextKind);
  const remaining = active ? remainingSeconds : planned;
  // Live for running sessions (derived from expectedEndAt upstream), frozen
  // while paused — identical to how `remainingSeconds` itself behaves.
  const elapsed = Math.min(planned, Math.max(0, planned - remaining));
  const percent = planned > 0 ? Math.round((elapsed / planned) * 100) : 0;

  return (
    <PixelWindow title={t("Timer", "计时器")} icon="eye" className="focus-window">
      <div className="focus-timer">
        {error ? (
          <StatusMessage tone="error">
            <p>{error}</p>
          </StatusMessage>
        ) : null}

        {active ? (
          <div className="focus-timer__badges">
            <PixelBadge tone={paused ? "warning" : active.kind === "focus" ? "info" : "success"}>
              {activeBadgeLabel(active.kind, paused, language)}
            </PixelBadge>
          </div>
        ) : (
          <div className="focus-timer__badges">
            <PixelBadge tone="neutral">{kindLabel(state.nextKind, language)}</PixelBadge>
            <PixelBadge tone="success">{t("READY", "就绪")}</PixelBadge>
          </div>
        )}

        <div
          className={active ? "focus-clock" : "focus-clock focus-clock--idle"}
          role="timer"
          aria-label={active ? t("Time remaining", "剩余时间") : t(`Next session length (${kindLabel(state.nextKind, language)})`, `下一阶段时长（${kindLabel(state.nextKind, language)}）`)}
        >
          {formatDuration(remaining)}
        </div>

        <div
          className="focus-progress"
          role="progressbar"
          aria-label={t("Session progress", "当前进度")}
          aria-valuemin={0}
          aria-valuemax={planned}
          aria-valuenow={elapsed}
        >
          <div className="focus-progress__fill" style={{ width: `${percent}%` }} />
        </div>

        <div className="focus-controls">
          {!active ? (
            <PixelButton variant="primary" disabled={busy} onClick={() => void dispatch("start", state.nextKind)}>
              {t("START", "开始")}
            </PixelButton>
          ) : paused ? (
            <PixelButton variant="primary" disabled={busy} onClick={() => void dispatch("resume")}>
              {t("RESUME", "继续")}
            </PixelButton>
          ) : (
            <PixelButton variant="secondary" disabled={busy} onClick={() => void dispatch("pause")}>
              {t("PAUSE", "暂停")}
            </PixelButton>
          )}
          {active ? (
            <PixelButton variant="danger" disabled={busy} onClick={() => void dispatch("stop")}>
              {t("STOP", "停止")}
            </PixelButton>
          ) : null}
        </div>

        <p className="focus-next">{t("Next:", "下一阶段：")} {nextStageLabel(state, language)}</p>
      </div>
    </PixelWindow>
  );
}
