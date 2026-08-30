import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import focusApp from "../../src/apps/focus/index.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { runMigrations } from "../../src/core/database/migrate.js";

/**
 * Focus app integration tests (APP-1 F05) — the full §24 case matrix against
 * a real PostgreSQL with a MUTABLE fixed clock: every time-sensitive assertion
 * is computed from whole-second literals, so nothing depends on when CI runs.
 *
 * The clock is `now` reassigned in-place (`clock = () => now`), tests advance
 * it by whole seconds; the platform is rebuilt against the same database for
 * the restart-recovery cases. Counting tests start each `it` from empty
 * focus.sessions/focus.settings (the timezone.test.ts clearTasks precedent).
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const migrationsDir = join(repoRoot, "apps", "focus", "migrations");
const focusMigrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name), "utf8"));

// ---------------------------------------------------------------------------
// mutable clock — the backbone of every time-sensitive assertion
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-08-30T08:00:00Z");
let now = new Date(T0);
const clock = () => now;

/** ISO string of T0 + `seconds` (whole-second literals only). */
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
/** Jump the clock to an absolute epoch-ms value. */
function setNow(ms: number): void {
  now = new Date(ms);
}
/** Advance the clock by whole seconds. */
function advance(seconds: number): void {
  now = new Date(now.getTime() + seconds * 1000);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// ---------------------------------------------------------------------------
// response shapes (camelCase API contract of the focus module)
// ---------------------------------------------------------------------------

type Kind = "focus" | "short_break" | "long_break";

interface ActiveView {
  id: string;
  kind: Kind;
  status: "running" | "paused";
  plannedDurationSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  expectedEndAt: string | null;
  startedAt: string;
  pausedAt: string | null;
  revision: number;
}

interface FocusState {
  now: string;
  active: ActiveView | null;
  today: { focusedSeconds: number; completedRounds: number; sessionsEnded: number };
  nextKind: Kind;
  settings: {
    focusDurationSeconds: number;
    shortBreakDurationSeconds: number;
    longBreakDurationSeconds: number;
    longBreakInterval: number;
  };
}

interface TransitionBody {
  state: FocusState;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: { state: FocusState };
  };
}

interface HistoryItem {
  id: string;
  kind: Kind;
  status: "completed" | "cancelled";
  plannedDurationSeconds: number;
  actualDurationSeconds: number | null;
  startedAt: string;
  endedAt: string | null;
  endReason: "natural" | "manual_stop" | null;
}

interface HistoryBody {
  items: HistoryItem[];
  total: number;
}

interface StatsDay {
  date: string;
  focusedSeconds: number;
  completedRounds: number;
}

interface StatsBody {
  timezone: string;
  days: StatsDay[];
  totals: { focusedSeconds: number; completedRounds: number };
}

const DEFAULT_SETTINGS = {
  focusDurationSeconds: 1500,
  shortBreakDurationSeconds: 300,
  longBreakDurationSeconds: 900,
  longBreakInterval: 4,
};

// ---------------------------------------------------------------------------
// fixture lifecycle
// ---------------------------------------------------------------------------

let db: Database;
let platform: Platform;
/** LIFO list of fixture cleanups (each restart adds one; only env restore). */
const cleanups: Array<() => void> = [];

before(async () => {
  db = await resetDatabase();
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "focus", migrations: focusMigrations }],
    backendModules: { focus: focusApp },
    clock,
  });
  platform = fixture.platform;
  cleanups.push(fixture.cleanup);
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "focus", schema: "focus", dir: join(fixture.root, "apps", "focus", "migrations") }],
  });
  // Deterministic timezone baseline (resetDatabase wiped core.settings, so the
  // platform already defaulted to UTC — make that explicit).
  await putTimezone("UTC");
});

after(async () => {
  if (platform) await platform.stop();
  for (const cleanup of cleanups.reverse()) cleanup();
  if (db) await db.close();
});

/** Simulate a platform restart: same database, same clock closure, new instance. */
async function rebuildPlatform(): Promise<void> {
  await platform.stop();
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "focus", migrations: focusMigrations }],
    backendModules: { focus: focusApp },
    clock,
  });
  platform = fixture.platform;
  cleanups.push(fixture.cleanup);
}

/** Counting tests assert absolute numbers; start each from empty tables. */
async function resetFocusData(): Promise<void> {
  await db.context().query("DELETE FROM focus.sessions");
  await db.context().query("DELETE FROM focus.settings");
}

