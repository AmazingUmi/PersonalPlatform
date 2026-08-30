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
import { localDayRangeUtc } from "../../src/core/time/index.js";

/**
 * FP-10: one platform timezone drives "today" everywhere. Tasks summary uses
 * the TimeService's UTC [start, end) window, settings can switch the timezone
 * live, and the choice survives a restart.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const tasksMigrations = [
  readFileSync(join(repoRoot, "apps/tasks/migrations/20260101000001-init.sql"), "utf8"),
  readFileSync(join(repoRoot, "apps/tasks/migrations/20260829000002-start-priority.sql"), "utf8"),
];

let db: Database;

before(async () => {
  db = await resetDatabase();
});

after(async () => {
  if (db) await db.close();
});

async function json<T>(
  platform: Platform,
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  payload?: object,
): Promise<{ status: number; body: T }> {
  const response = await platform.app.inject({ method, url, payload });
  const raw = response.body;
  return { status: response.statusCode, body: (raw ? JSON.parse(raw) : null) as T };
}

async function buildTasksPlatform(clock?: () => Date): Promise<{ platform: Platform; cleanup: () => void; root: string }> {
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "tasks", migrations: tasksMigrations }],
    backendModules: { tasks: tasksApp },
    clock,
  });
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "tasks", schema: "tasks", dir: join(fixture.root, "apps", "tasks", "migrations") }],
  });
  return fixture;
}

/** Counting tests assert absolute numbers; start each from an empty table. */
async function clearTasks(): Promise<void> {
  await db.context().query("DELETE FROM tasks.tasks");
}

describe("platform timezone setting (FP-10.1)", () => {
  it("rejects offset-style and invalid timezone names", async () => {
    await buildTasksPlatform().then(async ({ platform, cleanup }) => {
      try {
        for (const bad of ["UTC+8", "GMT-7", "Not/AZone", 42]) {
          const { status, body } = await json<{ error: { code: string } }>(
            platform,
            "PUT",
            "/api/core/settings/platform.timezone",
            { value: bad },
          );
          assert.equal(status, 422, `${JSON.stringify(bad)} must be rejected`);
          assert.equal(body.error.code, "invalid_timezone");
        }
      } finally {
        await platform.stop();
        cleanup();
      }
    });
  });

  it("accepts an IANA name, applies it live and reports it on the platform API", async () => {
    const { platform, cleanup } = await buildTasksPlatform();
    try {
      const put = await json<{ value: string }>(
        platform,
        "PUT",
        "/api/core/settings/platform.timezone",
        { value: "Asia/Shanghai" },
      );
      assert.equal(put.status, 200);

      const platformInfo = await json<{ timezone: string }>(platform, "GET", "/api/core/platform");
      assert.equal(platformInfo.body.timezone, "Asia/Shanghai");

      const time = await json<{ timezone: string; now: string }>(platform, "GET", "/api/core/time");
      assert.equal(time.body.timezone, "Asia/Shanghai");
      assert.ok(!Number.isNaN(Date.parse(time.body.now)));

      const stored = await db
        .context()
        .query<{ value: unknown }>("SELECT value FROM core.settings WHERE key = 'platform.timezone'");
      assert.equal(stored.rows[0]!.value, "Asia/Shanghai", "setting persisted in core.settings");
    } finally {
      await platform.stop();
      cleanup();
    }
  });

  it("restores the persisted timezone after a restart", async () => {
    // First platform sets the timezone; a brand-new platform instance must
    // read it back from core.settings at startup.
    {
      const { platform, cleanup } = await buildTasksPlatform();
      await json(platform, "PUT", "/api/core/settings/platform.timezone", { value: "America/Los_Angeles" });
      await platform.stop();
      cleanup();
    }
    const { platform, cleanup } = await buildTasksPlatform();
    try {
      const info = await json<{ timezone: string }>(platform, "GET", "/api/core/platform");
      assert.equal(info.body.timezone, "America/Los_Angeles", "timezone survives restart");
    } finally {
      await platform.stop();
      cleanup();
    }
  });
});

