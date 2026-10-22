import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { Platform } from "../../src/core/platform.js";
import {
  buildFixturePlatform,
  createTestUser,
  ensureTestAdmin,
  loginCookie,
  type FixtureManifest,
} from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import assetsApp from "../../src/apps/assets/index.js";
import clockApp from "../../src/apps/clock/index.js";
import focusApp from "../../src/apps/focus/index.js";
import miniGameApp from "../../src/apps/mini_game/index.js";
import notesApp from "../../src/apps/notes/index.js";
import tasksApp from "../../src/apps/tasks/index.js";

/**
 * AUTH-GATE-02/03/04/05 acceptance: two regular users (alice, bob) on ONE
 * platform with all six real apps. Every list is single-owner; every foreign
 * id answers 404 (never 403); per-user natural keys coexist; attachment
 * storage is physically user-scoped; the cross-app tasks status is scoped to
 * the calling user.
 */

const repoRoot = (() => {
  // backend/test/integration -> repository root is three levels up.
  let dir = import.meta.dirname;
  for (let i = 0; i < 3; i += 1) dir = join(dir, "..");
  return dir;
})();

function appMigrations(appId: string): string[] {
  const dir = join(repoRoot, "apps", appId, "migrations");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"));
}

const APP_IDS = ["assets", "clock", "focus", "mini_game", "notes", "tasks"] as const;

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
let bobId: string;

interface ErrorBody {
  error: { code: string; message: string };
}

async function inject(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie: string, payload?: object) {
  const response = await platform.app.inject({ method, url, payload, headers: { cookie } });
  return response;
}

async function json<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie: string, payload?: object): Promise<{ status: number; body: T }> {
  const response = await inject(method, url, cookie, payload);
  const raw = response.body;
  return { status: response.statusCode, body: (raw ? JSON.parse(raw) : null) as T };
}

before(async () => {
  db = await resetDatabase();
  await ensureTestAdmin(db);
  const { rows } = await db.context().query<{ id: string }>("SELECT id FROM core.users WHERE username = 'admin'");
  void rows;

  aliceId = (await createTestUser(db, "alice", "alice-password-1")).id;
  bobId = (await createTestUser(db, "bob", "bob-password-1")).id;

  const manifests: FixtureManifest[] = APP_IDS.map((id) => ({ id, migrations: appMigrations(id) }));
  const fixture = await buildFixturePlatform({
    manifests,
    backendModules: {
      assets: assetsApp,
      clock: clockApp,
      focus: focusApp,
      mini_game: miniGameApp,
      notes: notesApp,
      tasks: tasksApp,
    },
    database: db,
    // The task fixtures below describe this calendar day; real time would
    // make the ownership assertions fail on every later day.
    clock: () => new Date("2026-09-16T12:00:00.000Z"),
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;
  aliceCookie = await loginCookie(platform, "alice", "alice-password-1");
  bobCookie = await loginCookie(platform, "bob", "bob-password-1");

  for (const appId of APP_IDS) {
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: [{ scope: appId, schema: appId, dir: join(root, "apps", appId, "migrations") }],
    });
  }
});

after(async () => {
  await platform.stop().catch(() => undefined);
  cleanup();
  await db.close();
});

