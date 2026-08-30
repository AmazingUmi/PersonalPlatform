/**
 * Focus API module (APP-1 F04) — the HTTP surface over the focus repository.
 *
 * Layer contract: every write endpoint runs the whole
 * "lock active row → reconcile expiry → validate → apply timer transition →
 * write" sequence inside ONE ctx.database.withTransaction; a session row is
 * never read and then written outside that transaction. Conflicts are returned
 * as VALUES from the transaction body (not thrown), so the transaction still
 * commits — a natural completion performed by reconcileActive must never be
 * rolled back by a 409 — and are translated into AppError only afterwards,
 * with details.state re-assembled from a fresh read so the client self-heals
 * against the authoritative database state.
 *
 * All timestamps come from ctx.time.now() (injectable clock, FP-10); responses
 * are camelCase with ISO strings. Events fire strictly AFTER the transaction
 * commits (a rolled-back session never happened).
 */

import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import {
  SETTINGS_LIMITS,
  applyPause,
  applyResume,
  applyStop,
  localDateString,
  nextKind as nextKindAfter,
  sanitizeSettings,
  toSessionView,
  type SessionKind,
  type SessionRow,
  type SessionView,
  type SettingsView,
} from "./timer.js";
import {
  completedFocusSinceLongBreak,
  getSettings,
  insertSession,
  isUniqueViolation,
  listSessions,
  reconcileActive,
  saveSettings,
  statsSeries,
  todayStats,
  updateSessionRow,
  type HistoryItemRow,
} from "./repository.js";

const id = "focus";

/** Exactly the three conflict codes the frontend knows how to self-heal from. */
type ConflictCode = "session_already_active" | "no_active_session" | "revision_conflict";

const NO_ACTIVE_MESSAGE = "no active focus session";
const ALREADY_ACTIVE_MESSAGE = "a focus session is already active";

/** Typed conflict value (returned from tx bodies, so `code` must not widen). */
function conflict(code: ConflictCode, message: string): { code: ConflictCode; message: string } {
  return { code, message };
}

/** GET /state — the full client-facing snapshot. */
interface FocusState {
  now: string;
  active: SessionView | null;
  today: {
    focusedSeconds: number;
    completedRounds: number;
    sessionsEnded: number;
  };
  /** Kind of the session that would run next: the active one, else the schedule pick. */
  nextKind: SessionKind;
  settings: SettingsView;
}

/** GET /sessions item — a terminal session as history. */
interface HistoryItem {
  id: string;
  kind: SessionKind;
  status: "completed" | "cancelled";
  plannedDurationSeconds: number;
  actualDurationSeconds: number | null;
  startedAt: string;
  endedAt: string | null;
  endReason: "natural" | "manual_stop" | null;
}

// ---------------------------------------------------------------------------
// state assembly (shared by every response, 200 and 409 alike)
// ---------------------------------------------------------------------------

/**
 * Build the FocusState around a KNOWN active row (read inside the just-
 * committed transaction): settings, today stats and cycle position are fetched
 * in parallel outside any transaction — they are plain reads.
 */
async function assembleState(
  ctx: AppContext,
  now: Date,
  active: SessionRow | null,
): Promise<FocusState> {
  const [settings, today, completedFocus] = await Promise.all([
    getSettings(ctx.database),
    todayStats(ctx.database, ctx.time.todayRangeUtc(now)),
    completedFocusSinceLongBreak(ctx.database),
  ]);
  return {
    now: now.toISOString(),
    active: active === null ? null : toSessionView(active, now),
    today,
    nextKind:
      active !== null ? active.kind : nextKindAfter(completedFocus, settings.longBreakInterval),
    settings,
  };
}

/**
 * Close any expired running session in its own transaction, publish the
 * completion event, then assemble the state. Every read path funnels through
 * here so a naturally completed session is committed, published and visible
 * in a single request.
 */
async function syncState(ctx: AppContext, now: Date): Promise<FocusState> {
  const { row: active, completed } = await ctx.database.withTransaction((tx) =>
    reconcileActive(tx, now),
  );
  if (completed !== null) publishCompleted(ctx, completed);
  return assembleState(ctx, now, active);
}

