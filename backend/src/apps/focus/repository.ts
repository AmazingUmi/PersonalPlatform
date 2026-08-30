/**
 * Focus repository (APP-1 F03) — the ONLY module that talks to focus.* tables.
 *
 * Layer contract: pure DB read/write plus row-level atomic operations. HTTP
 * concerns, request validation and business decisions (what a transition
 * MEANS) live in index.ts; timer formulas live in timer.ts. The one composed
 * operation here, `reconcileActive`, is exactly the row-atomic "close an
 * expired session" primitive the API layer needs while the caller's
 * transaction holds the FOR UPDATE row lock.
 *
 * Every statement is schema-qualified `focus.` and parameterized ($n); the
 * only values interpolated into SQL text are validated integers that are
 * passed as parameters anyway. `Db` is derived from AppContext (never from
 * core/database) so the isolation rules hold.
 */

import type { AppContext } from "../../core/app-registry/types.js";
import {
  DEFAULT_SETTINGS,
  applyNaturalComplete,
  isExpired,
  sanitizeSettings,
  type EndReason,
  type SessionKind,
  type SessionRow,
  type SessionStatus,
  type SettingsView,
} from "./timer.js";

/** AppContext.database — plain queries or an open transaction client. */
type Db = AppContext["database"];

const SETTINGS_ID = "current";

const SESSION_COLUMNS = `id, kind, status, planned_duration_seconds, elapsed_before_pause_seconds,
  started_at, last_resumed_at, paused_at, ended_at, end_reason, actual_duration_seconds, revision`;

/** Raw pg row (snake_case); timestamptz arrives as Date via the type parsers. */
type SessionPgRow = {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  planned_duration_seconds: number;
  elapsed_before_pause_seconds: number;
  started_at: Date;
  last_resumed_at: Date | null;
  paused_at: Date | null;
  ended_at: Date | null;
  end_reason: EndReason | null;
  actual_duration_seconds: number | null;
  revision: number;
};

/** Explicit snake_case → camelCase mapping (mini_game toSave style). */
function toRow(r: SessionPgRow): SessionRow {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    plannedDurationSeconds: r.planned_duration_seconds,
    elapsedBeforePauseSeconds: r.elapsed_before_pause_seconds,
    startedAt: r.started_at,
    lastResumedAt: r.last_resumed_at,
    pausedAt: r.paused_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
    actualDurationSeconds: r.actual_duration_seconds,
    revision: r.revision,
  };
}

/** Values in SESSION_COLUMNS order — shared by both write statements. */
function toParams(row: SessionRow): unknown[] {
  return [
    row.id,
    row.kind,
    row.status,
    row.plannedDurationSeconds,
    row.elapsedBeforePauseSeconds,
    row.startedAt,
    row.lastResumedAt,
    row.pausedAt,
    row.endedAt,
    row.endReason,
    row.actualDurationSeconds,
    row.revision,
  ];
}