async function putTimezone(value: string): Promise<void> {
  const response = await platform.app.inject({
    method: "PUT",
    url: "/api/core/settings/platform.timezone",
    payload: { value },
  });
  assert.equal(response.statusCode, 200, `platform.timezone=${value} must be accepted`);
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

function api(method: "GET" | "POST" | "PUT", url: string, body?: object) {
  return platform.app.inject({ method, url: `/api/apps/focus${url}`, payload: body });
}

async function getBody<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await api("GET", url);
  return { status: response.statusCode, body: response.json() as T };
}

/**
 * POST helper. Body-less POSTs are sent as `{}`: Fastify 5 validates an absent
 * body against the route's object schema and would 400 before the handler's
 * `request.body ?? {}` nullish-safe read ever runs — `{}` is the legitimate
 * "no fields" client payload.
 */
async function postBody<T>(url: string, body: object = {}): Promise<{ status: number; body: T }> {
  const response = await api("POST", url, body);
  return { status: response.statusCode, body: response.json() as T };
}

async function getState(): Promise<FocusState> {
  const { status, body } = await getBody<FocusState>("/state");
  assert.equal(status, 200);
  return body;
}

async function history(query = ""): Promise<HistoryBody> {
  const { status, body } = await getBody<HistoryBody>(`/sessions${query}`);
  assert.equal(status, 200);
  return body;
}

/**
 * Start a session of `planned` seconds at the CURRENT clock and let it run out:
 * advance past the planned end, then GET /state so reconcile commits the
 * natural completion. endedAt lands exactly on start + planned.
 */
async function runToCompletion(kind: Kind, planned: number): Promise<void> {
  const { status } = await postBody("/start", { kind, plannedDurationSeconds: planned });
  assert.equal(status, 201);
  advance(planned + 1);
  const state = await getState();
  assert.equal(state.active, null, `${kind} session must complete naturally`);
}

// ---------------------------------------------------------------------------
// §24.1-7 state machine transitions
// ---------------------------------------------------------------------------

