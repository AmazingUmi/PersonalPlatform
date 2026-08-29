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
      "PUT",
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
      "PUT",
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
      "PUT",
      `/api/apps/tasks/tasks/${taskId}`,
      { status: "todo" },
    );
    assert.equal(body.status, "todo");
    assert.equal(body.completed_at, null);
  });

  it("re-completing after reopening sets a fresh timestamp", async () => {
    const { body } = await json<{ status: string; completed_at: string | null }>(
      "PUT",
      `/api/apps/tasks/tasks/${taskId}`,
      { status: "done" },
    );
    assert.equal(body.status, "done");
    assert.ok(body.completed_at);
  });
});
