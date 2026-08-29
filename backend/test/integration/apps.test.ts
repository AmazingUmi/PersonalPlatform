import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assetsApp from "../../src/apps/assets/index.js";
import miniGameApp from "../../src/apps/mini_game/index.js";
import tasksApp from "../../src/apps/tasks/index.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { Platform } from "../../src/core/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { buildFixturePlatform, type FixtureManifest } from "../helpers/platform.js";

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;

function appYaml(id: string, capabilities: string[]): string {
  return `manifest_version: 1
id: ${id}
name: ${id}
version: 0.1.0
description: fixture app ${id}
default_enabled: true
frontend:
  route: /${id}
widgets: []
capabilities:
${capabilities.map((c) => `  ${c}: true`).join("\n")}
`;
}

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

// Real shipped migrations keep the fixture schema in sync with the app code.
const readMigrations = (appId: string): string[] => {
  const dir = join(repoRoot, "apps", appId, "migrations");
  return readdirSync(dir)
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"));
};

const ASSETS_MIGRATIONS = readMigrations("assets");
const TASKS_MIGRATIONS = readMigrations("tasks");
const MINI_GAME_MIGRATIONS = readMigrations("mini_game");

interface CompletedPayload {
  id: string;
  title: string;
}

/** Captured envelopes for `tasks.task.completed.v1`. */
const completedEvents: Array<{
  id: string;
  type: string;
  source: string;
  payload: CompletedPayload;
}> = [];

const spyApp: BackendAppModule = {
  id: "spy",
  async registerApi() {},
  async registerEvents(ctx) {
    return [
      ctx.events.subscribe("tasks.task.completed.v1", (event) => {
        completedEvents.push({
          id: event.id,
          type: event.type,
          source: event.source,
          payload: event.payload as CompletedPayload,
        });
      }),
    ];
  },
};

before(async () => {
  db = await resetDatabase();
  const manifests: FixtureManifest[] = [
    {
      id: "assets",
      yaml: appYaml("assets", ["database", "storage"]),
      migrations: ASSETS_MIGRATIONS,
    },
    {
      id: "tasks",
      yaml: appYaml("tasks", ["database", "scheduler", "events"]),
      migrations: TASKS_MIGRATIONS,
    },
    {
      id: "mini_game",
      yaml: appYaml("mini_game", ["database", "events"]),
      migrations: MINI_GAME_MIGRATIONS,
    },
    {
      id: "spy",
      yaml: appYaml("spy", ["events"]),
    },
  ];
  const fixture = await buildFixturePlatform({
    database: db,
    manifests,
    backendModules: {
      assets: assetsApp,
      tasks: tasksApp,
      mini_game: miniGameApp,
      spy: spyApp,
    },
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;

  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [
      { scope: "assets", schema: "assets", dir: join(root, "apps", "assets", "migrations") },
      { scope: "tasks", schema: "tasks", dir: join(root, "apps", "tasks", "migrations") },
      { scope: "mini_game", schema: "mini_game", dir: join(root, "apps", "mini_game", "migrations") },
    ],
  });
});

after(async () => {
  await platform.stop();
  cleanup();
  await db.close();
});

