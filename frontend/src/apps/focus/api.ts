import { api } from "../../shared/api";

/** Session kinds of the pomodoro cycle (frozen API contract, APP-1 F04). */
export type SessionKind = "focus" | "short_break" | "long_break";
export type NextKind = SessionKind;

export interface FocusSettings {
  focusDurationSeconds: number;
  shortBreakDurationSeconds: number;
  longBreakDurationSeconds: number;
  longBreakInterval: number;
}

export interface ActiveSessionView {
  id: string;
  kind: SessionKind;
  status: "running" | "paused";
  plannedDurationSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  expectedEndAt: string | null;
  startedAt: string;
  pausedAt: string | null;
  revision: number;
}

export interface FocusState {
  now: string;
  active: ActiveSessionView | null;
  today: { focusedSeconds: number; completedRounds: number; sessionsEnded: number };
  nextKind: NextKind;
  settings: FocusSettings;
}

export interface FocusHistoryItem {
  id: string;
  kind: SessionKind;
  status: "completed" | "cancelled";
  plannedDurationSeconds: number;
  actualDurationSeconds: number | null;
  startedAt: string;
  endedAt: string;
  endReason: "natural" | "manual_stop" | null;
}

export interface FocusStats {
  timezone: string;
  days: Array<{ date: string; focusedSeconds: number; completedRounds: number }>;
  totals: { focusedSeconds: number; completedRounds: number };
}

const PREFIX = "/api/apps/focus";

export function fetchFocusState(): Promise<FocusState> {
  return api<FocusState>(`${PREFIX}/state`);
}

export interface StartFocusSessionInput {
  kind: SessionKind;
  plannedDurationSeconds?: number;
  baseRevision?: number;
}

export function startFocusSession(input: StartFocusSessionInput): Promise<FocusState> {
  return postTransition("start", input);
}

function postTransition(action: string, body: unknown): Promise<FocusState> {
  return api<{ state: FocusState }>(`${PREFIX}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((envelope) => envelope.state);
}

function postSessionAction(action: "pause" | "resume" | "stop", baseRevision?: number): Promise<FocusState> {
  return postTransition(action, { baseRevision });
}

export function pauseFocusSession(baseRevision?: number): Promise<FocusState> {
  return postSessionAction("pause", baseRevision);
}

export function resumeFocusSession(baseRevision?: number): Promise<FocusState> {
  return postSessionAction("resume", baseRevision);
}

export function stopFocusSession(baseRevision?: number): Promise<FocusState> {
  return postSessionAction("stop", baseRevision);
}

export async function fetchFocusSessions({
  limit,
  offset,
}: {
  limit: number;
  offset: number;
}): Promise<{ items: FocusHistoryItem[]; total: number }> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return api<{ items: FocusHistoryItem[]; total: number }>(`${PREFIX}/sessions?${query.toString()}`);
}

export function fetchFocusStats(days: number): Promise<FocusStats> {
  const query = new URLSearchParams({ days: String(days) });
  return api<FocusStats>(`${PREFIX}/stats?${query.toString()}`);
}

/** "25:00" under one hour, "1:02:05" from one hour up. */
export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours >= 1 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function kindLabel(kind: SessionKind): string {
  switch (kind) {
    case "focus":
      return "Focus";
    case "short_break":
      return "Short Break";
    case "long_break":
      return "Long Break";
  }
}
