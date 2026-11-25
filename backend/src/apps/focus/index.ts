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
 * commits (a rolled-back session never happened). Every handler resolves the
 * request user via ctx.auth.requireUser and scopes all reads/writes to that
 * user (AUTH-3 ownership).
 */

import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppAgentContext, AppAgentInvocation } from "../../core/agent/types.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import {
  assertPresentedHash, editorBaseHash, lockOwnedTables, lockOwnerSet, parseSnapshotRow, readPresentedHash, singletonBaseHash, syncWriteFenced,
} from "../../core/data-management/sync-fence.js";
import {
  SETTINGS_LIMITS,
  applyNaturalComplete,
  applyPause,
  applyResume,
  applyStop,
  isExpired,
  localDateString,
  nextKind as nextKindAfter,
  DEFAULT_SETTINGS,
  sanitizeSettings,
  toSessionView,
  type SessionKind,
  type SessionRow,
  type SessionView,
  type SettingsView,
} from "./timer.js";
import {
  activeSessionSnapshot,
  completedFocusSinceLongBreak,
  findTerminalSession,
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
type ConflictCode = "session_already_active" | "no_active_session" | "revision_conflict" | "sync_stale" | "sync_base_required";

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
  settings: SettingsView & { baseHash: string };
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

/** Settings fields and baseHash from one snapshot, including the absent-row proof. */
async function settingsProof(db: AppContext["database"], userId: string): Promise<SettingsView & { baseHash: string }> {
  const { rows } = await db.query<{ value: unknown; snapshot: string }>(
    "SELECT value, row_to_json(s)::text AS snapshot FROM focus.settings s WHERE id = $1 AND user_id = $2",
    ["current", userId],
  );
  if (!rows[0]) {
    return {
      ...DEFAULT_SETTINGS,
      baseHash: singletonBaseHash("focus.settings", { id: "current", value: DEFAULT_SETTINGS }),
    };
  }
  return {
    ...(sanitizeSettings(rows[0].value) ?? DEFAULT_SETTINGS),
    baseHash: editorBaseHash([{ table: "focus.settings", row: parseSnapshotRow(rows[0].snapshot) }]),
  };
}

/**
 * Build the FocusState around a KNOWN active row (read inside the just-
 * committed transaction): settings, today stats and cycle position are fetched
 * in parallel outside any transaction — they are plain reads. Every read is
 * scoped to the requesting user (AUTH-3).
 */
async function assembleState(
  ctx: Pick<AppContext, "database" | "time">,
  userId: string,
  now: Date,
  active: SessionRow | null,
  baseHash: string | null = null,
  knownSettings?: FocusState["settings"],
  projectedCompletion?: SessionRow | null,
): Promise<FocusState> {
  const [settings, today, completedFocus] = await Promise.all([
    knownSettings ?? settingsProof(ctx.database, userId),
    todayStats(ctx.database, userId, ctx.time.todayRangeUtc(now)),
    completedFocusSinceLongBreak(ctx.database, userId),
  ]);
  let effectiveRounds = completedFocus;
  if (projectedCompletion?.endedAt) {
    const range = ctx.time.todayRangeUtc(now);
    if (projectedCompletion.endedAt >= range.start && projectedCompletion.endedAt < range.end) {
      today.sessionsEnded++;
      if (projectedCompletion.kind === "focus") {
        today.completedRounds++;
        today.focusedSeconds += projectedCompletion.actualDurationSeconds ?? 0;
      }
    }
    if (projectedCompletion.kind === "focus") effectiveRounds++;
    if (projectedCompletion.kind === "long_break") effectiveRounds = 0;
  }
  return {
    now: now.toISOString(),
    active: active === null ? null : { ...toSessionView(active, now), ...(baseHash ? { baseHash } : {}) },
    today,
    nextKind:
      active !== null ? active.kind : nextKindAfter(effectiveRounds, settings.longBreakInterval),
    settings,
  };
}

/**
 * Close any expired running session of one user in its own transaction,
 * publish the completion event, then assemble the state. State reads
 * funnel through here so a naturally completed session is committed,
 * published and visible in a single request.
 */
async function sessionBaseHash(tx: AppContext["database"], userId: string, sessionId: string): Promise<string | null> {
  const { rows } = await tx.query<{ snapshot: string }>(
    "SELECT row_to_json(s)::text AS snapshot FROM focus.sessions s WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  return rows[0] ? sessionHash(rows[0].snapshot) : null;
}

async function syncState(ctx: AppContext, userId: string, now: Date): Promise<FocusState> {
  const { row: active, completed, baseHash } = await ctx.database.withTransaction(async (tx) => {
    await lockOwnedTables(tx, ["focus.sessions"]);
    const result = await reconcileActive(tx, userId, now);
    const baseHash = result.row ? await sessionBaseHash(tx, userId, result.row.id) : null;
    return { ...result, baseHash };
  });
  if (completed !== null) publishCompleted(ctx, userId, completed);
  return assembleState(ctx, userId, now, active, baseHash);
}

/**
 * 409 whose details carry the authoritative state read AFTER the transaction.
 * The fresh syncState re-reconciles (idempotent by then) and even re-publishes
 * a completion the failed transaction may have rolled back (start's 23505 path).
 */
async function stateConflict(
  ctx: AppContext,
  userId: string,
  now: Date,
  code: ConflictCode,
  message: string,
): Promise<never> {
  const state = await syncState(ctx, userId, now);
  throw new AppError(409, code, message, { state });
}

// ---------------------------------------------------------------------------
// events (published only after the owning transaction committed)
// ---------------------------------------------------------------------------

// `userId` is an additive field on the .v1 payloads (AUTH-3 payload evolution
// rule: additions allowed, renames/removals require a new .vN).

function publishCompleted(ctx: Pick<AppContext, "events"> | AppAgentInvocation, userId: string, row: SessionRow): void {
  ctx.events.publish(
    "focus.session.completed.v1",
    {
      userId,
      id: row.id,
      kind: row.kind,
      actualDurationSeconds: row.actualDurationSeconds,
    },
    id,
  );
}

function publishCancelled(ctx: Pick<AppContext, "events"> | AppAgentInvocation, userId: string, row: SessionRow): void {
  ctx.events.publish(
    "focus.session.cancelled.v1",
    {
      userId,
      id: row.id,
      kind: row.kind,
      actualDurationSeconds: row.actualDurationSeconds,
    },
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
  activeHash?: string | null;
}

async function finishTransition(
  ctx: AppContext,
  userId: string,
  now: Date,
  outcome: TransitionOutcome,
): Promise<{ state: FocusState }> {
  // The transaction has committed — now the side effects are real.
  if (outcome.completed !== null) publishCompleted(ctx, userId, outcome.completed);
  if (outcome.cancelled !== null) publishCancelled(ctx, userId, outcome.cancelled);
  if (outcome.conflict !== null) {
    await stateConflict(ctx, userId, now, outcome.conflict.code, outcome.conflict.message);
  }
  return { state: await assembleState(ctx, userId, now, outcome.activeAfter, outcome.activeHash ?? null) };
}

/**
 * The pause/resume/stop body is optional (a bodyless POST is a valid
 * optimistic request), so it is validated by hand instead of a JSON Schema —
 * Fastify would reject an absent body against `type: "object"`.
 */
function readGuard(body: unknown): { baseRevision?: number; baseHash?: string } {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "validation_error", "body must be an object");
  }
  const { baseRevision } = body as { baseRevision?: unknown };
  if (baseRevision !== undefined && (typeof baseRevision !== "number" || !Number.isInteger(baseRevision))) {
    throw new AppError(400, "validation_error", "baseRevision must be an integer");
  }
  return {
    baseRevision: baseRevision as number | undefined,
    baseHash: readPresentedHash((body as { baseHash?: unknown }).baseHash),
  };
}

function hashConflict(
  fenced: boolean,
  presented: string | undefined,
  actual: string,
): { code: ConflictCode; message: string } | null {
  try {
    assertPresentedHash(fenced, presented, actual);
    return null;
  } catch (error) {
    if (error instanceof AppError && (error.code === "sync_stale" || error.code === "sync_base_required")) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
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


type FocusDb = AppContext["database"];
type TimerAction = "pause" | "resume" | "stop";

async function lockFocusStart(tx: FocusDb, userId: string): Promise<void> {
  await lockOwnedTables(tx, ["focus.sessions", "focus.settings"]);
  await lockOwnerSet(tx, userId, "focus.sessions");
  await lockOwnerSet(tx, userId, "focus.settings");
}

async function startSession(tx: FocusDb, userId: string, kind: SessionKind, planned: number, now: Date): Promise<SessionRow> {
  const row: SessionRow = {
    id: randomUUID(),
    kind: kind,
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
  await insertSession(tx, userId, row);
  return row;
}

async function writeTransition(tx: FocusDb, userId: string, action: TimerAction, active: SessionRow, now: Date): Promise<SessionRow | null> {
  const transition = { pause: applyPause, resume: applyResume, stop: applyStop }[action];
  const row = transition(active, now);
  return await updateSessionRow(tx, userId, row) === 1 ? row : null;
}

async function focusStats(ctx: Pick<AppContext, "database" | "time">, userId: string, days: number) {
  const timezone = ctx.time.timezone();
  const now = ctx.time.now();
  const series = await statsSeries(ctx.database, userId, {
    timeZone: timezone,
    // Calendar bucketing uses the platform timezone (FP-10), never SQL's.
    todayLocal: localDateString(now, timezone),
    days: days,
  });
  const totals = series.reduce(
    (acc, day) => ({
      focusedSeconds: acc.focusedSeconds + day.focusedSeconds,
      completedRounds: acc.completedRounds + day.completedRounds,
    }),
    { focusedSeconds: 0, completedRounds: 0 },
  );
  return { timezone, days: series, totals };
}

async function agentFocusProof(ctx: AppAgentInvocation, now: Date, lock = false) {
  const settings = await settingsProof(ctx.database, ctx.userId);
  const saved = await activeSessionSnapshot(ctx.database, ctx.userId, lock);
  const raw = saved?.row ?? null;
  const expired = raw && isExpired(raw, now) ? applyNaturalComplete(raw, now) : null;
  const active = expired ? null : raw;
  const baseHash = createHash("sha256").update(JSON.stringify([
    settings.baseHash, saved ? sessionHash(saved.snapshot) : null, active?.id ?? null,
  ])).digest("hex");
  return { settings, active, expired, baseHash };
}

function sessionHash(snapshot: string): string {
  return editorBaseHash([{ table: "focus.sessions", row: parseSnapshotRow(snapshot) }]);
}

async function agentFocusView(ctx: AppAgentInvocation, now: Date, proof: Awaited<ReturnType<typeof agentFocusProof>>) {
  const view = await assembleState(ctx, ctx.userId, now, proof.active, proof.baseHash, proof.settings, proof.expired);
  return { ...view, baseHash: proof.baseHash };
}

async function focusProofConflict(ctx: AppAgentInvocation, now: Date, proof: Awaited<ReturnType<typeof agentFocusProof>>, message: string): Promise<never> {
  throw new AppError(409, "conflict", message, {
    current: await agentFocusView(ctx, now, proof),
    retryHint: "Get the current Focus state and use its session ID and baseHash.",
  });
}

async function assertFocusProof(ctx: AppAgentInvocation, now: Date, proof: Awaited<ReturnType<typeof agentFocusProof>>, baseHash: unknown): Promise<void> {
  const error = hashConflict(await syncWriteFenced(ctx.database, ctx.userId), readPresentedHash(baseHash), proof.baseHash);
  if (error) await focusProofConflict(ctx, now, proof, "The Focus timer or settings changed.");
}

function focusArgs(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object" as const, additionalProperties: false, properties, required };
}

async function registerAgent(agent: AppAgentContext): Promise<void> {
  const state = async (ctx: AppAgentInvocation) => {
    const now = ctx.time.now();
    return agentFocusView(ctx, now, await agentFocusProof(ctx, now));
  };
  agent.tool({
    name: "focus_state", description: "Get the effective Focus timer, settings and concurrency hash.",
    action: "read", scopes: ["read"], inputSchema: focusArgs({}),
    execute: async ctx => ({ data: await state(ctx) }),
  });

  const baseHash = { type: "string", pattern: "^[0-9a-fA-F]{64}$" };
  agent.tool({
    name: "focus_start", description: "Start a Focus timer from the observed inactive state.",
    action: "write", scopes: ["read", "write"], create: true,
    inputSchema: focusArgs({
      kind: { type: "string", enum: ["focus", "short_break", "long_break"] },
      plannedDurationSeconds: { type: "integer", minimum: 1, maximum: 86400 },
      baseHash,
    }, ["kind", "baseHash"]),
    execute: async (ctx, args) => {
      const now = ctx.time.now();
      await lockFocusStart(ctx.database, ctx.userId);
      const proof = await agentFocusProof(ctx, now, true);
      await assertFocusProof(ctx, now, proof, args.baseHash);
      if (proof.active) await focusProofConflict(ctx, now, proof, ALREADY_ACTIVE_MESSAGE);
      if (proof.expired) {
        const { completed } = await reconcileActive(ctx.database, ctx.userId, now);
        if (completed) publishCompleted(ctx, ctx.userId, completed);
      }
      const kind = args.kind as SessionKind;
      const duration = args.plannedDurationSeconds as number | undefined;
      const created = await startSession(ctx.database, ctx.userId, kind, duration ?? defaultPlannedSeconds(kind, proof.settings), now);
      return { data: { id: created.id }, resourceId: created.id };
    },
  });

  for (const action of ["pause", "resume", "stop"] as const) {
    agent.tool({
      name: `focus_${action}`, description: `Perform ${action} on the observed Focus session.`,
      action: "write", scopes: ["read", "write"],
      inputSchema: focusArgs({ sessionId: { type: "string", format: "uuid" }, baseHash }, ["sessionId", "baseHash"]),
      execute: async (ctx, args) => {
        const now = ctx.time.now();
        await lockFocusStart(ctx.database, ctx.userId);
        const proof = await agentFocusProof(ctx, now, true);
        await assertFocusProof(ctx, now, proof, args.baseHash);
        const active = proof.active;
        if (!active) throw new AppError(409, "no_active_session", NO_ACTIVE_MESSAGE);
        if (active.id !== String(args.sessionId).toLowerCase()) await focusProofConflict(ctx, now, proof, "The observed Focus session was replaced.");
        const already = (action === "pause" && active.status === "paused") || (action === "resume" && active.status === "running");
        if (!already) {
          const changed = await writeTransition(ctx.database, ctx.userId, action, active, now);
          if (!changed) await focusProofConflict(ctx, now, proof, "The Focus session changed during the operation.");
          if (action === "stop" && changed) publishCancelled(ctx, ctx.userId, changed);
        }
        const changed = await agentFocusProof(ctx, now);
        return { data: await agentFocusView(ctx, now, changed), resourceId: active.id };
      },
    });
  }
  agent.tool({
    name: "focus_stats", description: "Summarize owned Focus history by platform-local calendar day.",
    action: "read", scopes: ["read"], inputSchema: focusArgs({ days: { type: "integer", minimum: 1, maximum: 90, default: 7 } }),
    execute: async (ctx, args) => ({ data: await focusStats(ctx, ctx.userId, Number(args.days)) }),
  });
  agent.tool({
    name: "focus_sessions_list", description: "List recent terminal Focus sessions.",
    action: "read", scopes: ["read"], inputSchema: focusArgs({
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      offset: { type: "integer", minimum: 0, maximum: 2_147_483_647, default: 0 },
    }),
    execute: async ({ database, userId }, args) => {
      const { items, total } = await listSessions(database, userId, { limit: Number(args.limit), offset: Number(args.offset) });
      return { data: { items: items.map(toHistoryItem), total } };
    },
  });
  agent.resource({ uri: "pp://apps/focus/summary", name: "Focus summary", read: state });
  agent.overview(state);
}

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.get("/state", async (request) => {
    const user = await ctx.auth.requireUser(request);
    return syncState(ctx, user.id, ctx.time.now());
  });

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
      const user = await ctx.auth.requireUser(request);
      const body = request.body;
      const now = ctx.time.now();

      let outcome: TransitionOutcome;
      try {
        outcome = await db.withTransaction(async (tx) => {
          await lockFocusStart(tx, user.id);
          const { row: active, completed } = await reconcileActive(tx, user.id, now);
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
            defaultPlannedSeconds(body.kind, await getSettings(tx, user.id));
          const row = await startSession(tx, user.id, body.kind, planned, now);
          return {
            activeAfter: row,
            completed,
            cancelled: null,
            conflict: null,
            activeHash: await sessionBaseHash(tx, user.id, row.id),
          };
        });
      } catch (error) {
        // Lost the one-active-session race: a concurrent start committed first
        // (sessions_one_active_idx, per user since AUTH-3). This transaction —
        // including its reconcile — rolled back; stateConflict's fresh
        // syncState re-reconciles and publishes any natural completion before
        // answering.
        if (isUniqueViolation(error)) {
          await stateConflict(ctx, user.id, now, "session_already_active", ALREADY_ACTIVE_MESSAGE);
        }
        throw error;
      }
      const result = await finishTransition(ctx, user.id, now, outcome);
      return reply.code(201).send(result);
    },
  );

  ctx.api.post("/pause", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const guard = readGuard(request.body);
    const now = ctx.time.now();
    const outcome = await db.withTransaction(async (tx) => {
      await lockOwnedTables(tx, ["focus.sessions"]);
      const { row: active, completed } = await reconcileActive(tx, user.id, now);
      if (active === null) {
        return {
          activeAfter: null,
          completed,
          cancelled: null,
          conflict: conflict("no_active_session", NO_ACTIVE_MESSAGE),
          activeHash: null as string | null,
        };
      }
      const stale = revisionConflict(active, guard.baseRevision);
      if (stale !== null) {
        return { activeAfter: active, completed, cancelled: null, conflict: stale, activeHash: await sessionBaseHash(tx, user.id, active.id) };
      }
      if (active.status === "paused") {
        return { activeAfter: active, completed, cancelled: null, conflict: null, activeHash: await sessionBaseHash(tx, user.id, active.id) };
      }
      const proved = hashConflict(await syncWriteFenced(tx, user.id), guard.baseHash, (await sessionBaseHash(tx, user.id, active.id)) ?? "");
      if (proved) return { activeAfter: active, completed, cancelled: null, conflict: proved, activeHash: await sessionBaseHash(tx, user.id, active.id) };
      const paused = await writeTransition(tx, user.id, "pause", active, now);
      if (!paused) {
        return {
          activeAfter: active,
          completed,
          cancelled: null,
          conflict: conflict("revision_conflict", "session changed during pause"),
          activeHash: await sessionBaseHash(tx, user.id, active.id),
        };
      }
      return { activeAfter: paused, completed, cancelled: null, conflict: null, activeHash: await sessionBaseHash(tx, user.id, paused.id) };
    });
    return finishTransition(ctx, user.id, now, outcome);
  });

  ctx.api.post("/resume", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const guard = readGuard(request.body);
    const now = ctx.time.now();
    const outcome = await db.withTransaction(async (tx) => {
      await lockOwnedTables(tx, ["focus.sessions"]);
      const { row: active, completed } = await reconcileActive(tx, user.id, now);
      if (active === null) {
        return {
          activeAfter: null,
          completed,
          cancelled: null,
          conflict: conflict("no_active_session", NO_ACTIVE_MESSAGE),
          activeHash: null as string | null,
        };
      }
      const stale = revisionConflict(active, guard.baseRevision);
      if (stale !== null) {
        return { activeAfter: active, completed, cancelled: null, conflict: stale, activeHash: await sessionBaseHash(tx, user.id, active.id) };
      }
      if (active.status === "running") {
        return { activeAfter: active, completed, cancelled: null, conflict: null, activeHash: await sessionBaseHash(tx, user.id, active.id) };
      }
      const proved = hashConflict(await syncWriteFenced(tx, user.id), guard.baseHash, (await sessionBaseHash(tx, user.id, active.id)) ?? "");
      if (proved) return { activeAfter: active, completed, cancelled: null, conflict: proved, activeHash: await sessionBaseHash(tx, user.id, active.id) };
      const resumed = await writeTransition(tx, user.id, "resume", active, now);
      if (!resumed) {
        return {
          activeAfter: active,
          completed,
          cancelled: null,
          conflict: conflict("revision_conflict", "session changed during resume"),
          activeHash: await sessionBaseHash(tx, user.id, active.id),
        };
      }
      return { activeAfter: resumed, completed, cancelled: null, conflict: null, activeHash: await sessionBaseHash(tx, user.id, resumed.id) };
    });
    return finishTransition(ctx, user.id, now, outcome);
  });

  ctx.api.post("/stop", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const guard = readGuard(request.body);
    const now = ctx.time.now();
    const outcome = await db.withTransaction(async (tx) => {
      await lockOwnedTables(tx, ["focus.sessions"]);
      const { row: active, completed } = await reconcileActive(tx, user.id, now);
      // reconcile may have JUST completed the session naturally — that
      // completion commits with this transaction, and the 409's details.state
      // (assembled from a fresh read) carries the new terminal reality.
      if (active === null) {
        return {
          activeAfter: null,
          completed,
          cancelled: null,
          conflict: conflict("no_active_session", NO_ACTIVE_MESSAGE),
          activeHash: null as string | null,
        };
      }
      const stale = revisionConflict(active, guard.baseRevision);
      if (stale !== null) {
        return { activeAfter: active, completed, cancelled: null, conflict: stale, activeHash: await sessionBaseHash(tx, user.id, active.id) };
      }
      const proved = hashConflict(await syncWriteFenced(tx, user.id), guard.baseHash, (await sessionBaseHash(tx, user.id, active.id)) ?? "");
      if (proved) return { activeAfter: active, completed, cancelled: null, conflict: proved, activeHash: await sessionBaseHash(tx, user.id, active.id) };
      const stopped = await writeTransition(tx, user.id, "stop", active, now);
      if (!stopped) {
        return {
          activeAfter: active,
          completed,
          cancelled: null,
          conflict: conflict("revision_conflict", "session changed during stop"),
          activeHash: await sessionBaseHash(tx, user.id, active.id),
        };
      }
      return { activeAfter: null, completed, cancelled: stopped, conflict: null, activeHash: null };
    });
    return finishTransition(ctx, user.id, now, outcome);
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
      const user = await ctx.auth.requireUser(request);
      const { items, total } = await listSessions(ctx.database, user.id, {
        limit: request.query.limit ?? 20,
        offset: request.query.offset ?? 0,
      });
      return { items: items.map(toHistoryItem), total };
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/sessions/:id", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const sessionId = request.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      throw new AppError(400, "validation_error", "session id must be a UUID");
    }
    const row = await findTerminalSession(db, user.id, sessionId);
    if (row === null) throw new AppError(404, "not_found", "focus session not found");
    return toHistoryItem(row);
  });

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
      const user = await ctx.auth.requireUser(request);
      return focusStats(ctx, user.id, request.query.days ?? 7);
    },
  );

  ctx.api.get("/settings", async (request) => {
    const user = await ctx.auth.requireUser(request);
    return settingsProof(ctx.database, user.id);
  });

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
            baseHash: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const user = await ctx.auth.requireUser(request);
      const presented = readPresentedHash((request.body as { baseHash?: unknown }).baseHash);
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
      return ctx.database.withTransaction(async (tx) => {
        await lockOwnedTables(tx, ["focus.settings"]);
        await lockOwnerSet(tx, user.id, "focus.settings");
        const { rows } = await tx.query<{ snapshot: string }>(
          "SELECT row_to_json(s)::text AS snapshot FROM focus.settings s WHERE id = $1 AND user_id = $2 FOR UPDATE",
          ["current", user.id],
        );
        const actual = rows[0]
          ? editorBaseHash([{ table: "focus.settings", row: parseSnapshotRow(rows[0].snapshot) }])
          : singletonBaseHash("focus.settings", { id: "current", value: DEFAULT_SETTINGS });
        assertPresentedHash(await syncWriteFenced(tx, user.id), presented, actual);
        await saveSettings(tx, user.id, settings);
        return settingsProof(tx, user.id);
      });
    },
  );
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, healthcheck, registerAgent };
export default app;
