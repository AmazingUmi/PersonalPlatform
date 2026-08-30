/**
 * Focus Timer state machine (APP-1 F02) — pure, dependency-free logic.
 *
 * This module owns every timer formula in the app: derived elapsed/remaining
 * time, expected end, pause/resume/stop/natural-completion transitions, the
 * focus→break schedule and settings validation. It deliberately imports
 * nothing (no DB, no Fastify, no core) so it can be exhaustively unit-tested
 * and reused verbatim by the focus repository layer.
 *
 * Time model (APP-1): seconds accrue only while `status === "running"`.
 * `elapsedBeforePauseSeconds` freezes the accumulated total at the last pause;
 * `lastResumedAt` marks the start of the current running segment. Elapsed
 * time is always DERIVED from those two fields plus `now`, never stored, so
 * a crashed or clock-skewed client can never double-count or lose seconds:
 * each pause folds the running segment into `elapsedBeforePauseSeconds`
 * using floor() to whole seconds (the UI countdown tick granularity).
 */

export type SessionKind = "focus" | "short_break" | "long_break";

export type SessionStatus = "running" | "paused" | "completed" | "cancelled";

export type EndReason = "natural" | "manual_stop";

/** DB row shape; the repository persists/reads it, the timer only computes on it. */
export interface SessionRow {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  plannedDurationSeconds: number;
  /** Accumulated seconds frozen at the last pause; always ≤ plannedDurationSeconds. */
  elapsedBeforePauseSeconds: number;
  startedAt: Date;
  /** Start of the current running segment; null while paused. */
  lastResumedAt: Date | null;
  pausedAt: Date | null;
  endedAt: Date | null;
  endReason: EndReason | null;
  actualDurationSeconds: number | null;
  /** Optimistic-concurrency version, bumped on every transition. */
  revision: number;
}

/** Thrown when a transition or view mapping is requested in a state that forbids it. */
export class TimerStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimerStateError";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Whole seconds between two instants, floored (a 1500ms segment counts as 1s). */
function floorSecondsBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 1000);
}

export function elapsedSeconds(row: SessionRow, now: Date): number {
  switch (row.status) {
    case "running": {
      // Defensive: a running row without a segment start cannot accrue more time.
      if (row.lastResumedAt === null) return row.elapsedBeforePauseSeconds;
      return clamp(
        row.elapsedBeforePauseSeconds + floorSecondsBetween(row.lastResumedAt, now),
        0,
        row.plannedDurationSeconds,
      );
    }
    case "paused":
      return row.elapsedBeforePauseSeconds;
    default:
      return row.actualDurationSeconds ?? 0;
  }
}

export function remainingSeconds(row: SessionRow, now: Date): number {
  switch (row.status) {
    case "running":
      return Math.max(0, row.plannedDurationSeconds - elapsedSeconds(row, now));
    case "paused":
      return row.plannedDurationSeconds - row.elapsedBeforePauseSeconds;
    default:
      return 0;
  }
}

/** When a running session hits its planned end; null unless currently running. */
export function expectedEndAt(row: SessionRow): Date | null {
  if (row.status !== "running" || row.lastResumedAt === null) return null;
  const secondsLeft = row.plannedDurationSeconds - row.elapsedBeforePauseSeconds;
  return new Date(row.lastResumedAt.getTime() + secondsLeft * 1000);
}

/** True exactly at the planned end instant (inclusive) or later. */
export function isExpired(row: SessionRow, now: Date): boolean {
  const end = expectedEndAt(row);
  return row.status === "running" && end !== null && now.getTime() >= end.getTime();
}

/** Caller guarantees `running`. Freezes the running segment into elapsedBeforePause. */
export function applyPause(row: SessionRow, now: Date): SessionRow {
  if (row.status !== "running") {
    throw new TimerStateError(`applyPause requires a running session (id=${row.id}, status=${row.status})`);
  }
  const segmentSeconds =
    row.lastResumedAt === null ? 0 : floorSecondsBetween(row.lastResumedAt, now);
  return {
    ...row,
    status: "paused",
    elapsedBeforePauseSeconds: clamp(
      row.elapsedBeforePauseSeconds + segmentSeconds,
      0,
      row.plannedDurationSeconds,
    ),
    lastResumedAt: null,
    pausedAt: new Date(now.getTime()),
    revision: row.revision + 1,
  };
}

/** Caller guarantees `paused`. Starts a new running segment at `now`. */
export function applyResume(row: SessionRow, now: Date): SessionRow {
  if (row.status !== "paused") {
    throw new TimerStateError(`applyResume requires a paused session (id=${row.id}, status=${row.status})`);
  }
  return {
    ...row,
    status: "running",
    lastResumedAt: new Date(now.getTime()),
    // pausedAt is preserved as the historical record of the last pause.
    revision: row.revision + 1,
  };
}