describe("assets app API", () => {
  it("creates and lists categories", async () => {
    const first = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/categories",
      payload: { name: "Electronics" },
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().name, "Electronics");
    assert.ok(first.json().id, "created category has an id");

    const second = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/categories",
      payload: { name: "Furniture" },
    });
    assert.equal(second.statusCode, 201);

    const list = await platform.app.inject({ method: "GET", url: "/api/apps/assets/categories" });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.json().items.map((c: { name: string }) => c.name),
      ["Electronics", "Furniture"],
    );
  });

  it("creates an item with fields and fetches it by id", async () => {
    const categories = await platform.app.inject({ method: "GET", url: "/api/apps/assets/categories" });
    const electronicsId = categories.json().items.find((c: { name: string }) => c.name === "Electronics").id as string;

    const acquiredAt = "2026-01-15";
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: {
        name: "Laptop",
        description: "work machine",
        quantity: 2,
        acquiredAt,
        categoryId: electronicsId,
      },
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.equal(body.name, "Laptop");
    assert.equal(body.description, "work machine");
    assert.equal(body.quantity, 2);
    assert.equal(body.category_id, electronicsId);
    assert.ok(body.acquired_at, "acquired_at persisted");

    const fetched = await platform.app.inject({ method: "GET", url: `/api/apps/assets/items/${body.id}` });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().name, "Laptop");

    const missing = await platform.app.inject({
      method: "GET",
      url: "/api/apps/assets/items/00000000-0000-0000-0000-000000000000",
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "not_found");
  });

  it("rejects invalid item payloads with validation_error", async () => {
    const missingName = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { description: "no name" },
    });
    assert.equal(missingName.statusCode, 400);
    assert.equal(missingName.json().error.code, "validation_error");

    const negativeQuantity = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Bad", quantity: -1 },
    });
    assert.equal(negativeQuantity.statusCode, 400);
    assert.equal(negativeQuantity.json().error.code, "validation_error");

    const badDate = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Bad", acquiredAt: "not-a-date" },
    });
    assert.equal(badDate.statusCode, 400);
    assert.equal(badDate.json().error.code, "validation_error");
  });

  it("filters items by q and categoryId", async () => {
    const chair = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Office Chair", description: "ergonomic seat" },
    });
    assert.equal(chair.statusCode, 201);
    await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Standing Desk", description: "office furniture" },
    });

    const byDescription = await platform.app.inject({
      method: "GET",
      url: "/api/apps/assets/items?q=ergonomic",
    });
    assert.deepEqual(
      byDescription.json().items.map((i: { name: string }) => i.name),
      ["Office Chair"],
    );

    const byNameCaseInsensitive = await platform.app.inject({
      method: "GET",
      url: "/api/apps/assets/items?q=LAP",
    });
    assert.deepEqual(
      byNameCaseInsensitive.json().items.map((i: { name: string }) => i.name),
      ["Laptop"],
    );

    const categories = await platform.app.inject({ method: "GET", url: "/api/apps/assets/categories" });
    const electronicsId = categories.json().items.find((c: { name: string }) => c.name === "Electronics").id as string;
    const byCategory = await platform.app.inject({
      method: "GET",
      url: `/api/apps/assets/items?categoryId=${electronicsId}`,
    });
    const names = byCategory.json().items.map((i: { name: string }) => i.name);
    assert.ok(names.includes("Laptop"), "category filter includes the categorized item");
    assert.ok(!names.includes("Office Chair"), "category filter excludes uncategorized items");
  });

  it("partially updates an item", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Monitor" },
    });
    const itemId = created.json().id as string;

    const quantityUpdate = await platform.app.inject({
      method: "PATCH",
      url: `/api/apps/assets/items/${itemId}`,
      payload: { quantity: 3 },
    });
    assert.equal(quantityUpdate.statusCode, 200);
    assert.equal(quantityUpdate.json().quantity, 3);
    assert.equal(quantityUpdate.json().name, "Monitor", "untouched fields are preserved");

    const nameUpdate = await platform.app.inject({
      method: "PATCH",
      url: `/api/apps/assets/items/${itemId}`,
      payload: { name: "Ultra Monitor" },
    });
    assert.equal(nameUpdate.statusCode, 200);
    assert.equal(nameUpdate.json().name, "Ultra Monitor");
    assert.equal(nameUpdate.json().quantity, 3);

    const missing = await platform.app.inject({
      method: "PATCH",
      url: "/api/apps/assets/items/00000000-0000-0000-0000-000000000000",
      payload: { name: "Ghost" },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "not_found");
  });

  it("deletes an item and answers 404 afterwards", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Temp Item" },
    });
    const itemId = created.json().id as string;

    const removed = await platform.app.inject({ method: "DELETE", url: `/api/apps/assets/items/${itemId}` });
    assert.equal(removed.statusCode, 204);

    const gone = await platform.app.inject({ method: "GET", url: `/api/apps/assets/items/${itemId}` });
    assert.equal(gone.statusCode, 404);

    const removedAgain = await platform.app.inject({ method: "DELETE", url: `/api/apps/assets/items/${itemId}` });
    assert.equal(removedAgain.statusCode, 404);
    assert.equal(removedAgain.json().error.code, "not_found");
  });

  it("stores, lists and downloads attachments through platform storage", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Camera" },
    });
    const itemId = created.json().id as string;
    const content = "attachment-payload-123";

    const upload = await platform.app.inject({
      method: "POST",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      payload: {
        filename: "receipt.txt",
        contentType: "text/plain",
        dataBase64: Buffer.from(content, "utf8").toString("base64"),
      },
    });
    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().filename, "receipt.txt");
    assert.equal(upload.json().content_type, "text/plain");
    assert.equal(Number(upload.json().size), Buffer.byteLength(content, "utf8"));
    const attachmentId = upload.json().id as string;

    const list = await platform.app.inject({
      method: "GET",
      url: `/api/apps/assets/items/${itemId}/attachments`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 1);
    assert.equal(list.json().items[0].id, attachmentId);

    const download = await platform.app.inject({
      method: "GET",
      url: `/api/apps/assets/items/${itemId}/attachments/${attachmentId}`,
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.rawPayload.toString("utf8"), content);
    const contentType = download.headers["content-type"];
    assert.ok(
      typeof contentType === "string" && contentType.startsWith("text/plain"),
      `unexpected content-type: ${String(contentType)}`,
    );

    const missingDownload = await platform.app.inject({
      method: "GET",
      url: `/api/apps/assets/items/${itemId}/attachments/00000000-0000-0000-0000-000000000000`,
    });
    assert.equal(missingDownload.statusCode, 404);
    assert.equal(missingDownload.json().error.code, "not_found");
  });

  it("reports summary counts", async () => {
    const before = await platform.app.inject({ method: "GET", url: "/api/apps/assets/summary" });
    const beforeBody = before.json() as { items: number; categories: number };

    const categories = await platform.app.inject({ method: "POST", url: "/api/apps/assets/categories", payload: { name: "Summary Cat" } });
    await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Summary Item", categoryId: categories.json().id },
    });

    const after = await platform.app.inject({ method: "GET", url: "/api/apps/assets/summary" });
    const afterBody = after.json() as { items: number; categories: number };
    assert.equal(afterBody.items, beforeBody.items + 1);
    assert.equal(afterBody.categories, beforeBody.categories + 1);
  });
});

