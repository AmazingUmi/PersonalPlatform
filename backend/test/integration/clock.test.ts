import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import clockApp from "../../src/apps/clock/index.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { runMigrations } from "../../src/core/database/migrate.js";

/**
 * Clock app integration coverage (worklist PHASE8 §8): settings defaults and
 * persistence, alarm CRUD with repeat-day validation and three-state PATCH,
 * world-clock CRUD with IANA validation, explicit reorder, and the disabled
 * lifecycle. Assembly follows notes.test.ts; the fixed clock keeps the suite
 * deterministic (the app itself never persists "now").
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const clockMigrations = [
  readFileSync(join(repoRoot, "apps/clock/migrations/20260831120000-init.sql"), "utf8"),
];

const FIXED_NOW = new Date("2026-08-31T11:26:00.000Z");

interface ClockSettings {
  displayMode: "digital" | "analog";
  showSeconds: boolean;
  showDate: boolean;
  hourFormat: 12 | 24;
}

interface AlarmView {
  id: string;
  time: string;
  label: string;
  enabled: boolean;
  repeatDays: number[];
  createdAt: string;
  updatedAt: string;
}

interface WorldClockView {
  id: string;
  city: string;
  timezone: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;

async function json<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: object,
): Promise<{ status: number; body: T }> {
  const response = await platform.app.inject({ method, url, payload });
  const raw = response.body;
  return { status: response.statusCode, body: (raw ? JSON.parse(raw) : null) as T };
}

async function createAlarm(body: object): Promise<AlarmView> {
  const response = await json<AlarmView>("POST", "/api/apps/clock/alarms", body);
  assert.equal(response.status, 201, `fixture alarm created (${JSON.stringify(body)})`);
  return response.body;
}

async function createWorldClock(body: object): Promise<WorldClockView> {
  const response = await json<WorldClockView>("POST", "/api/apps/clock/world-clocks", body);
  assert.equal(response.status, 201, `fixture world clock created (${JSON.stringify(body)})`);
  return response.body;
}

/** The view boundary is camelCase: no snake_case key at any depth. */
function assertNoSnakeCaseKeys(value: unknown, path = "body"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSnakeCaseKeys(item, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!key.includes("_"), `${path}.${key} must be camelCase (no snake_case keys)`);
      assertNoSnakeCaseKeys(child, `${path}.${key}`);
    }
  }
}

before(async () => {
  db = await resetDatabase();
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "clock", migrations: clockMigrations }],
    backendModules: { clock: clockApp },
    clock: () => FIXED_NOW,
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "clock", schema: "clock", dir: join(root, "apps", "clock", "migrations") }],
  });
});