describe("state machine transitions (APP-1 §24.1-7)", () => {
  beforeEach(async () => {
    await resetFocusData();
    now = new Date(T0);
  });

  it("idle: GET /state reports no active session, zero stats, next kind focus", async () => {
    const state = await getState();
    assert.equal(state.now, at(0));
    assert.equal(state.active, null);
    assert.deepEqual(state.today, { focusedSeconds: 0, completedRounds: 0, sessionsEnded: 0 });
    assert.equal(state.nextKind, "focus");
    assert.deepEqual(state.settings, DEFAULT_SETTINGS);
  });

  it("idle -> start: 201 with running session, planned from settings, exact expectedEndAt, revision 1", async () => {
    const { status, body } = await postBody<TransitionBody>("/start", { kind: "focus" });
    assert.equal(status, 201);
    const active = body.state.active!;
    assert.equal(active.kind, "focus");
    assert.equal(active.status, "running");
    assert.equal(active.plannedDurationSeconds, 1500, "planned comes from settings defaults");
    assert.equal(active.startedAt, at(0));
    assert.equal(active.expectedEndAt, at(1500), "expectedEndAt is exactly now + planned");
    assert.equal(active.elapsedSeconds, 0);
    assert.equal(active.remainingSeconds, 1500);
    assert.equal(active.pausedAt, null);
    assert.equal(active.revision, 1);
    assert.equal(body.state.nextKind, "focus", "nextKind mirrors the active kind");
  });

  it("running -> pause: freezes elapsed, clears expectedEndAt, bumps revision", async () => {
    assert.equal((await postBody("/start", { kind: "focus" })).status, 201);
    advance(10);
    const { status, body } = await postBody<TransitionBody>("/pause");
    assert.equal(status, 200);
    const active = body.state.active!;
    assert.equal(active.status, "paused");
    assert.equal(active.elapsedSeconds, 10, "10s of running time is folded in");
    assert.equal(active.remainingSeconds, 1490);
    assert.equal(active.expectedEndAt, null, "a paused session has no predictable end");
    assert.equal(active.pausedAt, at(10));
    assert.equal(active.startedAt, at(0), "startedAt never moves");
    assert.equal(active.revision, 2);
  });

  it("paused -> resume: expectedEndAt = resume_now + remaining, revision +1", async () => {
    await postBody("/start", { kind: "focus" });
    advance(10);
    await postBody("/pause");
    advance(90); // paused time must not shift the remaining budget
    const { status, body } = await postBody<TransitionBody>("/resume");
    assert.equal(status, 200);
    const active = body.state.active!;
    assert.equal(active.status, "running");
    assert.equal(active.revision, 3);
    assert.equal(active.elapsedSeconds, 10, "still just the pre-pause 10s at the resume instant");
    assert.equal(active.expectedEndAt, at(100 + 1490), "resume_now (T0+100s) + remaining 1490s");
    assert.equal(active.pausedAt, at(10), "pausedAt is preserved as history");
  });

  it("body-less transition POSTs are valid optimistic requests", async () => {
    await postBody("/start", { kind: "focus" });
    // No payload at all: a client retry or plain curl must not trip validation.
    const bare = await platform.app.inject({ method: "POST", url: "/api/apps/focus/pause" });
    assert.equal(bare.statusCode, 200);
    assert.equal((bare.json() as TransitionBody).state.active!.status, "paused");
    const bareStop = await platform.app.inject({ method: "POST", url: "/api/apps/focus/stop" });
    assert.equal(bareStop.statusCode, 200);
    const rejected = await platform.app.inject({
      method: "POST",
      url: "/api/apps/focus/start",
      payload: { kind: "focus", baseRevision: "not-a-number" },
    });
    assert.equal(rejected.statusCode, 400);
  });

  it("running -> natural completion: endedAt is the planned end, not the read instant", async () => {
    assert.equal((await postBody("/start", { kind: "focus", plannedDurationSeconds: 60 })).status, 201);
    advance(61); // one second past the planned end
    const state = await getState();
    assert.equal(state.active, null);
    assert.deepEqual(state.today, { focusedSeconds: 60, completedRounds: 1, sessionsEnded: 1 });
    assert.equal(state.nextKind, "short_break");

    const list = await history();
    assert.equal(list.total, 1);
    const row = list.items[0]!;
    assert.equal(row.status, "completed");
    assert.equal(row.endReason, "natural");
    assert.equal(row.plannedDurationSeconds, 60);
    assert.equal(row.actualDurationSeconds, 60);
    assert.equal(row.startedAt, at(0));
    assert.equal(row.endedAt, at(60), "endedAt == expectedEndAt, not the GET /state moment");
    assert.notEqual(row.endedAt, state.now);
  });

  it("running -> stop: actual is elapsed at stop, cancelled, focused seconds count, rounds do not", async () => {
    assert.equal((await postBody("/start", { kind: "focus" })).status, 201);
    advance(30);
    const { status, body } = await postBody<TransitionBody>("/stop");
    assert.equal(status, 200);
    assert.equal(body.state.active, null);

    const row = (await history()).items[0]!;
    assert.equal(row.status, "cancelled");
    assert.equal(row.endReason, "manual_stop");
    assert.equal(row.actualDurationSeconds, 30, "actual == elapsed at the stop instant");
    assert.equal(row.endedAt, at(30));

    const state = await getState();
    assert.deepEqual(state.today, { focusedSeconds: 30, completedRounds: 0, sessionsEnded: 1 });
    assert.equal(state.nextKind, "focus", "a cancelled round does not advance the schedule");
  });

  it("paused -> stop: actual is the frozen elapsedBeforePause value", async () => {
    await postBody("/start", { kind: "focus" });
    advance(20);
    await postBody("/pause"); // elapsed frozen at 20
    advance(100); // none of this may leak into the stopped session
    const { status } = await postBody("/stop");
    assert.equal(status, 200);
    const row = (await history()).items[0]!;
    assert.equal(row.status, "cancelled");
    assert.equal(row.actualDurationSeconds, 20, "paused time is not counted");
    assert.equal(row.endedAt, at(120), "endedAt is the stop instant");
  });

  it("multi-round pause/resume accounting: 25min plan completes with actual 1500", async () => {
    // start (rev 1) -> run 10min -> pause (rev 2) -> idle 5min (not counted)
    // -> resume (rev 3) -> run 8min -> pause (rev 4) -> resume (rev 5)
    // -> run past expiry -> natural completion (rev 6 in the DB).
    assert.equal((await postBody("/start", { kind: "focus" })).status, 201);
    let revisions: number[] = [(await getState()).active!.revision];

    advance(600); // 10 minutes of running
    const pause1 = (await postBody<TransitionBody>("/pause")).body.state.active!;
    assert.equal(pause1.elapsedSeconds, 600);
    assert.equal(pause1.remainingSeconds, 900);
    assert.equal(pause1.revision, 2);
    revisions.push(pause1.revision);

    advance(300); // 5 minutes paused — accrues nothing
    const midPause = await getState();
    assert.equal(midPause.active!.elapsedSeconds, 600, "paused time is frozen");

    const resume1 = (await postBody<TransitionBody>("/resume")).body.state.active!;
    assert.equal(resume1.status, "running");
    assert.equal(resume1.expectedEndAt, at(900 + 900), "T0+900s resume + 900s remaining");
    assert.equal(resume1.revision, 3);
    revisions.push(resume1.revision);

    advance(480); // 8 more minutes of running
    const pause2 = (await postBody<TransitionBody>("/pause")).body.state.active!;
    assert.equal(pause2.elapsedSeconds, 1080, "600 + 480");
    assert.equal(pause2.remainingSeconds, 420);
    assert.equal(pause2.revision, 4);
    revisions.push(pause2.revision);

    advance(60);
    const resume2 = (await postBody<TransitionBody>("/resume")).body.state.active!;
    assert.equal(resume2.expectedEndAt, at(1440 + 420), "T0+1440s resume + 420s remaining");
    assert.equal(resume2.revision, 5);
    revisions.push(resume2.revision);

    advance(421); // past resume2's planned end
    const state = await getState();
    assert.equal(state.active, null, "expired during the final running segment");
    assert.deepEqual(state.today, { focusedSeconds: 1500, completedRounds: 1, sessionsEnded: 1 });

    const row = (await history()).items[0]!;
    assert.equal(row.status, "completed");
    assert.equal(row.endReason, "natural");
    assert.equal(row.actualDurationSeconds, 1500, "full planned time across three running segments");
    assert.equal(row.endedAt, at(1860), "the final expectedEndAt, exactly");

    for (let i = 1; i < revisions.length; i++) {
      assert.equal(revisions[i], revisions[i - 1]! + 1, "every step bumps revision by exactly 1");
    }
    const stored = await db
      .context()
      .query<{ revision: number }>("SELECT revision FROM focus.sessions ORDER BY started_at DESC LIMIT 1");
    assert.equal(stored.rows[0]!.revision, 6, "natural completion bumped revision to 6");
  });
});