describe("tasks app API", () => {
  it("creates a task with a due date and validates input", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Buy groceries", dueAt: new Date().toISOString() },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().title, "Buy groceries");
    assert.equal(created.json().status, "todo");
    assert.equal(created.json().completed_at, null);
    assert.ok(created.json().due_at, "dueAt persisted");

    const missingTitle = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { description: "no title" },
    });
    assert.equal(missingTitle.statusCode, 400);
    assert.equal(missingTitle.json().error.code, "validation_error");
  });

  it("lists tasks and filters by status", async () => {
    const todo = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Filter Todo" },
    });
    const done = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Filter Done" },
    });
    await platform.app.inject({
      method: "PUT",
      url: `/api/apps/tasks/tasks/${done.json().id}`,
      payload: { status: "done" },
    });

    const all = await platform.app.inject({ method: "GET", url: "/api/apps/tasks/tasks" });
    const allTitles = all.json().items.map((t: { title: string }) => t.title);
    assert.ok(allTitles.includes("Filter Todo"));
    assert.ok(allTitles.includes("Filter Done"));

    const todoList = await platform.app.inject({ method: "GET", url: "/api/apps/tasks/tasks?status=todo" });
    const todoTitles = todoList.json().items.map((t: { title: string }) => t.title);
    assert.ok(todoTitles.includes("Filter Todo"));
    assert.ok(!todoTitles.includes("Filter Done"));

    const doneList = await platform.app.inject({ method: "GET", url: "/api/apps/tasks/tasks?status=done" });
    const doneTitles = doneList.json().items.map((t: { title: string }) => t.title);
    assert.ok(doneTitles.includes("Filter Done"));
    assert.ok(!doneTitles.includes("Filter Todo"));
    assert.equal(todoList.json().items.find((t: { id: string }) => t.id === todo.json().id).status, "todo");
  });

  it("completes a task and reopens it clearing completed_at", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Cycle" },
    });
    const taskId = created.json().id as string;

    const done = await platform.app.inject({
      method: "PUT",
      url: `/api/apps/tasks/tasks/${taskId}`,
      payload: { status: "done" },
    });
    assert.equal(done.statusCode, 200);
    assert.equal(done.json().status, "done");
    assert.ok(done.json().completed_at, "completed_at set on completion");

    const reopened = await platform.app.inject({
      method: "PUT",
      url: `/api/apps/tasks/tasks/${taskId}`,
      payload: { status: "todo" },
    });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json().status, "todo");
    assert.equal(reopened.json().completed_at, null, "completed_at cleared on reopen");
  });

  it("deletes a task and answers 404 afterwards", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Delete Me" },
    });
    const taskId = created.json().id as string;

    const removed = await platform.app.inject({ method: "DELETE", url: `/api/apps/tasks/tasks/${taskId}` });
    assert.equal(removed.statusCode, 204);

    const gone = await platform.app.inject({ method: "GET", url: `/api/apps/tasks/tasks/${taskId}` });
    assert.equal(gone.statusCode, 404);
    assert.equal(gone.json().error.code, "not_found");
  });

  it("summarizes today, overdue and done counts", async () => {
    const baseline = await platform.app.inject({ method: "GET", url: "/api/apps/tasks/summary" });
    const before = baseline.json() as { today: number; overdue: number; done: number };

    // Due at the end of the database server's "today" so it is due today but
    // never overdue, regardless of server timezone.
    const endOfToday = await db.context().query<{ due: Date }>(
      "SELECT (CURRENT_DATE::text || ' 23:59:59')::timestamptz AS due",
    );
    const dueToday = endOfToday.rows[0]!.due.toISOString();
    const overdueDue = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Due Today", dueAt: dueToday },
    });
    await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Overdue One", dueAt: overdueDue },
    });
    const toFinish = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Already Done" },
    });
    await platform.app.inject({
      method: "PUT",
      url: `/api/apps/tasks/tasks/${toFinish.json().id}`,
      payload: { status: "done" },
    });

    const summary = await platform.app.inject({ method: "GET", url: "/api/apps/tasks/summary" });
    const counts = summary.json() as { today: number; overdue: number; done: number };
    assert.equal(counts.today, before.today + 1, "one extra task due today");
    assert.equal(counts.overdue, before.overdue + 1, "one extra overdue task");
    assert.equal(counts.done, before.done + 1, "one extra done task");
  });

  it("publishes tasks.task.completed.v1 once per completion", async () => {
    completedEvents.length = 0;
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Publish Me" },
    });
    const taskId = created.json().id as string;

    const done = await platform.app.inject({
      method: "PUT",
      url: `/api/apps/tasks/tasks/${taskId}`,
      payload: { status: "done" },
    });
    assert.equal(done.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(completedEvents.length, 1, "exactly one completion event");
    const event = completedEvents[0]!;
    assert.equal(event.type, "tasks.task.completed.v1");
    assert.equal(event.source, "tasks");
    assert.equal(event.payload.id, taskId);
    assert.equal(event.payload.title, "Publish Me");

    const doneAgain = await platform.app.inject({
      method: "PUT",
      url: `/api/apps/tasks/tasks/${taskId}`,
      payload: { status: "done" },
    });
    assert.equal(doneAgain.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(completedEvents.length, 1, "re-completing a done task does not publish again");
  });
});