describe("tasks today boundary semantics (FP-10.3)", () => {
  it("counts due_at inside the user's local [start, end) day exactly", async () => {
    const { platform, cleanup } = await buildTasksPlatform();
    try {
      await clearTasks();
      await json(platform, "PUT", "/api/core/settings/platform.timezone", { value: "Asia/Shanghai" });
      const range = localDayRangeUtc("Asia/Shanghai");

      const create = (dueAt: string) =>
        json<{ id: string }>(platform, "POST", "/api/apps/tasks/tasks", { title: "t", dueAt });

      // Exactly at local midnight: first instant of today.
      assert.equal((await create(range.start.toISOString())).status, 201);
      // 1ms before local midnight: yesterday.
      assert.equal((await create(new Date(range.start.getTime() - 1).toISOString())).status, 201);
      // Last instant of today.
      assert.equal((await create(new Date(range.end.getTime() - 1).toISOString())).status, 201);
      // Exactly at the end boundary: tomorrow.
      assert.equal((await create(range.end.toISOString())).status, 201);

      const summary = await json<{ today: number; overdue: number }>(platform, "GET", "/api/apps/tasks/summary");
      assert.equal(summary.body.today, 2, "start and end-1ms count, start-1ms and end do not");

      // done tasks leave "today".
      const first = await json<{ items: Array<{ id: string; due_at: string }> }>(
        platform,
        "GET",
        "/api/apps/tasks/tasks?sortBy=createdAt&order=asc",
      );
      const boundary = first.body.items.filter((task) => task.due_at !== null);
      const atStart = boundary.find(
        (task) => new Date(task.due_at!).getTime() === range.start.getTime(),
      )!;
      await json(platform, "PATCH", `/api/apps/tasks/tasks/${atStart.id}`, { status: "done" });
      const afterDone = await json<{ today: number }>(platform, "GET", "/api/apps/tasks/summary");
      assert.equal(afterDone.body.today, 1, "completed tasks leave today");
    } finally {
      await platform.stop();
      cleanup();
    }
  });

  it("switching the platform timezone moves the day window live", async () => {
    // Fixed clock: which UTC instant belongs to which timezone's "today" must
    // not depend on when CI happens to run. At 2026-08-30T11:00Z the windows
    // on the UTC axis are:
    //   Pacific/Kiritimati (UTC+14) today: [08-30T10:00Z, 08-31T10:00Z)
    //   Etc/GMT+12 (UTC-12) today:         [08-29T12:00Z, 08-30T12:00Z)
    // They overlap by 2h, so "Kiritimati midnight + 1min" is still GMT-12's
    // today — that assumption was wrong. The proven instant is one minute
    // after GMT-12's today ends: still Kiritimati's today, already GMT-12's
    // tomorrow.
    const now = new Date("2026-08-30T11:00:00.000Z");
    const kiriRange = localDayRangeUtc("Pacific/Kiritimati", now);
    const gmt12Range = localDayRangeUtc("Etc/GMT+12", now);
    const dueMs = gmt12Range.end.getTime() + 60_000;
    assert.ok(dueMs >= kiriRange.start.getTime(), "due instant is inside Kiritimati's today");
    assert.ok(dueMs < kiriRange.end.getTime(), "due instant is inside Kiritimati's today");
    assert.ok(dueMs >= gmt12Range.end.getTime(), "due instant is past GMT-12's today (tomorrow there)");
    const dueAt = new Date(dueMs).toISOString();

    const { platform, cleanup } = await buildTasksPlatform(() => now);
    try {
      await clearTasks();
      await json(platform, "PUT", "/api/core/settings/platform.timezone", {
        value: "Pacific/Kiritimati",
      });

      await json(platform, "POST", "/api/apps/tasks/tasks", { title: "edge", dueAt });
      const inKiri = await json<{ today: number }>(platform, "GET", "/api/apps/tasks/summary");
      assert.equal(inKiri.body.today, 1, "inside Kiritimati's local day");

      await json(platform, "PUT", "/api/core/settings/platform.timezone", { value: "Etc/GMT+12" });
      const inGmt12 = await json<{ today: number }>(platform, "GET", "/api/apps/tasks/summary");
      assert.equal(inGmt12.body.today, 0, "same instant is tomorrow after the live switch");
    } finally {
      await platform.stop();
      cleanup();
    }
  });

  it("overdue counts past-due open tasks regardless of timezone", async () => {
    const { platform, cleanup } = await buildTasksPlatform();
    try {
      await clearTasks();
      const past = new Date(Date.now() - 3_600_000).toISOString();
      const created = await json<{ id: string }>(platform, "POST", "/api/apps/tasks/tasks", {
        title: "late",
        dueAt: past,
      });
      assert.equal(created.status, 201);

      const before = await json<{ overdue: number }>(platform, "GET", "/api/apps/tasks/summary");
      assert.equal(before.body.overdue, 1);

      await json(platform, "PATCH", `/api/apps/tasks/tasks/${created.body.id}`, { status: "done" });
      const after = await json<{ overdue: number }>(platform, "GET", "/api/apps/tasks/summary");
      assert.equal(after.body.overdue, 0, "completed tasks are not overdue");
    } finally {
      await platform.stop();
      cleanup();
    }
  });
});