/**
 * 409 whose details carry the authoritative state read AFTER the transaction.
 * The fresh syncState re-reconciles (idempotent by then) and even re-publishes
 * a completion the failed transaction may have rolled back (start's 23505 path).
 */
async function stateConflict(
  ctx: AppContext,
  now: Date,
  code: ConflictCode,
  message: string,
): Promise<never> {
  const state = await syncState(ctx, now);
  throw new AppError(409, code, message, { state });
}

// ---------------------------------------------------------------------------
// events (published only after the owning transaction committed)
// ---------------------------------------------------------------------------

function publishCompleted(ctx: AppContext, row: SessionRow): void {
  ctx.events.publish(
    "focus.session.completed.v1",
    { id: row.id, kind: row.kind, actualDurationSeconds: row.actualDurationSeconds },
    id,
  );
}

function publishCancelled(ctx: AppContext, row: SessionRow): void {
  ctx.events.publish(
    "focus.session.cancelled.v1",
    { id: row.id, kind: row.kind, actualDurationSeconds: row.actualDurationSeconds },
    id,
  );
}

// ---------------------------------------------------------------------------
// transition runner (pause / resume / stop share this skeleton)
// ---------------------------------------------------------------------------

/** What a transition transaction decided; conflicts as values so the tx commits. */
interface TransitionOutcome {
  /** Active row as it exists after the committed transaction (null after stop). */
  activeAfter: SessionRow | null;
  /** Naturally completed during reconcile inside this transaction. */
  completed: SessionRow | null;
  /** Cancelled by THIS request (stop). */
  cancelled: SessionRow | null;
  conflict: { code: ConflictCode; message: string } | null;
}

async function finishTransition(
  ctx: AppContext,
  now: Date,
  outcome: TransitionOutcome,
): Promise<{ state: FocusState }> {
  // The transaction has committed — now the side effects are real.
  if (outcome.completed !== null) publishCompleted(ctx, outcome.completed);
  if (outcome.cancelled !== null) publishCancelled(ctx, outcome.cancelled);
  if (outcome.conflict !== null) {
    await stateConflict(ctx, now, outcome.conflict.code, outcome.conflict.message);
  }
  return { state: await assembleState(ctx, now, outcome.activeAfter) };
}

/**
 * The pause/resume/stop body is optional (a bodyless POST is a valid
 * optimistic request), so it is validated by hand instead of a JSON Schema —
 * Fastify would reject an absent body against `type: "object"`.
 */
function readBaseRevision(body: unknown): number | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "validation_error", "body must be an object");
  }
  const { baseRevision } = body as { baseRevision?: unknown };
  if (baseRevision === undefined) return undefined;
  if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision)) {
    throw new AppError(400, "validation_error", "baseRevision must be an integer");
  }
  return baseRevision;
}

/** Stale-client guard: baseRevision, when given, must match the locked row. */
function revisionConflict(
  active: SessionRow,
  baseRevision: number | undefined,
): { code: ConflictCode; message: string } | null {
  if (baseRevision === undefined || baseRevision === active.revision) return null;
  return conflict(
    "revision_conflict",
    `baseRevision ${baseRevision} does not match session revision ${active.revision}`,
  );
}

/** Settings default for the requested kind (read inside the start transaction). */
function defaultPlannedSeconds(kind: SessionKind, settings: SettingsView): number {
  switch (kind) {
    case "focus":
      return settings.focusDurationSeconds;
    case "short_break":
      return settings.shortBreakDurationSeconds;
    case "long_break":
      return settings.longBreakDurationSeconds;
  }
}