/** True for pg unique_violation (23505) — e.g. the one-active-session index. */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function assertIntIn(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max} (got ${value})`);
  }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * Effective settings: the stored row if present AND valid, otherwise the
 * defaults. A poisoned/stale row never reaches the caller (defensive read).
 */
export async function getSettings(db: Db): Promise<SettingsView> {
  const { rows } = await db.query<{ value: unknown }>(
    "SELECT value FROM focus.settings WHERE id = $1",
    [SETTINGS_ID],
  );
  return sanitizeSettings(rows[0]?.value) ?? DEFAULT_SETTINGS;
}

/**
 * Overwrite the stored settings. `next` must already be validated by the
 * caller (index.ts sanitizes input); this is a dumb upsert on purpose.
 */
export async function saveSettings(db: Db, next: SettingsView): Promise<void> {
  await db.query(
    `INSERT INTO focus.settings (id, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = now()`,
    [SETTINGS_ID, JSON.stringify(next)],
  );
}

// ---------------------------------------------------------------------------
// active session (row-level atomic — call inside withTransaction)
// ---------------------------------------------------------------------------

/**
 * The single active session, locked FOR UPDATE until the transaction ends.
 * The partial unique index guarantees at most one row exists; ORDER BY +
 * LIMIT 1 are defensive against constraint drift.
 */
export async function findActiveSession(tx: Db): Promise<SessionRow | null> {
  const { rows } = await tx.query<SessionPgRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM focus.sessions
     WHERE status IN ('running', 'paused')
     ORDER BY started_at DESC
     LIMIT 1
     FOR UPDATE`,
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Persist a brand-new session. `row.revision` must be 1 (a fresh row from the
 * timer). Inserting while another active session exists fails with 23505 on
 * sessions_one_active_idx — the caller decides how to surface that.
 */
export async function insertSession(tx: Db, row: SessionRow): Promise<void> {
  await tx.query(
    `INSERT INTO focus.sessions (
       id, kind, status, planned_duration_seconds, elapsed_before_pause_seconds,
       started_at, last_resumed_at, paused_at, ended_at, end_reason,
       actual_duration_seconds, revision
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    toParams(row),
  );
}

/**
 * Optimistic-concurrency write of a TRANSITIONED row (timer output, revision
 * already bumped): the statement only matches when the DB still holds
 * `row.revision - 1`. Returns the affected-row count — 0 means the row moved
 * on (stale write) and the caller must re-read and re-decide.
 */
export async function updateSessionRow(tx: Db, row: SessionRow): Promise<number> {
  const result = await tx.query(
    `UPDATE focus.sessions SET
       kind = $2,
       status = $3,
       planned_duration_seconds = $4,
       elapsed_before_pause_seconds = $5,
       started_at = $6,
       last_resumed_at = $7,
       paused_at = $8,
       ended_at = $9,
       end_reason = $10,
       actual_duration_seconds = $11,
       revision = $12,
       updated_at = now()
     WHERE id = $1 AND revision = $13`,
    [...toParams(row), row.revision - 1],
  );
  return result.rowCount ?? 0;
}

/**
 * Row-atomic "close an expired session" primitive. Inside one transaction
 * (the caller's): lock the active row, and if its planned end has passed,
 * apply the timer's natural completion and persist it. Returns the still-live
 * active row, or null when there is none (never had one, or just expired).
 */
export async function reconcileActive(tx: Db, now: Date): Promise<SessionRow | null> {
  const active = await findActiveSession(tx);
  if (active === null) return null;
  if (!isExpired(active, now)) return active;

  const completed = applyNaturalComplete(active, now);
  const updated = await updateSessionRow(tx, completed);
  if (updated !== 1) {
    // Impossible while holding the FOR UPDATE lock — the row changed out of
    // band. Fail loudly rather than fabricate a completed session.
    throw new Error(
      `focus repository: reconcile lost the row lock mid-transaction (id=${active.id})`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// history & stats (read-only)
// ---------------------------------------------------------------------------

/** Terminal session as shown in history lists. */
export type HistoryItemRow = {
  id: string;
  kind: SessionKind;
  status: "completed" | "cancelled";
  plannedDurationSeconds: number;
  actualDurationSeconds: number | null;
  startedAt: Date;
  endedAt: Date | null;
  endReason: EndReason | null;
};

type HistoryPgRow = {
  id: string;
  kind: SessionKind;
  status: "completed" | "cancelled";
  planned_duration_seconds: number;
  actual_duration_seconds: number | null;
  started_at: Date;
  ended_at: Date | null;
  end_reason: EndReason | null;
  /** bigint over() arrives as string; window count computed pre-LIMIT. */
  total: string;
};

/**
 * Terminal sessions (completed/cancelled), newest first, with the un-paginated
 * total for the UI page count. limit/offset are validated then parameterized.
 */
export async function listSessions(
  db: Db,
  page: { limit: number; offset: number },
): Promise<{ items: HistoryItemRow[]; total: number }> {
  assertIntIn("limit", page.limit, 1, 500);
  assertIntIn("offset", page.offset, 0, Number.MAX_SAFE_INTEGER);
  const { rows } = await db.query<HistoryPgRow>(
    `SELECT id, kind, status, planned_duration_seconds, actual_duration_seconds,
            started_at, ended_at, end_reason, COUNT(*) OVER () AS total
     FROM focus.sessions
     WHERE status IN ('completed', 'cancelled')
     ORDER BY started_at DESC
     LIMIT $1 OFFSET $2`,
    [page.limit, page.offset],
  );
  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    plannedDurationSeconds: r.planned_duration_seconds,
    actualDurationSeconds: r.actual_duration_seconds,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
  }));
  return { items, total: rows[0] ? Number(rows[0].total) : 0 };
}

/**
 * Aggregates for terminal sessions whose ended_at falls in [start, end):
 * focused seconds and completed rounds count kind='focus' only; sessionsEnded
 * includes completed/cancelled breaks.
 */
export async function todayStats(
  db: Db,
  range: { start: Date; end: Date },
): Promise<{ focusedSeconds: number; completedRounds: number; sessionsEnded: number }> {
  const { rows } = await db.query<{
    focused_seconds: number;
    completed_rounds: number;
    sessions_ended: number;
  }>(
    `SELECT
       COALESCE(SUM(actual_duration_seconds) FILTER (WHERE kind = 'focus'), 0)::int AS focused_seconds,
       COUNT(*) FILTER (WHERE kind = 'focus' AND status = 'completed')::int AS completed_rounds,
       COUNT(*) FILTER (WHERE status IN ('completed', 'cancelled'))::int AS sessions_ended
     FROM focus.sessions
     WHERE status IN ('completed', 'cancelled')
       AND ended_at >= $1
       AND ended_at < $2`,
    [range.start, range.end],
  );
  return {
    focusedSeconds: rows[0]?.focused_seconds ?? 0,
    completedRounds: rows[0]?.completed_rounds ?? 0,
    sessionsEnded: rows[0]?.sessions_ended ?? 0,
  };
}

/**
 * Per-local-day focus series over the last `days` days ending on
 * `todayLocal` ("YYYY-MM-DD", precomputed by the caller via timer.ts
 * localDateString — no calendar logic runs inside SQL beyond bucketing).
 * Days without sessions are zero-filled; only kind='focus' terminal sessions
 * count, and rounds only when completed.
 */
export async function statsSeries(
  db: Db,
  window: { timeZone: string; todayLocal: string; days: number },
): Promise<Array<{ date: string; focusedSeconds: number; completedRounds: number }>> {
  assertIntIn("days", window.days, 1, 366);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window.todayLocal)) {
    throw new RangeError(`todayLocal must be YYYY-MM-DD (got ${window.todayLocal})`);
  }
  const { rows } = await db.query<{
    date: string;
    focused_seconds: number;
    completed_rounds: number;
  }>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(s.actual_duration_seconds), 0)::int AS focused_seconds,
            COUNT(s.id) FILTER (WHERE s.status = 'completed')::int AS completed_rounds
     FROM generate_series($2::date - ($3::int - 1), $2::date, interval '1 day') AS d(day)
     LEFT JOIN focus.sessions s
       ON (s.ended_at AT TIME ZONE $1)::date = d.day::date
      AND s.kind = 'focus'
      AND s.status IN ('completed', 'cancelled')
     GROUP BY d.day
     ORDER BY d.day`,
    [window.timeZone, window.todayLocal, window.days],
  );
  return rows.map((r) => ({
    date: r.date,
    focusedSeconds: r.focused_seconds,
    completedRounds: r.completed_rounds,
  }));
}

/**
 * Completed focus rounds since the last completed long break — the pomodoro
 * cycle position that picks the next session kind (timer.ts nextKind). With
 * no completed long break yet, the anchor is -infinity (count from the
 * beginning of history).
 */
export async function completedFocusSinceLongBreak(db: Db): Promise<number> {
  const { rows } = await db.query<{ completed_focus: number }>(
    `WITH anchor AS (
       SELECT COALESCE(MAX(ended_at), '-infinity'::timestamptz) AS a
       FROM focus.sessions
       WHERE kind = 'long_break' AND status = 'completed'
     )
     SELECT COUNT(*)::int AS completed_focus
     FROM focus.sessions, anchor
     WHERE kind = 'focus' AND status = 'completed' AND ended_at > anchor.a`,
  );
  return rows[0]?.completed_focus ?? 0;
}
