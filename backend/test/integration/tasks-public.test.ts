import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import tasksApp from "../../src/apps/tasks/index.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { runMigrations } from "../../src/core/database/migrate.js";

/**
 * Tasks public status contract (`GET /api/apps/tasks/public/status`) — the
 * cross-app read surface Clock consumes (worklist PHASE8 §6). The matrix pins
 * current / next / remaining-today semantics including the explicit
 * `now == start_at` boundary: start-inclusive for current, strictly-future
 * for next, so a task can never be both.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const tasksMigrations = [
  readFileSync(join(repoRoot, "apps/tasks/migrations/20260101000001-init.sql"), "utf8"),
  readFileSync(join(repoRoot, "apps/tasks/migrations/20260829000002-start-priority.sql"), "utf8"),
];

/** 2026-08-31 11:26 UTC, Monday; default fixture timezone is UTC. */
const FIXED_NOW = new Date("2026-08-31T11:26:00.000Z");

interface PublicTaskView {
  id: string;
  title: string;
  startAt: string;
}

interface StatusBody {
  current: PublicTaskView | null;
  next: PublicTaskView | null;
  today: { remainingCount: number };
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  start_at: string | null;
  due_at: string | null;
}

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;

async function json<T>(
  method: "GET" | "POST",
  url: string,
  payload?: object,
): Promise<{ status: number; body: T }> {
  const response = await platform.app.inject({ method, url, payload });
  const raw = response.body;
  return { status: response.statusCode, body: (raw ? JSON.parse(raw) : null) as T };
}

/** Create a task directly against the app API (the public surface is read-only). */
async function createTask(body: object): Promise<TaskRow> {
  const response = await json<TaskRow>("POST", "/api/apps/tasks/tasks", body);
  assert.equal(response.status, 201, `fixture task created (${JSON.stringify(body)})`);
  return response.body;
}

async function fetchStatus(): Promise<StatusBody> {
  const response = await json<StatusBody>("GET", "/api/apps/tasks/public/status");
  assert.equal(response.status, 200);
  return response.body;
}

async function clearTasks(): Promise<void> {
  await db.context().query("DELETE FROM tasks.tasks");
}

before(async () => {
  db = await resetDatabase();
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "tasks", migrations: tasksMigrations }],
    backendModules: { tasks: tasksApp },
    clock: () => FIXED_NOW,
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "tasks", schema: "tasks", dir: join(root, "apps", "tasks", "migrations") }],
  });
});