function toHistoryItem(row: HistoryItemRow): HistoryItem {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    plannedDurationSeconds: row.plannedDurationSeconds,
    actualDurationSeconds: row.actualDurationSeconds,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
    endReason: row.endReason,
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.get("/state", async () => syncState(ctx, ctx.time.now()));

  ctx.api.post<{
    Body: { kind: SessionKind; plannedDurationSeconds?: number; baseRevision?: number };
  }>(
    "/start",
    {
      schema: {
        body: {
          type: "object",
          required: ["kind"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["focus", "short_break", "long_break"] },
            plannedDurationSeconds: { type: "integer", minimum: 1, maximum: 86400 },
            baseRevision: { type: "integer" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const now = ctx.time.now();

      let outcome: TransitionOutcome;
      try {
        outcome = await db.withTransaction(async (tx) => {
          const { row: active, completed } = await reconcileActive(tx, now);
          if (active !== null) {
            return {
              activeAfter: active,
              completed,
              cancelled: null,
              conflict: conflict("session_already_active", ALREADY_ACTIVE_MESSAGE),
            };
          }
          // Settings read inside the transaction so the default is consistent
          // with the row we are about to insert.
          const planned =
            body.plannedDurationSeconds ??
            defaultPlannedSeconds(body.kind, await getSettings(tx));
          const row: SessionRow = {
            id: randomUUID(),
            kind: body.kind,
            status: "running",
            plannedDurationSeconds: planned,
            elapsedBeforePauseSeconds: 0,
            startedAt: now,
            lastResumedAt: now,
            pausedAt: null,
            endedAt: null,
            endReason: null,
            actualDurationSeconds: null,
            revision: 1,
          };
          await insertSession(tx, row);
          return { activeAfter: row, completed, cancelled: null, conflict: null };
        });
      } catch (error) {
        // Lost the one-active-session race: a concurrent start committed first
        // (sessions_one_active_idx). This transaction — including its
        // reconcile — rolled back; stateConflict's fresh syncState re-reconciles
        // and publishes any natural completion before answering.
        if (isUniqueViolation(error)) {
          await stateConflict(ctx, now, "session_already_active", ALREADY_ACTIVE_MESSAGE);
        }
        throw error;
      }
      const result = await finishTransition(ctx, now, outcome);
      return reply.code(201).send(result);
    },
  );

  ctx.api.post("/pause", async (request) => {
    const baseRevision = readBaseRevision(request.body);
    const now = ctx.time.now();
    const outcome = await db.withTransaction(async (tx) => {
      const { row: active, completed } = await reconcileActive(tx, now);
      if (active === null) {
        return {
          activeAfter: null,
          completed,
          cancelled: null,
          conflict: conflict("no_active_session", NO_ACTIVE_MESSAGE),
        };
      }
      const stale = revisionConflict(active, baseRevision);
      if (stale !== null) {
        return { activeAfter: active, completed, cancelled: null, conflict: stale };
      }
      // Idempotent: already paused → no write, no revision bump, no event.
      if (active.status === "paused") {
        return { activeAfter: active, completed, cancelled: null, conflict: null };
      }
      const paused = applyPause(active, now);
      const updated = await updateSessionRow(tx, paused);
      if (updated !== 1) {
        return {
          activeAfter: active,
          completed,
          cancelled: null,
          conflict: conflict("revision_conflict", "session changed during pause"),
        };
      }
      return { activeAfter: paused, completed, cancelled: null, conflict: null };
    });
    return finishTransition(ctx, now, outcome);
  });

  ctx.api.post("/resume", async (request) => {
    const baseRevision = readBaseRevision(request.body);
    const now = ctx.time.now();
    const outcome = await db.withTransaction(async (tx) => {
      const { row: active, completed } = await reconcileActive(tx, now);
      if (active === null) {
        return {
          activeAfter: null,
          completed,
          cancelled: null,
          conflict: conflict("no_active_session", NO_ACTIVE_MESSAGE),
        };
      }
      const stale = revisionConflict(active, baseRevision);
      if (stale !== null) {
        return { activeAfter: active, completed, cancelled: null, conflict: stale };
      }
      // Idempotent: already running → no write, no revision bump, no event.
      if (active.status === "running") {
        return { activeAfter: active, completed, cancelled: null, conflict: null };
      }
      const resumed = applyResume(active, now);
      const updated = await updateSessionRow(tx, resumed);
      if (updated !== 1) {
        return {
          activeAfter: active,
          completed,
          cancelled: null,
          conflict: conflict("revision_conflict", "session changed during resume"),
        };
      }
      return { activeAfter: resumed, completed, cancelled: null, conflict: null };
    });
    return finishTransition(ctx, now, outcome);
  });

  ctx.api.post("/stop", async (request) => {
    const baseRevision = readBaseRevision(request.body);
    const now = ctx.time.now();
    const outcome = await db.withTransaction(async (tx) => {
      const { row: active, completed } = await reconcileActive(tx, now);
      // reconcile may have JUST completed the session naturally — that
      // completion commits with this transaction, and the 409's details.state
      // (assembled from a fresh read) carries the new terminal reality.
      if (active === null) {
        return {
          activeAfter: null,
          completed,
          cancelled: null,
          conflict: conflict("no_active_session", NO_ACTIVE_MESSAGE),
        };
      }
      const stale = revisionConflict(active, baseRevision);
      if (stale !== null) {
        return { activeAfter: active, completed, cancelled: null, conflict: stale };
      }
      const stopped = applyStop(active, now);
      const updated = await updateSessionRow(tx, stopped);
      if (updated !== 1) {
        return {
          activeAfter: active,
          completed,
          cancelled: null,
          conflict: conflict("revision_conflict", "session changed during stop"),
        };
      }
      return { activeAfter: null, completed, cancelled: stopped, conflict: null };
    });
    return finishTransition(ctx, now, outcome);
  });

  ctx.api.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/sessions",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { items, total } = await listSessions(ctx.database, {
        limit: request.query.limit ?? 20,
        offset: request.query.offset ?? 0,
      });
      return { items: items.map(toHistoryItem), total };
    },
  );

  ctx.api.get<{ Querystring: { days?: number } }>(
    "/stats",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { days: { type: "integer", minimum: 1, maximum: 90, default: 7 } },
        },
      },
    },
    async (request) => {
      const timezone = ctx.time.timezone();
      const now = ctx.time.now();
      const series = await statsSeries(ctx.database, {
        timeZone: timezone,
        // Calendar bucketing uses the platform timezone (FP-10), never SQL's.
        todayLocal: localDateString(now, timezone),
        days: request.query.days ?? 7,
      });
      const totals = series.reduce(
        (acc, day) => ({
          focusedSeconds: acc.focusedSeconds + day.focusedSeconds,
          completedRounds: acc.completedRounds + day.completedRounds,
        }),
        { focusedSeconds: 0, completedRounds: 0 },
      );
      return { timezone, days: series, totals };
    },
  );

  ctx.api.get("/settings", async () => getSettings(ctx.database));

  ctx.api.put<{ Body: SettingsView }>(
    "/settings",
    {
      schema: {
        body: {
          type: "object",
          required: [
            "focusDurationSeconds",
            "shortBreakDurationSeconds",
            "longBreakDurationSeconds",
            "longBreakInterval",
          ],
          additionalProperties: false,
          properties: {
            focusDurationSeconds: {
              type: "integer",
              minimum: SETTINGS_LIMITS.focusDurationSeconds.min,
              maximum: SETTINGS_LIMITS.focusDurationSeconds.max,
            },
            shortBreakDurationSeconds: {
              type: "integer",
              minimum: SETTINGS_LIMITS.shortBreakDurationSeconds.min,
              maximum: SETTINGS_LIMITS.shortBreakDurationSeconds.max,
            },
            longBreakDurationSeconds: {
              type: "integer",
              minimum: SETTINGS_LIMITS.longBreakDurationSeconds.min,
              maximum: SETTINGS_LIMITS.longBreakDurationSeconds.max,
            },
            longBreakInterval: {
              type: "integer",
              minimum: SETTINGS_LIMITS.longBreakInterval.min,
              maximum: SETTINGS_LIMITS.longBreakInterval.max,
            },
          },
        },
      },
    },
    async (request) => {
      // Defense in depth: the schema already guarantees shape and range, but
      // every later read runs through sanitizeSettings — never persist
      // anything it would reject (a poisoned row would silently fall back to
      // defaults on read).
      const settings = sanitizeSettings(request.body);
      if (settings === null) {
        throw new AppError(
          422,
          "invalid_settings",
          "settings fields must be integers within their allowed ranges",
        );
      }
      await saveSettings(ctx.database, settings);
      return settings;
    },
  );
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, healthcheck };
export default app;