/** Caller guarantees running or paused. Manual stop: actual is the elapsed total at `now`. */
export function applyStop(row: SessionRow, now: Date): SessionRow {
  if (row.status !== "running" && row.status !== "paused") {
    throw new TimerStateError(`applyStop requires an active session (id=${row.id}, status=${row.status})`);
  }
  return {
    ...row,
    status: "cancelled",
    endReason: "manual_stop",
    actualDurationSeconds: clamp(elapsedSeconds(row, now), 0, row.plannedDurationSeconds),
    endedAt: new Date(now.getTime()),
    revision: row.revision + 1,
  };
}

/**
 * Caller guarantees `isExpired(row, now)`. The session ended when its time ran
 * out — `endedAt` is `expectedEndAt(row)`, NOT `now` (which may be much later,
 * e.g. the app was asleep at the expiry instant).
 */
export function applyNaturalComplete(row: SessionRow, now: Date): SessionRow {
  const endedAt = expectedEndAt(row);
  if (row.status !== "running" || endedAt === null || now.getTime() < endedAt.getTime()) {
    throw new TimerStateError(
      `applyNaturalComplete requires an expired running session (id=${row.id}, status=${row.status})`,
    );
  }
  return {
    ...row,
    status: "completed",
    endReason: "natural",
    endedAt: new Date(endedAt.getTime()),
    elapsedBeforePauseSeconds: row.plannedDurationSeconds,
    actualDurationSeconds: row.plannedDurationSeconds,
    lastResumedAt: null,
    revision: row.revision + 1,
  };
}

/**
 * Kind of the session that follows a completed one: every focus session is
 * followed by a break; every `longBreakInterval`-th focus session (the one
 * that brings the counter to `interval`) is followed by the long break.
 */
export function nextKind(completedFocusSinceLongBreak: number, longBreakInterval: number): SessionKind {
  if (completedFocusSinceLongBreak <= 0) return "focus";
  return completedFocusSinceLongBreak >= longBreakInterval ? "long_break" : "short_break";
}

/** "mm:ss" under an hour (mm always two digits); "h:mm:ss" from one hour up. */
export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Calendar day of `date` in `timeZone`, as "YYYY-MM-DD" (en-CA layout).
 * Bucket key for stats queries; `timeZone` must be a valid IANA name.
 */
export function localDateString(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** API response shape for an ACTIVE session (terminal rows are history, not live state). */
export interface SessionView {
  id: string;
  kind: SessionKind;
  status: "running" | "paused";
  plannedDurationSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  /** ISO; null when paused (no predictable end) and for terminal rows. */
  expectedEndAt: string | null;
  startedAt: string;
  pausedAt: string | null;
  revision: number;
}

export function toSessionView(row: SessionRow, now: Date): SessionView {
  if (row.status !== "running" && row.status !== "paused") {
    throw new TimerStateError(
      `toSessionView only maps active sessions (id=${row.id}, status=${row.status})`,
    );
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    plannedDurationSeconds: row.plannedDurationSeconds,
    elapsedSeconds: elapsedSeconds(row, now),
    remainingSeconds: remainingSeconds(row, now),
    expectedEndAt: expectedEndAt(row)?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
    pausedAt: row.pausedAt?.toISOString() ?? null,
    revision: row.revision,
  };
}

export interface SettingsView {
  focusDurationSeconds: number;
  shortBreakDurationSeconds: number;
  longBreakDurationSeconds: number;
  longBreakInterval: number;
}

export const DEFAULT_SETTINGS: SettingsView = {
  focusDurationSeconds: 1500,
  shortBreakDurationSeconds: 300,
  longBreakDurationSeconds: 900,
  longBreakInterval: 4,
};

/** Inclusive bounds for every settings field (repository/AJV reuse). */
export const SETTINGS_LIMITS = {
  focusDurationSeconds: { min: 1, max: 86_400 },
  shortBreakDurationSeconds: { min: 1, max: 86_400 },
  longBreakDurationSeconds: { min: 1, max: 86_400 },
  longBreakInterval: { min: 2, max: 10 },
} as const satisfies Record<string, { readonly min: number; readonly max: number }>;

function isIntegerInRange(
  value: unknown,
  range: { readonly min: number; readonly max: number },
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

/**
 * Full validation of the four settings fields. Any missing field, non-integer
 * or out-of-bounds value yields null (the caller then falls back to the
 * defaults). Unknown extra fields are stripped.
 */
export function sanitizeSettings(input: unknown): SettingsView | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as Record<string, unknown>;
  if (!isIntegerInRange(candidate.focusDurationSeconds, SETTINGS_LIMITS.focusDurationSeconds)) return null;
  if (!isIntegerInRange(candidate.shortBreakDurationSeconds, SETTINGS_LIMITS.shortBreakDurationSeconds)) {
    return null;
  }
  if (!isIntegerInRange(candidate.longBreakDurationSeconds, SETTINGS_LIMITS.longBreakDurationSeconds)) {
    return null;
  }
  if (!isIntegerInRange(candidate.longBreakInterval, SETTINGS_LIMITS.longBreakInterval)) return null;
  return {
    focusDurationSeconds: candidate.focusDurationSeconds,
    shortBreakDurationSeconds: candidate.shortBreakDurationSeconds,
    longBreakDurationSeconds: candidate.longBreakDurationSeconds,
    longBreakInterval: candidate.longBreakInterval,
  };
}