describe("tasks isolation (AUTH-GATE-02/03)", () => {
  let aliceTaskId: string;
  let bobTaskId: string;

  before(async () => {
    const a = await json<{ id: string }>("POST", "/api/apps/tasks/tasks", aliceCookie, {
      title: "alice-task",
      startAt: "2026-09-16T01:00:00.000Z",
      dueAt: "2026-09-16T23:00:00.000Z",
    });
    assert.equal(a.status, 201);
    aliceTaskId = a.body.id;
    const b = await json<{ id: string }>("POST", "/api/apps/tasks/tasks", bobCookie, {
      title: "bob-task",
      startAt: "2026-09-16T02:00:00.000Z",
      dueAt: "2026-09-16T23:30:00.000Z",
    });
    assert.equal(b.status, 201);
    bobTaskId = b.body.id;
  });

  it("lists only the caller's tasks", async () => {
    const a = await json<{ items: Array<{ id: string }> }>("GET", "/api/apps/tasks/tasks", aliceCookie);
    assert.deepEqual(a.body.items.map((t) => t.id), [aliceTaskId]);
    const b = await json<{ items: Array<{ id: string }> }>("GET", "/api/apps/tasks/tasks", bobCookie);
    assert.deepEqual(b.body.items.map((t) => t.id), [bobTaskId]);
  });

  it("foreign task ids answer 404 for GET, PATCH and DELETE", async () => {
    assert.equal((await inject("GET", `/api/apps/tasks/tasks/${bobTaskId}`, aliceCookie)).statusCode, 404);
    assert.equal(
      (await inject("PATCH", `/api/apps/tasks/tasks/${bobTaskId}`, aliceCookie, { title: "hijack" })).statusCode,
      404,
    );
    // Bob still owns his task untouched.
    const check = await json<{ title: string }>("GET", `/api/apps/tasks/tasks/${bobTaskId}`, bobCookie);
    assert.equal(check.status, 200);
    assert.equal(check.body.title, "bob-task");
    assert.equal(
      (await inject("DELETE", `/api/apps/tasks/tasks/${bobTaskId}`, aliceCookie)).statusCode,
      404,
    );
  });

  it("summary counts only the caller's tasks", async () => {
    const a = await json<{ today: number; done: number }>("GET", "/api/apps/tasks/summary", aliceCookie);
    const b = await json<{ today: number; done: number }>("GET", "/api/apps/tasks/summary", bobCookie);
    assert.equal(a.body.done, 0);
    assert.equal(b.body.done, 0);
    // Distinct start times → distinct "current" picks; both see exactly one today task.
    assert.equal(a.body.today, 1);
    assert.equal(b.body.today, 1);
  });

  it("cross-app public status reflects ONLY the calling user (AUTH-GATE-05)", async () => {
    const a = await json<{ current: { title: string } | null; next: null; today: { remainingCount: number } }>(
      "GET",
      "/api/apps/tasks/public/status",
      aliceCookie,
    );
    const b = await json<{ current: { title: string } | null }>(
      "GET",
      "/api/apps/tasks/public/status",
      bobCookie,
    );
    assert.equal(a.body.current?.title, "alice-task");
    assert.equal(b.body.current?.title, "bob-task");
    assert.equal(a.body.today.remainingCount, 0);
  });
});