after(async () => {
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

describe("tasks public status matrix", () => {
  it("empty store: everything is null and zero", async () => {
    await clearTasks();
    const status = await fetchStatus();
    assert.equal(status.current, null);
    assert.equal(status.next, null);
    assert.equal(status.today.remainingCount, 0);
  });

  it("only future tasks: next is the earliest start, no current", async () => {
    await clearTasks();
    const later = await createTask({ title: "Later", startAt: "2026-08-31T18:00:00Z", dueAt: "2026-08-31T19:00:00Z" });
    const sooner = await createTask({ title: "Sooner", startAt: "2026-08-31T12:30:00Z", dueAt: "2026-08-31T13:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current, null);
    assert.equal(status.next!.id, sooner.id, "earliest future start wins");
    assert.equal(status.next!.title, "Sooner");
    assert.equal(status.next!.startAt, "2026-08-31T12:30:00.000Z");
    // Both are due today, but `next` itself is excluded from remaining.
    assert.equal(status.today.remainingCount, 1, "later task counts as remaining");
    void later;
  });

  it("current task: started window without a due date", async () => {
    await clearTasks();
    const running = await createTask({ title: "Writing docs", startAt: "2026-08-31T10:02:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, running.id);
    assert.equal(status.current!.startAt, "2026-08-31T10:02:00.000Z");
    assert.equal(status.next, null);
    assert.equal(status.today.remainingCount, 0, "no due date → not part of today's count");
  });

  it("current + next + remaining together", async () => {
    await clearTasks();
    const running = await createTask({ title: "Deep work", startAt: "2026-08-31T09:00:00Z", dueAt: "2026-08-31T12:00:00Z" });
    const upcoming = await createTask({ title: "Review", startAt: "2026-08-31T14:00:00Z", dueAt: "2026-08-31T15:00:00Z" });
    await createTask({ title: "Chore A", dueAt: "2026-08-31T16:00:00Z" });
    await createTask({ title: "Chore B", dueAt: "2026-08-31T17:30:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, running.id);
    assert.equal(status.next!.id, upcoming.id);
    assert.equal(status.today.remainingCount, 2, "the two chores, excluding current and next");
  });

  it("now == start_at is current (start-inclusive), never next", async () => {
    await clearTasks();
    const boundary = await createTask({ title: "Boundary", startAt: "2026-08-31T11:26:00.000Z", dueAt: "2026-08-31T12:00:00Z" });
    const future = await createTask({ title: "After", startAt: "2026-08-31T11:26:00.001Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, boundary.id, "a task is current at exactly its start_at");
    assert.equal(status.next!.id, future.id, "one millisecond later is strictly future");
  });

  it("overlapping windows resolve to the most recently started task", async () => {
    await clearTasks();
    const earlier = await createTask({ title: "Long block", startAt: "2026-08-31T08:00:00Z" });
    const recent = await createTask({ title: "Late block", startAt: "2026-08-31T11:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, recent.id, "most recent start wins");
    void earlier;
  });

  it("a window whose due_at passed is no longer current", async () => {
    await clearTasks();
    await createTask({ title: "Stale window", startAt: "2026-08-31T08:00:00Z", dueAt: "2026-08-31T09:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current, null, "due_at already passed → not in progress");
    assert.equal(status.today.remainingCount, 1, "still due today → counted as remaining");
  });

  it("done tasks never appear, and unmarking brings them back", async () => {
    await clearTasks();
    const running = await createTask({ title: "Then done", startAt: "2026-08-31T10:00:00Z" });
    await platform.app.inject({
      method: "PATCH",
      url: `/api/apps/tasks/tasks/${running.id}`,
      payload: { status: "done" },
    });
    assert.equal((await fetchStatus()).current, null, "done tasks are excluded");
    await platform.app.inject({
      method: "PATCH",
      url: `/api/apps/tasks/tasks/${running.id}`,
      payload: { status: "todo" },
    });
    assert.equal((await fetchStatus()).current!.id, running.id, "reopened tasks count again");
  });

  it("cross-day tasks: next may be tomorrow; today count excludes other days", async () => {
    await clearTasks();
    const tomorrow = await createTask({ title: "Tomorrow run", startAt: "2026-09-01T08:00:00Z", dueAt: "2026-09-01T09:00:00Z" });
    await createTask({ title: "Yesterday leftovers", dueAt: "2026-08-30T23:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current, null);
    assert.equal(status.next!.id, tomorrow.id, "next can cross the day boundary");
    assert.equal(status.today.remainingCount, 0, "yesterday-due and tomorrow-due are not today");
  });

  it("tasks without start_at never become current or next", async () => {
    await clearTasks();
    await createTask({ title: "Undated", dueAt: "2026-08-31T18:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current, null);
    assert.equal(status.next, null);
    assert.equal(status.today.remainingCount, 1, "but an undated task due today still counts");
  });

  it("exposes only the contract fields (no leakage of internal columns)", async () => {
    await clearTasks();
    await createTask({ title: "Shape", startAt: "2026-08-31T10:00:00Z", dueAt: "2026-08-31T12:00:00Z", priority: 3 });
    const response = await json<StatusBody>("GET", "/api/apps/tasks/public/status");
    assert.deepEqual(Object.keys(response.body).sort(), ["current", "next", "today"]);
    assert.deepEqual(
      Object.keys(response.body.current!).sort(),
      ["id", "startAt", "title"],
      "public view is the minimal summary shape",
    );
  });
});
