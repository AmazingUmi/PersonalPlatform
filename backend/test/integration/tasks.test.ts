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

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const tasksMigrations = [
  readFileSync(join(repoRoot, "apps/tasks/migrations/20260101000001-init.sql"), "utf8"),
  readFileSync(join(repoRoot, "apps/tasks/migrations/20260829000002-start-priority.sql"), "utf8"),
];

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;

before(async () => {
  db = await resetDatabase();
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "tasks", migrations: tasksMigrations }],
    backendModules: { tasks: tasksApp },
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
  await platform.stop();
  cleanup();
  await db.close();
});

async function json<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object): Promise<{ status: number; body: T }> {
  const response = await platform.app.inject({ method, url, payload });
  const raw = response.body;
  return { status: response.statusCode, body: (raw ? JSON.parse(raw) : null) as T };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("task completion timestamp transitions (FP-2C.1)", () => {
  let taskId: string;

  it("creates a todo task with null completed_at", async () => {
    const { status, body } = await json<{ id: string; status: string; completed_at: string | null }>(
      "POST",
      "/api/apps/tasks/tasks",
      { title: "write tests" },
    );
    assert.equal(status, 201);
    taskId = body.id;
    assert.equal(body.status, "todo");
    assert.equal(body.completed_at, null);
  });

  it("todo -> done sets completed_at", async () => {
    const { body } = await json<{ status: string; completed_at: string | null }>(
      "PATCH",
      `/api/apps/tasks/tasks/${taskId}`,
      { status: "done" },
    );
    assert.equal(body.status, "done");
    assert.ok(body.completed_at, "completed_at set on first completion");
  });

  it("done -> done keeps completed_at unchanged", async () => {
    await sleep(20);
    const first = await json<{ completed_at: string }>("GET", `/api/apps/tasks/tasks/${taskId}`);
    await sleep(20);
    const { body } = await json<{ status: string; completed_at: string }>(
      "PATCH",
      `/api/apps/tasks/tasks/${taskId}`,
      { status: "done" },
    );
    assert.equal(body.status, "done");
    assert.equal(
      new Date(body.completed_at).getTime(),
      new Date(first.body.completed_at).getTime(),
      "repeated done must not refresh completed_at",
    );
  });

  it("done -> todo clears completed_at", async () => {
    const { body } = await json<{ status: string; completed_at: string | null }>(
      "PATCH",
      `/api/apps/tasks/tasks/${taskId}`,
      { status: "todo" },
    );
    assert.equal(body.status, "todo");
    assert.equal(body.completed_at, null);
  });

  it("re-completing after reopening sets a fresh timestamp", async () => {
    const { body } = await json<{ status: string; completed_at: string | null }>(
      "PATCH",
      `/api/apps/tasks/tasks/${taskId}`,
      { status: "done" },
    );
    assert.equal(body.status, "done");
    assert.ok(body.completed_at);
  });
});

describe("tasks model and query API (FP-4)", () => {
  before(async () => {
    const specs = [
      { title: "T-Low", priority: 0, startAt: "2026-08-01T09:00:00Z", dueAt: "2026-08-20T18:00:00Z" },
      { title: "T-Normal", priority: 1 },
      { title: "T-High", priority: 2, dueAt: "2026-09-10T12:00:00Z" },
      { title: "T-Urgent", priority: 3, startAt: "2026-08-05T08:00:00Z", dueAt: "2026-08-06T08:00:00Z" },
    ];
    for (const spec of specs) {
      const { status } = await json("POST", "/api/apps/tasks/tasks", spec);
      assert.equal(status, 201, `fixture ${spec.title} created`);
    }
  });

  async function titles(query: string): Promise<string[]> {
    const { status, body } = await json<{ items: Array<{ title: string }> }>("GET", `/api/apps/tasks/tasks${query}`);
    assert.equal(status, 200);
    return body.items.map((task) => task.title);
  }

  it("persists start_at and priority on create", async () => {
    const result = await titles("?q=T-Urgent");
    assert.deepEqual(result, ["T-Urgent"]);
    const { body } = await json<{ items: Array<{ title: string; start_at: string | null; priority: number }> }>(
      "GET",
      "/api/apps/tasks/tasks",
    );
    const urgent = body.items.find((task: { title: string }) => task.title === "T-Urgent")!;
    assert.equal(urgent.priority, 3);
    assert.ok(String(urgent.start_at).startsWith("2026-08-05"));
  });

  it("rejects invalid priority values", async () => {
    const tooHigh = await json("POST", "/api/apps/tasks/tasks", { title: "Bad", priority: 4 });
    assert.equal(tooHigh.status, 400);
    const negative = await json("POST", "/api/apps/tasks/tasks", { title: "Bad", priority: -1 });
    assert.equal(negative.status, 400);
  });

  it("rejects dueAt earlier than startAt", async () => {
    const invalid = await json<{ error: { code: string } }>("POST", "/api/apps/tasks/tasks", {
      title: "Bad interval",
      startAt: "2026-08-10T10:00:00Z",
      dueAt: "2026-08-09T10:00:00Z",
    });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, "invalid_time_interval");
  });

  it("rejects a PATCH interval that becomes invalid", async () => {
    const created = await json<{ id: string }>("POST", "/api/apps/tasks/tasks", {
      title: "Patch interval",
      startAt: "2026-08-10T10:00:00Z",
    });
    const invalid = await json<{ error: { code: string } }>(
      "PATCH",
      `/api/apps/tasks/tasks/${created.body.id}`,
      { dueAt: "2026-08-01T10:00:00Z" },
    );
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, "invalid_time_interval");
  });

  it("filters by priority", async () => {
    const result = await titles("?priority=3");
    assert.deepEqual(result, ["T-Urgent"]);
  });

  it("filters by due window", async () => {
    const result = await titles("?dueAfter=2026-08-31T00:00:00Z&dueBefore=2026-10-01T00:00:00Z");
    assert.deepEqual(result, ["T-High"]);
  });

  it("filters by start window", async () => {
    const result = await titles("?startAfter=2026-08-04T00:00:00Z&startBefore=2026-08-10T00:00:00Z");
    assert.deepEqual(result.filter((t) => t.startsWith("T-")), ["T-Urgent"]);
  });

  it("sorts by priority via the allowlist with stable order", async () => {
    const result = await titles("?sortBy=priority&order=asc&q=T-");
    assert.deepEqual(result, ["T-Low", "T-Normal", "T-High", "T-Urgent"]);
    const descending = await titles("?sortBy=priority&order=desc&q=T-");
    assert.deepEqual(descending, ["T-Urgent", "T-High", "T-Normal", "T-Low"]);
  });

  it("sorts by dueAt with nulls last", async () => {
    const result = await titles("?sortBy=dueAt&order=asc&q=T-");
    assert.equal(result.at(-1), "T-Normal", "task without due date sorts last");
  });

  it("rejects unknown sort fields", async () => {
    const bad = await json("GET", "/api/apps/tasks/tasks?sortBy=title;DROP TABLE tasks");
    assert.equal(bad.status, 400);
  });

  it("PATCH clears dueAt and startAt with explicit null", async () => {
    const created = await json<{ id: string; due_at: string | null }>("POST", "/api/apps/tasks/tasks", {
      title: "Clearable",
      dueAt: "2026-12-01T10:00:00Z",
    });
    assert.ok(created.body.due_at);
    const cleared = await json<{ due_at: string | null; start_at: string | null }>(
      "PATCH",
      `/api/apps/tasks/tasks/${created.body.id}`,
      { dueAt: null, startAt: null },
    );
    assert.equal(cleared.body.due_at, null);
    assert.equal(cleared.body.start_at, null);
  });

  it("PATCH with no recognized fields returns the task unchanged", async () => {
    const created = await json<{ id: string; title: string }>("POST", "/api/apps/tasks/tasks", {
      title: "No-op",
    });
    const unchanged = await json<{ title: string }>("PATCH", `/api/apps/tasks/tasks/${created.body.id}`, {});
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body.title, "No-op");
  });
});