describe("notes isolation + per-user tag names (AUTH-GATE-02/03)", () => {
  it("both users can own a tag named 'Work' (distinct rows)", async () => {
    const a = await json<{ id: string; name: string }>("POST", "/api/apps/notes/tags", aliceCookie, { name: "Work" });
    const b = await json<{ id: string; name: string }>("POST", "/api/apps/notes/tags", bobCookie, { name: "Work" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id);

    const aTags = await json<{ items: Array<{ name: string }> }>("GET", "/api/apps/notes/tags", aliceCookie);
    assert.deepEqual(
      aTags.body.items.filter((tag) => tag.name === "Work").length,
      1,
      "alice sees exactly her own 'Work'",
    );
    const bTags = await json<{ items: Array<{ name: string }> }>("GET", "/api/apps/notes/tags", bobCookie);
    assert.deepEqual(
      bTags.body.items.filter((tag) => tag.name === "Work").length,
      1,
      "bob sees exactly his own 'Work'",
    );
  });

  let aliceNoteId: string;
  let bobNoteId: string;
  let bobTagId: string;

  before(async () => {
    const a = await json<{ id: string }>("POST", "/api/apps/notes/notes", aliceCookie, { content: "alice note" });
    assert.equal(a.status, 201);
    aliceNoteId = a.body.id;
    const b = await json<{ id: string }>("POST", "/api/apps/notes/notes", bobCookie, { content: "bob note" });
    assert.equal(b.status, 201);
    bobNoteId = b.body.id;
    const bobTag = await json<{ id: string }>("POST", "/api/apps/notes/tags", bobCookie, { name: "BobSecret" });
    bobTagId = bobTag.body.id;
  });

  it("lists only the caller's notes", async () => {
    const a = await json<{ items: string[]; total: number }>("GET", "/api/apps/notes/notes", aliceCookie);
    const titles = (a.body as unknown as { items: Array<{ content: string }>; total: number }).items.map((n) => n.content);
    assert.ok(titles.includes("alice note"));
    assert.ok(!titles.includes("bob note"));
    const b = await json<{ items: Array<{ content: string }>; total: number }>("GET", "/api/apps/notes/notes", bobCookie);
    assert.ok(b.body.items.some((n) => n.content === "bob note"));
    assert.ok(b.body.items.every((n) => n.content !== "alice note"));
  });

  it("foreign note ids answer 404 for GET, PATCH and DELETE", async () => {
    assert.equal((await inject("GET", `/api/apps/notes/notes/${bobNoteId}`, aliceCookie)).statusCode, 404);
    assert.equal(
      (await inject("PATCH", `/api/apps/notes/notes/${bobNoteId}`, aliceCookie, { content: "hijack" })).statusCode,
      404,
    );
    assert.equal((await inject("DELETE", `/api/apps/notes/notes/${bobNoteId}`, aliceCookie)).statusCode, 404);
  });

  it("cannot attach another user's tag id (indistinguishable from nonexistent)", async () => {
    const created = await json<{ error: { code: string } } & object>(
      "POST",
      "/api/apps/notes/notes",
      aliceCookie,
      { content: "with foreign tag", tagIds: [bobTagId] },
    );
    assert.equal(created.status, 422);
    assert.equal((created.body as ErrorBody).error.code, "tag_not_found");
  });

  it("foreign tag delete answers 404", async () => {
    assert.equal((await inject("DELETE", `/api/apps/notes/tags/${bobTagId}`, aliceCookie)).statusCode, 404);
  });
});

describe("assets isolation + user-scoped attachment storage (AUTH-GATE-02/03/04)", () => {
  let aliceItemId: string;
  let bobItemId: string;

  before(async () => {
    // Both users may own a category with the SAME name.
    const catA = await json<{ id: string }>("POST", "/api/apps/assets/categories", aliceCookie, { name: "Work" });
    const catB = await json<{ id: string }>("POST", "/api/apps/assets/categories", bobCookie, { name: "Work" });
    assert.equal(catA.status, 201);
    assert.equal(catB.status, 201);

    const a = await json<{ id: string }>("POST", "/api/apps/assets/items", aliceCookie, {
      name: "alice-item",
      categoryIds: [catA.body.id],
    });
    assert.equal(a.status, 201);
    aliceItemId = a.body.id;
    const b = await json<{ id: string }>("POST", "/api/apps/assets/items", bobCookie, { name: "bob-item" });
    assert.equal(b.status, 201);
    bobItemId = b.body.id;
  });

  it("lists only the caller's items and categories", async () => {
    const a = await json<{ items: Array<{ name: string }>; counts: { all: number; categories: Record<string, number> } }>(
      "GET",
      "/api/apps/assets/items",
      aliceCookie,
    );
    assert.ok(a.body.items.some((i) => i.name === "alice-item"));
    assert.ok(a.body.items.every((i) => i.name !== "bob-item"));
    assert.equal(a.body.counts.all, 1);

    const cats = await json<{ items: Array<{ name: string }> }>("GET", "/api/apps/assets/categories", aliceCookie);
    assert.equal(cats.body.items.length, 1); // her "Work" only
  });

  it("foreign item ids answer 404 for GET, PATCH and DELETE", async () => {
    assert.equal((await inject("GET", `/api/apps/assets/items/${bobItemId}`, aliceCookie)).statusCode, 404);
    assert.equal(
      (await inject("PATCH", `/api/apps/assets/items/${bobItemId}`, aliceCookie, { name: "hijack" })).statusCode,
      404,
    );
    assert.equal((await inject("DELETE", `/api/apps/assets/items/${bobItemId}`, aliceCookie)).statusCode, 404);
    // Bob's item survived.
    assert.equal((await inject("GET", `/api/apps/assets/items/${bobItemId}`, bobCookie)).statusCode, 200);
  });

  it("attachments are physically user-scoped and invisible to the other user", async () => {
    const boundary = "pp-test-boundary";
    const fileContent = "alice-attachment-bytes";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="secret.txt"',
      "Content-Type: text/plain",
      "",
      fileContent,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const uploadResponse = await platform.app.inject({
      method: "POST",
      url: `/api/apps/assets/items/${aliceItemId}/attachments`,
      payload: body,
      headers: { cookie: aliceCookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    assert.equal(uploadResponse.statusCode, 201, uploadResponse.body);
    const attachment = uploadResponse.json() as { id: string };

    // Physical location: inside alice's user root, not the legacy app root.
    const physicalPath = join(root, "storage", "users", aliceId, "apps", "assets", "attachments", aliceItemId, attachment.id);
    assert.ok(existsSync(physicalPath), "file lives in alice's user-scoped tree");
    assert.ok(!existsSync(join(root, "storage", "apps", "assets")), "no legacy app-scoped tree");

    // Bob cannot read or delete it — even with both ids in hand.
    assert.equal(
      (await inject("GET", `/api/apps/assets/items/${aliceItemId}/attachments/${attachment.id}`, bobCookie)).statusCode,
      404,
    );
    assert.equal(
      (await inject("DELETE", `/api/apps/assets/items/${aliceItemId}/attachments/${attachment.id}`, bobCookie)).statusCode,
      404,
    );
    // Attachment listing for alice's item as bob: 404 (foreign item).
    assert.equal(
      (await inject("GET", `/api/apps/assets/items/${aliceItemId}/attachments`, bobCookie)).statusCode,
      404,
    );
    // Alice can still read her own bytes.
    const read = await inject("GET", `/api/apps/assets/items/${aliceItemId}/attachments/${attachment.id}`, aliceCookie);
    assert.equal(read.statusCode, 200);
    assert.equal(read.body, fileContent);
  });
});

describe("focus isolation + per-user single-active-session (AUTH-GATE-02/03)", () => {
  it("each user independently holds one active session", async () => {
    const aStart = await json<{ state: { active: { id: string } | null } } & { error?: { code: string } }>(
      "POST",
      "/api/apps/focus/start",
      aliceCookie,
      { kind: "focus" },
    );
    assert.equal(aStart.status, 201, `focus start failed: ${JSON.stringify(aStart.body)}`);
    assert.ok(aStart.body.state.active);

    // Bob sees NO active session and can start his own concurrently — the
    // one-active invariant is per user now.
    const bState = await json<{ active: unknown | null }>("GET", "/api/apps/focus/state", bobCookie);
    assert.equal(bState.status, 200, `bob state failed: ${JSON.stringify(bState.body)}`);
    assert.equal(bState.body.active, null);
    const bStart = await json<{ state: { active: { id: string } | null } }>(
      "POST",
      "/api/apps/focus/start",
      bobCookie,
      { kind: "focus" },
    );
    assert.equal(bStart.status, 201);
    assert.ok(bStart.body.state.active);

    // Sessions are isolated through stop: alice stops, bob's stays.
    const aStop = await json<{ state: { active: unknown | null } }>("POST", "/api/apps/focus/stop", aliceCookie);
    assert.equal(aStop.status, 200);
    assert.equal(aStop.body.state.active, null);
    const bAfter = await json<{ active: { id: string } | null }>("GET", "/api/apps/focus/state", bobCookie);
    assert.ok(bAfter.body.active, "bob's session survives alice's stop");

    await json("POST", "/api/apps/focus/stop", bobCookie);
  });

  it("settings are per user", async () => {
    const put = await json<object>(
      "PUT",
      "/api/apps/focus/settings",
      aliceCookie,
      {
        focusDurationSeconds: 30 * 60,
        shortBreakDurationSeconds: 5 * 60,
        longBreakDurationSeconds: 20 * 60,
        longBreakInterval: 4,
      },
    );
    assert.equal(put.status, 200);
    const aliceSettings = await json<{ focusDurationSeconds: number }>("GET", "/api/apps/focus/settings", aliceCookie);
    assert.equal(aliceSettings.body.focusDurationSeconds, 30 * 60);
    const bobSettings = await json<{ focusDurationSeconds: number }>("GET", "/api/apps/focus/settings", bobCookie);
    assert.notEqual(bobSettings.body.focusDurationSeconds, 30 * 60, "bob keeps his own defaults");
  });
});

describe("clock isolation (AUTH-GATE-02/03)", () => {
  let aliceAlarmId: string;
  let bobAlarmId: string;

  before(async () => {
    const a = await json<{ id: string }>("POST", "/api/apps/clock/alarms", aliceCookie, { time: "07:30" });
    const b = await json<{ id: string }>("POST", "/api/apps/clock/alarms", bobCookie, { time: "08:30" });
    aliceAlarmId = a.body.id;
    bobAlarmId = b.body.id;
  });

  it("lists only the caller's alarms", async () => {
    const a = await json<{ items: Array<{ time: string }> }>("GET", "/api/apps/clock/alarms", aliceCookie);
    assert.deepEqual(a.body.items.map((alarm) => alarm.time), ["07:30"]);
    const b = await json<{ items: Array<{ time: string }> }>("GET", "/api/apps/clock/alarms", bobCookie);
    assert.deepEqual(b.body.items.map((alarm) => alarm.time), ["08:30"]);
  });

  it("foreign alarm ids answer 404 for PATCH and DELETE", async () => {
    assert.equal(
      (await inject("PATCH", `/api/apps/clock/alarms/${bobAlarmId}`, aliceCookie, { label: "hijack" })).statusCode,
      404,
    );
    assert.equal((await inject("DELETE", `/api/apps/clock/alarms/${bobAlarmId}`, aliceCookie)).statusCode, 404);
  });

  it("world clocks and settings are per user", async () => {
    const a = await json<{ id: string }>("POST", "/api/apps/clock/world-clocks", aliceCookie, {
      city: "Shanghai",
      timezone: "Asia/Shanghai",
    });
    assert.equal(a.status, 201);
    const bList = await json<{ items: unknown[] }>("GET", "/api/apps/clock/world-clocks", bobCookie);
    assert.equal(bList.body.items.length, 0);

    const alicePut = await json<object>("PUT", "/api/apps/clock/settings", aliceCookie, {
      displayMode: "analog",
      showSeconds: false,
      showDate: true,
      hourFormat: 24,
    });
    assert.equal(alicePut.status, 200);
    const bobSettings = await json<{ displayMode: string }>("GET", "/api/apps/clock/settings", bobCookie);
    assert.equal(bobSettings.body.displayMode, "digital", "bob keeps the defaults");
  });
});

describe("mini_game isolation (AUTH-GATE-02/03)", () => {
  const emptyBoard = [
    [0, 2, 0, 0],
    [0, 0, 4, 0],
    [0, 0, 0, 0],
    [0, 8, 0, 0],
  ];

  it("each user has an independent save slot", async () => {
    const aSave = await json<{ save: { score: number } | null; accepted: boolean }>(
      "PUT",
      "/api/apps/mini_game/saves",
      aliceCookie,
      { score: 100, board: emptyBoard, revision: 0 },
    );
    assert.equal(aSave.status, 200);
    assert.equal(aSave.body.accepted, true);

    // Bob's slot is still empty.
    const bGet = await json<{ save: unknown | null }>("GET", "/api/apps/mini_game/saves", bobCookie);
    assert.equal(bGet.body.save, null);

    // Bob saves his own run; alice's board is untouched.
    const bSave = await json<{ save: { score: number }; accepted: boolean }>(
      "PUT",
      "/api/apps/mini_game/saves",
      bobCookie,
      { score: 40, board: emptyBoard, revision: 0 },
    );
    assert.equal(bSave.body.accepted, true);
    const aGet = await json<{ save: { score: number; revision: number } | null }>(
      "GET",
      "/api/apps/mini_game/saves",
      aliceCookie,
    );
    assert.equal(aGet.body.save?.score, 100);

    // Stale-revision guard is per user: alice replaying revision 0 is stale.
    const aStale = await json<{ accepted: boolean; save: { revision: number } }>(
      "PUT",
      "/api/apps/mini_game/saves",
      aliceCookie,
      { score: 999, board: emptyBoard, revision: 0 },
    );
    assert.equal(aStale.body.accepted, false);

    // High-score summaries are scoped.
    const aSummary = await json<{ highScore: number }>("GET", "/api/apps/mini_game/summary", aliceCookie);
    const bSummary = await json<{ highScore: number }>("GET", "/api/apps/mini_game/summary", bobCookie);
    assert.equal(aSummary.body.highScore, 100);
    assert.equal(bSummary.body.highScore, 40);
  });
});