after(async () => {
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

describe("clock settings (focus GET/PUT pattern)", () => {
  it("returns defaults before anything is stored", async () => {
    const response = await json<ClockSettings>("GET", "/api/apps/clock/settings");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      displayMode: "digital",
      showSeconds: true,
      showDate: true,
      hourFormat: 24,
    });
    assertNoSnakeCaseKeys(response.body);
  });

  it("PUT replaces the whole object and persists", async () => {
    const put = await json<ClockSettings>("PUT", "/api/apps/clock/settings", {
      displayMode: "analog",
      showSeconds: false,
      showDate: false,
      hourFormat: 12,
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, {
      displayMode: "analog",
      showSeconds: false,
      showDate: false,
      hourFormat: 12,
    });
    const get = await json<ClockSettings>("GET", "/api/apps/clock/settings");
    assert.deepEqual(get.body, put.body, "card and page read the same row");
  });

  it("rejects partial or illegal payloads", async () => {
    const cases: Array<[object, string]> = [
      [{ displayMode: "analog" }, "missing fields"],
      [{ displayMode: "round", showSeconds: true, showDate: true, hourFormat: 24 }, "bad mode"],
      [{ displayMode: "digital", showSeconds: true, showDate: true, hourFormat: 13 }, "bad hourFormat"],
      [{ displayMode: "digital", showSeconds: "yes", showDate: true, hourFormat: 24 }, "bad boolean"],
    ];
    for (const [payload, label] of cases) {
      const response = await json<ErrorBody>("PUT", "/api/apps/clock/settings", payload);
      assert.equal(response.status, 400, label);
      assert.equal(response.body.error.code, "validation_error", label);
    }
  });

  it("restores defaults for the later suites", async () => {
    const put = await json<ClockSettings>("PUT", "/api/apps/clock/settings", {
      displayMode: "digital",
      showSeconds: true,
      showDate: true,
      hourFormat: 24,
    });
    assert.equal(put.status, 200);
  });
});

describe("alarm CRUD and repeat days", () => {
  it("creates a weekday alarm and a minimal one-shot, returning camelCase views", async () => {
    const weekday = await createAlarm({ time: "07:30", label: "Morning", repeatDays: [1, 2, 3, 4, 5] });
    assert.deepEqual(
      Object.keys(weekday).sort(),
      ["createdAt", "enabled", "id", "label", "repeatDays", "time", "updatedAt"],
    );
    assert.equal(weekday.label, "Morning");
    assert.equal(weekday.enabled, true);
    assert.deepEqual(weekday.repeatDays, [1, 2, 3, 4, 5]);
    assertNoSnakeCaseKeys(weekday);

    const oneShot = await createAlarm({ time: "09:00" });
    assert.equal(oneShot.label, "");
    assert.equal(oneShot.enabled, true);
    assert.deepEqual(oneShot.repeatDays, []);
  });

  it("label contract: omitted/empty POST labels and a null PATCH all land on \"\"", async () => {
    // POST: omitted → "" (column default).
    const omitted = await createAlarm({ time: "10:00" });
    assert.equal(omitted.label, "");

    // POST: empty string and whitespace-only string both trim to "".
    const empty = await createAlarm({ time: "10:05", label: "" });
    assert.equal(empty.label, "");
    const blank = await createAlarm({ time: "10:10", label: "   " });
    assert.equal(blank.label, "");

    // PATCH: null clears a previously set label back to "".
    const named = await createAlarm({ time: "10:15", label: "Named" });
    assert.equal(named.label, "Named");
    const cleared = await json<AlarmView>("PATCH", `/api/apps/clock/alarms/${named.id}`, {
      label: null,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.label, "");

    // And a labeled round-trip keeps the trimmed value.
    const relabeled = await json<AlarmView>("PATCH", `/api/apps/clock/alarms/${named.id}`, {
      label: "  Tea time  ",
    });
    assert.equal(relabeled.body.label, "Tea time");
  });

  it("sorts the list by wall-clock time", async () => {
    const early = await createAlarm({ time: "06:15" });
    const list = await json<{ items: AlarmView[] }>("GET", "/api/apps/clock/alarms");
    assert.equal(list.status, 200);
    const times = list.body.items.map((alarm) => alarm.time);
    assert.deepEqual(times, [...times].sort(), "ascending by time");
    assert.equal(times[0], early.time);
  });

  it("rejects malformed times and illegal repeat days at the boundary", async () => {
    const cases: Array<[object, string]> = [
      [{ time: "7:30" }, "missing zero pad"],
      [{ time: "24:00" }, "hour out of range"],
      [{ time: "12:60" }, "minute out of range"],
      [{ time: "12:00", repeatDays: [7] }, "weekday 7"],
      [{ time: "12:00", repeatDays: [1, 1] }, "duplicate weekday"],
      [{ time: "12:00", repeatDays: [1, 2, 3, 4, 5, 6, 0, 1] }, "more than 7"],
      [{ label: "no time" }, "time required"],
    ];
    for (const [payload, label] of cases) {
      const response = await json<ErrorBody>("POST", "/api/apps/clock/alarms", payload);
      assert.equal(response.status, 400, label);
      assert.equal(response.body.error.code, "validation_error", label);
    }
  });

  it("PATCH follows three-state semantics and normalizes repeat days", async () => {
    const alarm = await createAlarm({ time: "22:00", label: "Night", repeatDays: [5, 6, 0] });
    assert.deepEqual(alarm.repeatDays, [0, 5, 6], "stored sorted");

    const cleared = await json<AlarmView>("PATCH", `/api/apps/clock/alarms/${alarm.id}`, { label: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.label, "", "explicit null clears the label");

    const reordered = await json<AlarmView>("PATCH", `/api/apps/clock/alarms/${alarm.id}`, {
      time: "21:45",
      repeatDays: [6, 1],
    });
    assert.equal(reordered.body.time, "21:45");
    assert.deepEqual(reordered.body.repeatDays, [1, 6], "deduped + sorted");

    const toggled = await json<AlarmView>("PATCH", `/api/apps/clock/alarms/${alarm.id}`, { enabled: false });
    assert.equal(toggled.body.enabled, false);

    const untouched = await json<AlarmView>("PATCH", `/api/apps/clock/alarms/${alarm.id}`, {});
    assert.equal(untouched.status, 200);
    assert.deepEqual(untouched.body, toggled.body, "empty PATCH is a no-op that returns the current view");
  });

  it("404s for unknown and malformed ids instead of 500", async () => {
    const missing = await json<ErrorBody>("PATCH", "/api/apps/clock/alarms/00000000-0000-0000-0000-000000000000", {
      enabled: false,
    });
    assert.equal(missing.status, 404);
    const malformed = await json<ErrorBody>("DELETE", "/api/apps/clock/alarms/not-a-uuid");
    assert.equal(malformed.status, 404, "malformed uuid must not reach pg as 22P02");
  });

  it("deletes", async () => {
    const alarm = await createAlarm({ time: "05:00", label: "Doomed" });
    const removed = await json("DELETE", `/api/apps/clock/alarms/${alarm.id}`);
    assert.equal(removed.status, 204);
    const again = await json<ErrorBody>("DELETE", `/api/apps/clock/alarms/${alarm.id}`);
    assert.equal(again.status, 404);
  });
});

describe("world clock CRUD, IANA validation and ordering", () => {
  it("creates entries with auto-incrementing sort order", async () => {
    const tokyo = await createWorldClock({ city: "Tokyo", timezone: "Asia/Tokyo" });
    const london = await createWorldClock({ city: "  London  ", timezone: "Europe/London" });
    assert.equal(tokyo.sortOrder, 1);
    assert.equal(london.sortOrder, 2);
    assert.equal(london.city, "London", "city is trimmed");
    assertNoSnakeCaseKeys(tokyo);
  });

  it("rejects whitespace-only cities (schema sees a non-empty string, trim does not)", async () => {
    const post = await json<ErrorBody>("POST", "/api/apps/clock/world-clocks", {
      city: "   ",
      timezone: "Asia/Tokyo",
    });
    assert.equal(post.status, 422);
    assert.equal(post.body.error.code, "invalid_city");

    const entry = await createWorldClock({ city: "Berlin", timezone: "Europe/Berlin" });
    const patch = await json<ErrorBody>("PATCH", `/api/apps/clock/world-clocks/${entry.id}`, {
      city: "   ",
    });
    assert.equal(patch.status, 422);
    assert.equal(patch.body.error.code, "invalid_city");

    // A real rename still works and trims normally.
    const renamed = await json<WorldClockView>("PATCH", `/api/apps/clock/world-clocks/${entry.id}`, {
      city: "  Berlin (DE) ",
    });
    assert.equal(renamed.body.city, "Berlin (DE)");
  });

  it("rejects non-IANA timezone names (never store offsets)", async () => {
    for (const timezone of ["UTC+8", "Not/AZone", "Pacific/Nowhere", "Asia/  Shanghai"]) {
      const response = await json<ErrorBody>("POST", "/api/apps/clock/world-clocks", {
        city: "Nowhere",
        timezone,
      });
      assert.equal(response.status, 422, `timezone "${timezone}" is rejected`);
      assert.equal(response.body.error.code, "invalid_timezone");
    }
    const patch = await json<ErrorBody>(
      "PATCH",
      "/api/apps/clock/world-clocks/00000000-0000-0000-0000-000000000000",
      { timezone: "EST" },
    );
    assert.equal(patch.status, 404, "unknown id is not found before timezone validation matters");
  });

  it("PATCHes city and timezone with three-state semantics", async () => {
    const entry = await createWorldClock({ city: "Paris", timezone: "Europe/Paris" });
    const renamed = await json<WorldClockView>("PATCH", `/api/apps/clock/world-clocks/${entry.id}`, {
      city: "  Paris (FR) ",
      timezone: "America/New_York",
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.city, "Paris (FR)");
    assert.equal(renamed.body.timezone, "America/New_York");

    const unchanged = await json<WorldClockView>("PATCH", `/api/apps/clock/world-clocks/${entry.id}`, {});
    assert.equal(unchanged.status, 200);
    assert.deepEqual(unchanged, renamed, "empty PATCH returns the current view");

    const illegal = await json<ErrorBody>("PATCH", `/api/apps/clock/world-clocks/${entry.id}`, {
      timezone: "UTC+9",
    });
    assert.equal(illegal.status, 422);
    assert.equal(illegal.body.error.code, "invalid_timezone");
  });

  it("reorders via the explicit full-list endpoint", async () => {
    const list = await json<{ items: WorldClockView[] }>("GET", "/api/apps/clock/world-clocks");
    const ids = list.body.items.map((entry) => entry.id);
    assert.ok(ids.length >= 2, "suite has at least two entries to swap");

    const reversed = await json<{ items: WorldClockView[] }>("PUT", "/api/apps/clock/world-clocks/order", {
      ids: [...ids].reverse(),
    });
    assert.equal(reversed.status, 200);
    assert.deepEqual(
      reversed.body.items.map((entry) => entry.id),
      [...ids].reverse(),
    );
    assert.deepEqual(
      reversed.body.items.map((entry) => entry.sortOrder),
      reversed.body.items.map((_, index) => index + 1),
      "dense 1..n renumber",
    );

    const partial = await json<ErrorBody>("PUT", "/api/apps/clock/world-clocks/order", {
      ids: [ids[0]!],
    });
    assert.equal(partial.status, 422);
    assert.equal(partial.body.error.code, "invalid_order");

    const duplicated = await json<ErrorBody>("PUT", "/api/apps/clock/world-clocks/order", {
      ids: [...ids, ids[0]!],
    });
    assert.equal(duplicated.status, 422);
    assert.equal(duplicated.body.error.code, "invalid_order");

    const notUuid = await json<ErrorBody>("PUT", "/api/apps/clock/world-clocks/order", {
      ids: ["nope"],
    });
    assert.equal(notUuid.status, 400);
  });

  it("deletes and keeps the remaining order stable", async () => {
    const before = await json<{ items: WorldClockView[] }>("GET", "/api/apps/clock/world-clocks");
    const victim = before.body.items[0]!;
    const removed = await json("DELETE", `/api/apps/clock/world-clocks/${victim.id}`);
    assert.equal(removed.status, 204);
    const after = await json<{ items: WorldClockView[] }>("GET", "/api/apps/clock/world-clocks");
    assert.equal(after.body.items.length, before.body.items.length - 1);
    assert.ok(!after.body.items.some((entry) => entry.id === victim.id));
    const orderValues = after.body.items.map((entry) => entry.sortOrder);
    assert.deepEqual(
      orderValues,
      [...orderValues].sort((a, b) => a - b),
      "delete never reshuffles the survivors (gaps in sort_order are fine)",
    );
  });
});

describe("disabled lifecycle", () => {
  it("disabling the clock app turns every route into 404 while keeping the data", async () => {
    const alarm = await createAlarm({ time: "12:34", label: "Lifecycle" });

    const disabled = await json<{ status: string }>("PUT", "/api/core/apps/clock/enabled", {
      enabled: false,
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.status, "disabled");

    const probes: Array<["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string, object?]> = [
      ["GET", "/api/apps/clock/settings"],
      ["PUT", "/api/apps/clock/settings", { displayMode: "analog", showSeconds: true, showDate: true, hourFormat: 24 }],
      ["GET", "/api/apps/clock/alarms"],
      ["PATCH", `/api/apps/clock/alarms/${alarm.id}`, { enabled: false }],
      ["GET", "/api/apps/clock/world-clocks"],
      ["PUT", "/api/apps/clock/world-clocks/order", { ids: [alarm.id] }],
    ];
    for (const [method, url, payload] of probes) {
      const probe = await json<ErrorBody>(method, url, payload);
      assert.equal(probe.status, 404, `${method} ${url} is 404 while the app is disabled`);
    }

    const rows = await db
      .context()
      .query<{ n: number }>("SELECT count(*)::int AS n FROM clock.alarms WHERE id = $1", [alarm.id]);
    assert.equal(rows.rows[0]!.n, 1, "disable never touches the schema or rows");

    const enabled = await json<{ status: string }>("PUT", "/api/core/apps/clock/enabled", {
      enabled: true,
    });
    assert.equal(enabled.status, 200);
    const restored = await json<{ items: AlarmView[] }>("GET", "/api/apps/clock/alarms");
    assert.ok(restored.body.items.some((entry) => entry.id === alarm.id), "data survives the cycle");
  });
});
