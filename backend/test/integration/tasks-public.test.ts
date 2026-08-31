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
 * cross-app read surface Clock consumes. Frozen semantics (apps/tasks/README.md):
 *
 *   current = most recently started todo task with start_at <= now
 *             (now == start_at is current; due_at NEVER ends it — an overdue
 *             todo task stays current until it is done)
 *   next    = earliest todo task with start_at > now (strictly future)
 *   today.remainingCount = additional todo tasks starting later in the
 *             platform-local day, excluding next
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
  method: "GET" | "POST" | "PUT",
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

/** PUT /api/core/settings/platform.timezone applies live (timezone.test.ts precedent). */
async function setTimezone(value: string): Promise<void> {
  const response = await json<{ value: string }>("PUT", "/api/core/settings/platform.timezone", {
    value,
  });
  assert.equal(response.status, 200, `platform.timezone set to ${value}`);
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
  it("1. empty store: everything is null and zero", async () => {
    await clearTasks();
    const status = await fetchStatus();
    assert.equal(status.current, null);
    assert.equal(status.next, null);
    assert.equal(status.today.remainingCount, 0);
  });

  it("2. only future tasks: next is the earliest start, no current", async () => {
    await clearTasks();
    const later = await createTask({ title: "Later", startAt: "2026-08-31T18:00:00Z" });
    const sooner = await createTask({ title: "Sooner", startAt: "2026-08-31T12:30:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current, null);
    assert.equal(status.next!.id, sooner.id, "earliest future start wins");
    assert.equal(status.next!.title, "Sooner");
    assert.equal(status.next!.startAt, "2026-08-31T12:30:00.000Z");
    // Both start later today, but `next` itself is excluded from remaining.
    assert.equal(status.today.remainingCount, 1, "the later task counts as remaining");
    void later;
  });

  it("3. current task: started, no due date — todo keeps it current", async () => {
    await clearTasks();
    const running = await createTask({ title: "Writing docs", startAt: "2026-08-31T10:02:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, running.id);
    assert.equal(status.current!.startAt, "2026-08-31T10:02:00.000Z");
    assert.equal(status.next, null);
    assert.equal(status.today.remainingCount, 0, "nothing starts later today");
  });

  it("4. current + next + remaining together", async () => {
    await clearTasks();
    const running = await createTask({ title: "Deep work", startAt: "2026-08-31T09:00:00Z", dueAt: "2026-08-31T12:00:00Z" });
    const upcoming = await createTask({ title: "Review", startAt: "2026-08-31T14:00:00Z" });
    await createTask({ title: "Chore A", startAt: "2026-08-31T16:00:00Z" });
    await createTask({ title: "Chore B", startAt: "2026-08-31T17:30:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, running.id);
    assert.equal(status.next!.id, upcoming.id);
    assert.equal(status.today.remainingCount, 2, "the two later starts today, excluding next");
  });

  it("5. now == start_at is current (start-inclusive), never next", async () => {
    await clearTasks();
    const boundary = await createTask({ title: "Boundary", startAt: "2026-08-31T11:26:00.000Z" });
    const future = await createTask({ title: "After", startAt: "2026-08-31T11:26:00.001Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, boundary.id, "a task is current at exactly its start_at");
    assert.equal(status.next!.id, future.id, "one millisecond later is strictly future");
  });

  it("6. overlapping started tasks resolve to the most recently started one", async () => {
    await clearTasks();
    const earlier = await createTask({ title: "Long block", startAt: "2026-08-31T08:00:00Z" });
    const recent = await createTask({ title: "Late block", startAt: "2026-08-31T11:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, recent.id, "most recent start wins");
    void earlier;
  });

  it("7. an overdue todo task remains current (due_at never ends current)", async () => {
    await clearTasks();
    // Window nominally 08:00–09:00; now is 11:26 — long past due, still todo.
    const stale = await createTask({ title: "Stale window", startAt: "2026-08-31T08:00:00Z", dueAt: "2026-08-31T09:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current!.id, stale.id, "overdue todo task is still the current task");
    assert.equal(status.next, null);
    assert.equal(status.today.remainingCount, 0, "its start is in the past, so it is not remaining");
  });

  it("8. done tasks never appear, and unmarking brings them back", async () => {
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

  it("9. a task starting today and due tomorrow counts in remaining", async () => {
    await clearTasks();
    const evening = await createTask({ title: "Evening kickoff", startAt: "2026-08-31T13:00:00Z", dueAt: "2026-09-01T10:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.next!.id, evening.id);
    await createTask({ title: "Late start", startAt: "2026-08-31T15:00:00Z", dueAt: "2026-09-02T10:00:00Z" });
    const updated = await fetchStatus();
    assert.equal(updated.today.remainingCount, 1, "tomorrow-due does not matter; today-start does");
  });

  it("10. a task due today but without start_at does NOT count", async () => {
    await clearTasks();
    await createTask({ title: "Undated", dueAt: "2026-08-31T18:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.current, null);
    assert.equal(status.next, null);
    assert.equal(status.today.remainingCount, 0, "due_at alone never counts — only future start_at");
  });

  it("11. a task starting tomorrow does NOT count in today's remaining", async () => {
    await clearTasks();
    await createTask({ title: "Tomorrow run", startAt: "2026-09-01T08:00:00Z", dueAt: "2026-09-01T09:00:00Z" });
    await createTask({ title: "Later tomorrow", startAt: "2026-09-01T10:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.next!.title, "Tomorrow run");
    assert.equal(status.today.remainingCount, 0, "both starts are outside the local day");
  });

  it("12. next itself is excluded from remainingCount", async () => {
    await clearTasks();
    await createTask({ title: "Only future", startAt: "2026-08-31T16:00:00Z" });
    const status = await fetchStatus();
    assert.equal(status.next!.title, "Only future");
    assert.equal(status.today.remainingCount, 0, "the next task is displayed on its own, never double-counted");
  });

  it("13. remainingCount follows the platform-local day (cross-day, live timezone switch)", async () => {
    await clearTasks();
    // Under UTC (default) all three starts are later today; under
    // Asia/Shanghai (now = 19:26 local) the local day ends at 16:00Z, so only
    // the two pre-16:00Z starts are "today" and the 16:30Z one is tomorrow.
    await createTask({ title: "Soon", startAt: "2026-08-31T15:30:00Z" });
    await createTask({ title: "Soon after", startAt: "2026-08-31T15:45:00Z" });
    await createTask({ title: "Shanghai tomorrow", startAt: "2026-08-31T16:30:00Z" });

    const utc = await fetchStatus();
    assert.equal(utc.next!.title, "Soon");
    assert.equal(utc.today.remainingCount, 2, "under UTC all three are later today minus next");

    await setTimezone("Asia/Shanghai");
    try {
      const shanghai = await fetchStatus();
      assert.equal(shanghai.next!.title, "Soon", "23:30 local is still the earliest future start");
      assert.equal(shanghai.today.remainingCount, 1, "16:30Z is already Sep 1 local — not today");
    } finally {
      await setTimezone("UTC");
    }
  });

  it("14. exposes only the contract fields (no leakage of internal columns)", async () => {
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