describe("mini_game app API", () => {
  it("starts with no save", async () => {
    const empty = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/saves" });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { save: null });
  });

  it("saves, loads and overwrites a board with monotonic revisions", async () => {
    const board = [
      [2, 4, 0, 0],
      [8, 16, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 2, 4],
    ];
    const saved = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: { score: 128, board, revision: 1 },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().accepted, true);
    assert.equal(saved.json().save.score, 128);
    assert.equal(saved.json().save.highScore, 128);

    const loaded = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/saves" });
    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.json().save.score, 128);
    assert.deepEqual(loaded.json().save.board, board);

    const summary = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/summary" });
    assert.equal(summary.json().highScore, 128);

    const higherBoard = [
      [4, 8, 0, 0],
      [16, 32, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 4, 8],
    ];
    const upgraded = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: { score: 512, board: higherBoard, revision: 2 },
    });
    assert.equal(upgraded.statusCode, 200);
    assert.equal(upgraded.json().accepted, true);
    assert.equal(upgraded.json().save.score, 512);

    const reloaded = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/saves" });
    assert.equal(reloaded.json().save.score, 512);
    assert.deepEqual(reloaded.json().save.board, higherBoard);

    const newSummary = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/summary" });
    assert.equal(newSummary.json().highScore, 512);

    // A reset run (New Game) never lowers the historical high score.
    const reset = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: { score: 0, board, revision: 3 },
    });
    assert.equal(reset.json().save.score, 0);
    assert.equal(reset.json().save.highScore, 512);
  });

  it("rejects invalid save payloads", async () => {
    const emptyBody = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: {},
    });
    assert.equal(emptyBody.statusCode, 400);
    assert.equal(emptyBody.json().error.code, "validation_error");

    const missingBoard = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: { score: 10, revision: 1 },
    });
    assert.equal(missingBoard.statusCode, 400);
    assert.equal(missingBoard.json().error.code, "validation_error");

    const missingScore = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: { board: [], revision: 1 },
    });
    assert.equal(missingScore.statusCode, 400);
    assert.equal(missingScore.json().error.code, "validation_error");

    const negativeScore = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: { score: -5, board: [], revision: 1 },
    });
    assert.equal(negativeScore.statusCode, 400);
    assert.equal(negativeScore.json().error.code, "validation_error");
  });
});