// ---------------------------------------------------------------------------
// §24.8-14 concurrency and idempotency
// ---------------------------------------------------------------------------

describe("concurrency and idempotency (APP-1 §24.8-14)", () => {
  beforeEach(async () => {
    await resetFocusData();
    now = new Date(T0);
  });

  it("double start: second request gets 409 session_already_active with details.state.active", async () => {
    const first = await postBody<TransitionBody>("/start", { kind: "focus" });
    assert.equal(first.status, 201);
    const second = await postBody<ErrorBody>("/start", { kind: "focus" });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "session_already_active");
    const active = second.body.error.details!.state.active;
    assert.ok(active, "details.state carries the active session");
    assert.equal(active!.id, first.body.state.active!.id);
  });

  it("double pause without baseRevision: second is a 200 no-op (same revision, same pausedAt)", async () => {
    await postBody("/start", { kind: "focus" });
    advance(5);
    const first = (await postBody<TransitionBody>("/pause")).body.state.active!;
    const second = (await postBody<TransitionBody>("/pause")).body;
    assert.equal(second.state.active!.status, "paused");
    assert.equal(second.state.active!.revision, first.revision, "idempotent pause does not bump revision");
    assert.equal(second.state.active!.pausedAt, first.pausedAt);
    assert.equal(second.state.active!.elapsedSeconds, first.elapsedSeconds);
  });

  it("double pause with stale baseRevision: 409 revision_conflict with details.state", async () => {
    await postBody("/start", { kind: "focus" });
    const first = await postBody<TransitionBody>("/pause", { baseRevision: 1 });
    assert.equal(first.status, 200);
    assert.equal(first.body.state.active!.revision, 2);

    const stale = await postBody<ErrorBody>("/pause", { baseRevision: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "revision_conflict");
    assert.equal(stale.body.error.details!.state.active!.revision, 2, "state is the authoritative row");
  });

  it("double resume: idempotent 200 without revision bump; stale baseRevision 409", async () => {
    await postBody("/start", { kind: "focus" });
    await postBody("/pause");
    const resume1 = await postBody<TransitionBody>("/resume");
    assert.equal(resume1.status, 200);
    assert.equal(resume1.body.state.active!.revision, 3);

    const resume2 = await postBody<TransitionBody>("/resume");
    assert.equal(resume2.status, 200, "already running -> idempotent success");
    assert.equal(resume2.body.state.active!.revision, 3);
    assert.equal(resume2.body.state.active!.expectedEndAt, resume1.body.state.active!.expectedEndAt);

    // Pause with the CURRENT revision (3), then resume carrying the stale 3.
    const pause = await postBody<TransitionBody>("/pause", { baseRevision: 3 });
    assert.equal(pause.status, 200);
    assert.equal(pause.body.state.active!.revision, 4);
    const stale = await postBody<ErrorBody>("/resume", { baseRevision: 3 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "revision_conflict");
    assert.ok(stale.body.error.details!.state.active);
  });

  it("stop with stale baseRevision: 409, session survives; correct revision stops it", async () => {
    assert.equal((await postBody("/start", { kind: "focus" })).status, 201);
    const stale = await postBody<ErrorBody>("/stop", { baseRevision: 99 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "revision_conflict");
    assert.ok((await getState()).active, "the stale stop did not touch the session");

    assert.equal((await postBody("/stop", { baseRevision: 1 })).status, 200);
    assert.equal((await getState()).active, null);
  });

  it("concurrent double start: exactly one 201 and one 409 (partial unique index wins)", async () => {
    const [a, b] = await Promise.all([
      api("POST", "/start", { kind: "focus" }),
      api("POST", "/start", { kind: "focus" }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [201, 409], "one winner, one conflict — never two of either");
    const loser = a.statusCode === 409 ? a : b;
    assert.equal(loser.json().error.code, "session_already_active");
    assert.equal((await getState()).active!.revision, 1, "exactly one active row exists");
  });

  it("stop after stop: 409 no_active_session with a null-active details.state", async () => {
    await postBody("/start", { kind: "focus" });
    assert.equal((await postBody("/stop")).status, 200);
    const again = await postBody<ErrorBody>("/stop");
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "no_active_session");
    assert.equal(again.body.error.details!.state.active, null);
  });
});

// ---------------------------------------------------------------------------
// §24.15-17 expiry and restart recovery
// ---------------------------------------------------------------------------

describe("expiry and recovery (APP-1 §24.15-17)", () => {
  beforeEach(async () => {
    await resetFocusData();
    now = new Date(T0);
  });

  it("unattended expiry: 2h later the session completed at its planned end with actual 30", async () => {
    assert.equal((await postBody("/start", { kind: "focus", plannedDurationSeconds: 30 })).status, 201);
    advance(2 * 60 * 60);
    const state = await getState();
    assert.equal(state.active, null);
    assert.deepEqual(state.today, {
      focusedSeconds: 30,
      completedRounds: 1,
      sessionsEnded: 1,
    }, "the unattended hour after expiry never counts");
    const row = (await history()).items[0]!;
    assert.equal(row.status, "completed");
    assert.equal(row.endReason, "natural");
    assert.equal(row.actualDurationSeconds, 30);
    assert.equal(row.endedAt, at(30), "endedAt is still start + 30s, not the wake-up instant");
  });

  it("platform restart mid-running: active state continues exactly where it stopped", async () => {
    assert.equal((await postBody("/start", { kind: "focus", plannedDurationSeconds: 600 })).status, 201);
    advance(100);
    const before = (await getState()).active!;

    await rebuildPlatform();

    const after = (await getState()).active!;
    assert.equal(after.id, before.id);
    assert.equal(after.status, "running");
    assert.equal(after.startedAt, before.startedAt);
    assert.equal(after.elapsedSeconds, 100, "elapsed is derived, never stored — restart loses nothing");
    assert.equal(after.remainingSeconds, 500);
    assert.equal(after.expectedEndAt, at(600));
    assert.equal(after.revision, 1);

    advance(501); // past the pre-restart planned end
    const state = await getState();
    assert.equal(state.active, null, "post-restart reconcile completes the expired session");
    const row = (await history()).items[0]!;
    assert.equal(row.actualDurationSeconds, 600);
    assert.equal(row.endedAt, at(600));
    assert.deepEqual(state.today, { focusedSeconds: 600, completedRounds: 1, sessionsEnded: 1 });
  });

  it("platform restart mid-paused: frozen values survive; resume then works", async () => {
    now = new Date(T0 + 60 * MINUTE);
    assert.equal((await postBody("/start", { kind: "focus", plannedDurationSeconds: 600 })).status, 201);
    advance(50);
    assert.equal((await postBody("/pause")).status, 200);
    const before = (await getState()).active!;

    await rebuildPlatform();

    const after = (await getState()).active!;
    assert.equal(after.id, before.id);
    assert.equal(after.status, "paused");
    assert.equal(after.elapsedSeconds, 50, "frozen at the pause");
    assert.equal(after.remainingSeconds, 550);
    assert.equal(after.expectedEndAt, null);
    assert.equal(after.pausedAt, before.pausedAt);
    assert.equal(after.revision, 2);

    advance(10); // resume at T0 + 61min exactly (60min offset + 50s run + 10s paused)
    const resume = await postBody<TransitionBody>("/resume");
    assert.equal(resume.status, 200, "transitions work on the rebuilt platform");
    assert.equal(
      resume.body.state.active!.expectedEndAt,
      new Date(T0 + 61 * MINUTE + 550 * SECOND).toISOString(),
      "resume_now (T0+61min) + 550s remaining",
    );
    assert.equal((await postBody("/stop")).status, 200);
  });

  it("long pause then resume: remaining continues from the frozen point", async () => {
    assert.equal((await postBody("/start", { kind: "focus" })).status, 201);
    advance(30);
    await postBody("/pause");
    advance(3 * 24 * 60 * 60); // three days paused

    const resume = (await postBody<TransitionBody>("/resume")).body.state.active!;
    assert.equal(resume.elapsedSeconds, 30);
    const resumeMs = now.getTime();
    assert.equal(resume.expectedEndAt, new Date(resumeMs + 1470 * SECOND).toISOString(), "resume_now + 1470s remaining — the 3 paused days are excluded");

    advance(1471);
    assert.equal((await getState()).active, null);
    const row = (await history()).items[0]!;
    assert.equal(row.status, "completed");
    assert.equal(row.actualDurationSeconds, 1500);
    assert.equal(row.endedAt, new Date(resumeMs + 1470 * SECOND).toISOString());
  });
});

// ---------------------------------------------------------------------------
// §24.18-20 timezone-aware statistics
// ---------------------------------------------------------------------------

describe("timezone-aware statistics (APP-1 §24.18-20)", () => {
  beforeEach(async () => {
    await resetFocusData();
  });

  it("Asia/Shanghai today boundary: local 23:59:59 vs next-day 00:00:01 bucket apart", async () => {
    await putTimezone("Asia/Shanghai");
    // Session A ends 2026-08-30 15:59:59Z == local 23:59:59 (last second of Aug 30).
    setNow(Date.parse("2026-08-30T15:57:59Z"));
    await runToCompletion("focus", 120);
    // Session B ends 2026-08-30 16:00:01Z == local 00:00:01 on Aug 31.
    setNow(Date.parse("2026-08-30T15:59:01Z"));
    await runToCompletion("focus", 60);

    setNow(Date.parse("2026-08-30T17:00:00Z")); // local 01:00 on Aug 31
    const state = await getState();
    assert.deepEqual(
      state.today,
      { focusedSeconds: 60, completedRounds: 1, sessionsEnded: 1 },
      "only session B ended inside Shanghai's Aug 31",
    );

    const stats = (await getBody<StatsBody>("/stats?days=2")).body;
    assert.equal(stats.timezone, "Asia/Shanghai");
    assert.deepEqual(stats.days, [
      { date: "2026-08-30", focusedSeconds: 120, completedRounds: 1 },
      { date: "2026-08-31", focusedSeconds: 60, completedRounds: 1 },
    ]);
    assert.deepEqual(stats.totals, { focusedSeconds: 180, completedRounds: 2 });
  });

  it("America/New_York DST fall-back: the repeated local hour buckets without loss or duplication", async () => {
    await putTimezone("America/New_York");
    // 2026-11-01: 2:00 AM EDT falls back to 1:00 AM EST at 06:00Z.
    // A ends 05:31Z (local 01:30 EDT, before the jump).
    setNow(Date.parse("2026-11-01T05:30:00Z"));
    await runToCompletion("focus", 60);
    // B ends 06:31Z (local 01:30 EST — the SAME wall clock, second pass).
    setNow(Date.parse("2026-11-01T06:30:00Z"));
    await runToCompletion("focus", 60);
    // C ends on the next local day.
    setNow(Date.parse("2026-11-02T05:00:00Z"));
    await runToCompletion("focus", 60);

    setNow(Date.parse("2026-11-02T12:00:00Z")); // local 07:00 EST on Nov 2
    const stats = (await getBody<StatsBody>("/stats?days=3")).body;
    const dates = stats.days.map((day) => day.date);
    assert.equal(dates.length, 3);
    assert.equal(new Set(dates).size, 3, "no duplicated calendar days");
    assert.deepEqual(
      stats.days,
      [
        { date: "2026-10-31", focusedSeconds: 0, completedRounds: 0 },
        { date: "2026-11-01", focusedSeconds: 120, completedRounds: 2 },
        { date: "2026-11-02", focusedSeconds: 60, completedRounds: 1 },
      ],
      "both passes of the repeated 01:30 hour land on Nov 1 — neither lost nor split",
    );

    const state = await getState();
    assert.deepEqual(
      state.today,
      { focusedSeconds: 60, completedRounds: 1, sessionsEnded: 1 },
      "New York's Nov 2 day ([05:00Z, 05:00Z+24h)) contains only session C",
    );
  });

  it("stats: 3 days of history, zero-fill, totals, and days=1..90 bounds", async () => {
    await putTimezone("UTC");
    // Aug 28: two completed focus rounds (600 + 300).
    setNow(Date.parse("2026-08-28T10:00:00Z"));
    await runToCompletion("focus", 600);
    setNow(Date.parse("2026-08-28T12:00:00Z"));
    await runToCompletion("focus", 300);
    // Aug 29: nothing at all (zero-fill day).
    // Aug 30: one CANCELLED focus round — focused seconds yes, completed round no.
    setNow(Date.parse("2026-08-30T09:00:00Z"));
    assert.equal((await postBody("/start", { kind: "focus", plannedDurationSeconds: 600 })).status, 201);
    advance(120);
    assert.equal((await postBody("/stop")).status, 200);

    setNow(Date.parse("2026-08-30T20:00:00Z"));
    const stats = (await getBody<StatsBody>("/stats?days=3")).body;
    assert.equal(stats.timezone, "UTC");
    assert.deepEqual(stats.days, [
      { date: "2026-08-28", focusedSeconds: 900, completedRounds: 2 },
      { date: "2026-08-29", focusedSeconds: 0, completedRounds: 0 },
      { date: "2026-08-30", focusedSeconds: 120, completedRounds: 0 },
    ]);
    assert.deepEqual(stats.totals, { focusedSeconds: 1020, completedRounds: 2 });

    const one = (await getBody<StatsBody>("/stats?days=1")).body;
    assert.deepEqual(one.days, [{ date: "2026-08-30", focusedSeconds: 120, completedRounds: 0 }]);

    const ninety = (await getBody<StatsBody>("/stats?days=90")).body;
    assert.equal(ninety.days.length, 90);
    const expectedFirst = new Date(Date.parse("2026-08-30T00:00:00Z") - 89 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(ninety.days[0]!.date, expectedFirst, "window ends on today, inclusive");

    for (const bad of [0, 91]) {
      const { status, body } = await getBody<ErrorBody>(`/stats?days=${bad}`);
      assert.equal(status, 400, `days=${bad} rejected`);
      assert.equal(body.error.code, "validation_error");
    }
  });
});

// ---------------------------------------------------------------------------
// §24.21 pomodoro cycle (nextKind)
// ---------------------------------------------------------------------------

describe("pomodoro cycle nextKind (APP-1 §24.21)", () => {
  beforeEach(async () => {
    await resetFocusData();
    now = new Date(T0);
  });

  it("full cycle: focus x interval -> long_break -> reset; cancelled breaks do not advance", async () => {
    assert.equal((await getState()).nextKind, "focus", "no history -> focus");

    await runToCompletion("focus", 10);
    assert.equal((await getState()).nextKind, "short_break", "first completed focus -> short break");

    // A cancelled break must not disturb the cycle position.
    assert.equal((await postBody("/start", { kind: "short_break", plannedDurationSeconds: 10 })).status, 201);
    advance(4);
    assert.equal((await postBody("/stop")).status, 200);
    assert.equal((await getState()).nextKind, "short_break", "cancelled break changes nothing");

    await runToCompletion("focus", 10);
    assert.equal((await getState()).nextKind, "short_break");
    await runToCompletion("focus", 10);
    assert.equal((await getState()).nextKind, "short_break", "interval-1 completed focus -> still short break");

    await runToCompletion("focus", 10);
    assert.equal((await getState()).nextKind, "long_break", "the interval-th completed focus -> long break");

    await runToCompletion("long_break", 10);
    assert.equal((await getState()).nextKind, "focus", "a completed long break resets the counter");
  });

  it("longBreakInterval=2 applies immediately", async () => {
    const put = await api("PUT", "/settings", {
      focusDurationSeconds: 1500,
      shortBreakDurationSeconds: 300,
      longBreakDurationSeconds: 900,
      longBreakInterval: 2,
    });
    assert.equal(put.statusCode, 200);

    await runToCompletion("focus", 10);
    assert.equal((await getState()).nextKind, "short_break");
    await runToCompletion("focus", 10);
    assert.equal((await getState()).nextKind, "long_break", "interval 2 promotes after two rounds");
  });
});

// ---------------------------------------------------------------------------
// §24.22 settings
// ---------------------------------------------------------------------------

describe("settings (APP-1 §24.22)", () => {
  beforeEach(async () => {
    await resetFocusData();
    now = new Date(T0);
  });

  it("GET returns the defaults 1500/300/900/4", async () => {
    const { status, body } = await getBody<FocusState["settings"]>("/settings");
    assert.equal(status, 200);
    assert.deepEqual(body, DEFAULT_SETTINGS);
  });

  it("PUT round-trips valid settings; start uses the new default and an explicit planned overrides it", async () => {
    const next = {
      focusDurationSeconds: 1800,
      shortBreakDurationSeconds: 600,
      longBreakDurationSeconds: 1200,
      longBreakInterval: 3,
    };
    const put = await api("PUT", "/settings", next);
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json(), next);
    assert.deepEqual((await getBody<FocusState["settings"]>("/settings")).body, next);

    const defaultStart = (await postBody<TransitionBody>("/start", { kind: "focus" })).body.state.active!;
    assert.equal(defaultStart.plannedDurationSeconds, 1800, "start picks up the stored default");
    assert.equal((await postBody("/stop")).status, 200);

    const explicit = (await postBody<TransitionBody>("/start", { kind: "focus", plannedDurationSeconds: 60 }))
      .body.state.active!;
    assert.equal(explicit.plannedDurationSeconds, 60, "explicit plannedDurationSeconds wins over the default");
    assert.equal((await postBody("/stop")).status, 200);
  });

  it("rejects out-of-range settings with 400 validation_error", async () => {
    const base = { ...DEFAULT_SETTINGS };
    const cases = [
      { ...base, focusDurationSeconds: 0 },
      { ...base, focusDurationSeconds: 86401 },
      { ...base, longBreakInterval: 1 },
    ];
    for (const bad of cases) {
      const response = await api("PUT", "/settings", bad);
      assert.equal(response.statusCode, 400, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(response.json().error.code, "validation_error");
    }
    // Nothing was persisted along the way.
    assert.deepEqual((await getBody<FocusState["settings"]>("/settings")).body, DEFAULT_SETTINGS);
  });
});

// ---------------------------------------------------------------------------
// §24.23 sessions pagination
// ---------------------------------------------------------------------------

describe("sessions history pagination (APP-1 §24.23)", () => {
  beforeEach(async () => {
    await resetFocusData();
    // Five cancelled focus sessions, started 10 minutes apart from T0.
    for (let i = 0; i < 5; i++) {
      setNow(T0 + i * 10 * MINUTE);
      assert.equal((await postBody("/start", { kind: "focus", plannedDurationSeconds: 600 })).status, 201);
      advance(30);
      assert.equal((await postBody("/stop")).status, 200);
    }
    setNow(T0 + 2 * 60 * MINUTE);
  });

  it("paginates limit/offset/total correctly in started_at DESC order", async () => {
    const page0 = await history("?limit=2&offset=0");
    const page1 = await history("?limit=2&offset=2");
    const page2 = await history("?limit=2&offset=4");
    for (const page of [page0, page1, page2]) {
      assert.equal(page.total, 5, "total is the unpaginated count on every page");
    }
    assert.deepEqual(page0.items.map((item) => item.startedAt), [at(2400), at(1800)]);
    assert.deepEqual(page1.items.map((item) => item.startedAt), [at(1200), at(600)]);
    assert.deepEqual(page2.items.map((item) => item.startedAt), [at(0)]);

    const all = [...page0.items, ...page1.items, ...page2.items];
    assert.equal(new Set(all.map((item) => item.id)).size, 5, "pages are disjoint");
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1]!.startedAt > all[i]!.startedAt, "globally newest first");
    }
  });
});

// ---------------------------------------------------------------------------
// §24.24 409 details.state shape
// ---------------------------------------------------------------------------

describe("409 details.state self-heal snapshot (APP-1 §24.24)", () => {
  it("carries now/active/today/nextKind/settings in full", async () => {
    await resetFocusData();
    now = new Date(T0);
    const first = await postBody<TransitionBody>("/start", { kind: "focus" });
    assert.equal(first.status, 201);

    const second = await postBody<ErrorBody>("/start", { kind: "focus" });
    assert.equal(second.status, 409);
    assert.ok(second.body.error.requestId);

    const state = second.body.error.details!.state;
    assert.deepEqual(
      Object.keys(state).sort(),
      ["active", "nextKind", "now", "settings", "today"],
      "the exact FocusState shape a client self-heals from",
    );
    assert.equal(state.now, at(0));
    assert.ok(!Number.isNaN(Date.parse(state.now)));
    assert.equal(state.active!.id, first.body.state.active!.id);
    assert.equal(state.active!.status, "running");
    assert.deepEqual(state.today, { focusedSeconds: 0, completedRounds: 0, sessionsEnded: 0 });
    assert.equal(state.nextKind, "focus");
    assert.deepEqual(state.settings, DEFAULT_SETTINGS);
  });
});
