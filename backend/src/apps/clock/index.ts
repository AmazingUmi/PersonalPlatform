import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import {
  assertPresentedHash, editorBaseHash, headerPresentedHash, lockOwnedTables, lockOwnerSet, parseSnapshotRow, readPresentedHash, singletonBaseHash, syncWriteFenced,
} from "../../core/data-management/sync-fence.js";
import {
  ALARM_TIME_PATTERN,
  DEFAULT_CLOCK_SETTINGS,
  isUuid,
  isValidTimezone,
  normalizeRepeatDays,
  sanitizeClockSettings,
  type ClockSettingsView,
} from "./model.js";

/** Database surface derived from AppContext (never from core internals — focus repository precedent). */
type Db = AppContext["database"];

interface AlarmRow {
  id: string;
  time: string;
  label: string;
  enabled: boolean;
  repeat_days: number[];
  created_at: Date;
  updated_at: Date;
}

interface WorldClockRow {
  id: string;
  city: string;
  timezone: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface AlarmView {
  id: string;
  time: string;
  label: string;
  enabled: boolean;
  repeatDays: number[];
  createdAt: string;
  updatedAt: string;
  baseHash?: string;
}

export interface WorldClockView {
  id: string;
  city: string;
  timezone: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  baseHash?: string;
}

/** camelCase view boundary (notes toNoteView precedent). */
function toAlarmView(row: AlarmRow): AlarmView {
  return {
    id: row.id,
    time: row.time,
    label: row.label,
    enabled: row.enabled,
    repeatDays: [...row.repeat_days].sort((a, b) => a - b),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toWorldClockView(row: WorldClockRow): WorldClockView {
  return {
    id: row.id,
    city: row.city,
    timezone: row.timezone,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function invalidTimezoneError(timezone: string): AppError {
  return new AppError(
    422,
    "invalid_timezone",
    `timezone must be a valid IANA zone (got "${timezone}")`,
  );
}

function invalidCityError(): AppError {
  return new AppError(422, "invalid_city", "city must contain at least one non-space character");
}

/** A malformed uuid must not reach pg as a 22P02 parse error — it is simply not found. */
async function findAlarmView(db: Db, alarmId: string, userId: string): Promise<AlarmView | null> {
  if (!isUuid(alarmId)) return null;
  const { rows } = await db.query<AlarmRow & { snapshot: string }>(
    "SELECT a.*, row_to_json(a)::text AS snapshot FROM clock.alarms a WHERE id = $1 AND user_id = $2",
    [alarmId, userId],
  );
  return rows[0] ? { ...toAlarmView(rows[0]), baseHash: clockRowHash("clock.alarms", rows[0].snapshot) } : null;
}

async function findWorldClockView(
  db: Db,
  id: string,
  userId: string,
): Promise<WorldClockView | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<WorldClockRow & { snapshot: string }>(
    "SELECT w.*, row_to_json(w)::text AS snapshot FROM clock.world_clocks w WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0] ? { ...toWorldClockView(rows[0]), baseHash: clockRowHash("clock.world_clocks", rows[0].snapshot) } : null;
}

const id = "clock";
const SETTINGS_ID = "current";

function clockRowHash(table: string, snapshot: string): string {
  return editorBaseHash([{ table, row: parseSnapshotRow(snapshot) }]);
}

function absentClockSettingsHash(): string {
  return singletonBaseHash("clock.settings", { id: SETTINGS_ID, value: DEFAULT_CLOCK_SETTINGS });
}

async function getSettings(db: Db, userId: string): Promise<ClockSettingsView & { baseHash: string }> {
  const { rows } = await db.query<{ value: unknown; snapshot: string }>(
    "SELECT value, row_to_json(s)::text AS snapshot FROM clock.settings s WHERE id = $1 AND user_id = $2",
    [SETTINGS_ID, userId],
  );
  const view = sanitizeClockSettings(rows[0]?.value) ?? DEFAULT_CLOCK_SETTINGS;
  return { ...view, baseHash: rows[0] ? clockRowHash("clock.settings", rows[0].snapshot) : absentClockSettingsHash() };
}

async function saveSettings(db: Db, userId: string, next: ClockSettingsView, presented: string | undefined): Promise<void> {
  await db.withTransaction(async (tx) => {
    await lockOwnedTables(tx, ["clock.settings"]);
    await lockOwnerSet(tx, userId, "clock.settings");
    const { rows } = await tx.query<{ snapshot: string }>(
      "SELECT row_to_json(s)::text AS snapshot FROM clock.settings s WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [SETTINGS_ID, userId],
    );
    const actual = rows[0] ? clockRowHash("clock.settings", rows[0].snapshot) : absentClockSettingsHash();
    assertPresentedHash(await syncWriteFenced(tx, userId), presented, actual);
    await tx.query(
      `INSERT INTO clock.settings (id, user_id, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (user_id, id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SETTINGS_ID, userId, JSON.stringify(next)],
    );
  });
}

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  // ---- Settings (focus GET/PUT /settings precedent: single-row, full replace).
  // One source of truth — the dashboard card and the app page read the same row.
  // AUTH-3: the row is per-user ("current" is a slot inside (user_id, id)).

  ctx.api.get("/settings", async (request) => {
    const user = await ctx.auth.requireUser(request);
    return getSettings(db, user.id);
  });

  ctx.api.put("/settings", {
    schema: {
      body: {
        type: "object",
        required: ["displayMode", "showSeconds", "showDate", "hourFormat"],
        additionalProperties: false,
        properties: {
          displayMode: { type: "string", enum: ["digital", "analog"] },
          showSeconds: { type: "boolean" },
          showDate: { type: "boolean" },
          hourFormat: { type: "integer", enum: [12, 24] },
          baseHash: { type: "string" },
        },
      },
    },
    async handler(request) {
      const user = await ctx.auth.requireUser(request);
      const presented = readPresentedHash((request.body as { baseHash?: unknown }).baseHash);
      const sanitized = sanitizeClockSettings(request.body);
      if (!sanitized) {
        throw new AppError(422, "invalid_settings", "settings payload is not a legal settings object");
      }
      await saveSettings(db, user.id, sanitized, presented);
      return getSettings(db, user.id);
    },
  });

  // ---- Alarms. `time` is a local wall-clock 'HH:MM' — firing is detected by
  // the client while the app is open (browser limitation, see apps/clock/README.md).

  ctx.api.get("/alarms", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const { rows } = await db.query<AlarmRow & { snapshot: string }>(
      "SELECT a.*, row_to_json(a)::text AS snapshot FROM clock.alarms a WHERE user_id = $1 ORDER BY time ASC, created_at ASC",
      [user.id],
    );
    return { items: rows.map((row) => ({ ...toAlarmView(row), baseHash: clockRowHash("clock.alarms", row.snapshot) })) };
  });

  ctx.api.post("/alarms", {
    schema: {
      body: {
        type: "object",
        required: ["time"],
        additionalProperties: false,
        properties: {
          time: { type: "string", pattern: ALARM_TIME_PATTERN.source },
          label: { type: "string", maxLength: 100 },
          enabled: { type: "boolean" },
          repeatDays: {
            type: "array",
            maxItems: 7,
            uniqueItems: true,
            items: { type: "integer", minimum: 0, maximum: 6 },
          },
        },
      },
    },
    async handler(request, reply) {
      const user = await ctx.auth.requireUser(request);
      const body = request.body as {
        time: string;
        label?: string;
        enabled?: boolean;
        repeatDays?: number[];
      };
      const newId = randomUUID();
      await db.query(
        `INSERT INTO clock.alarms (id, user_id, time, label, enabled, repeat_days)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newId, user.id, body.time, body.label?.trim() ?? "", body.enabled ?? true, body.repeatDays ?? []],
      );
      return reply.code(201).send(await findAlarmView(db, newId, user.id));
    },
  });

  // Three-state PATCH (notes/assets precedent): absent = keep, explicit null =
  // clear (label → ''), value = update. `time` is NOT NULL and not clearable.
  ctx.api.patch<{ Params: { id: string } }>("/alarms/:id", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          time: { type: "string", pattern: ALARM_TIME_PATTERN.source },
          label: { type: ["string", "null"], maxLength: 100 },
          enabled: { type: "boolean" },
          repeatDays: {
            type: "array",
            maxItems: 7,
            uniqueItems: true,
            items: { type: "integer", minimum: 0, maximum: 6 },
          },
          baseHash: { type: "string" },
        },
      },
    },
    async handler(request) {
      const user = await ctx.auth.requireUser(request);
      if (!isUuid(request.params.id)) throw new AppError(404, "not_found", "alarm not found");
      const body = request.body as {
        time?: string;
        label?: string | null;
        enabled?: boolean;
        repeatDays?: number[];
        baseHash?: unknown;
      };
      if (body.time === undefined && body.label === undefined && body.enabled === undefined && body.repeatDays === undefined) {
        const view = await findAlarmView(db, request.params.id, user.id);
        if (!view) throw new AppError(404, "not_found", "alarm not found");
        return view;
      }
      const sets: string[] = [];
      const params: unknown[] = [request.params.id, user.id];
      const set = (column: string, value: unknown): void => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (body.time !== undefined) set("time", body.time);
      if (body.label !== undefined) set("label", body.label === null ? "" : body.label.trim());
      if (body.enabled !== undefined) set("enabled", body.enabled);
      if (body.repeatDays !== undefined) set("repeat_days", normalizeRepeatDays(body.repeatDays));
      const presented = readPresentedHash((body as { baseHash?: unknown }).baseHash);
      const updated = await db.withTransaction(async (tx) => {
        await lockOwnedTables(tx, ["clock.alarms"]);
        const current = await tx.query<{ snapshot: string }>(
          "SELECT row_to_json(a)::text AS snapshot FROM clock.alarms a WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [request.params.id, user.id],
        );
        if (!current.rows[0]) throw new AppError(404, "not_found", "alarm not found");
        assertPresentedHash(await syncWriteFenced(tx, user.id), presented, clockRowHash("clock.alarms", current.rows[0].snapshot));
        const written = await tx.query<AlarmRow>(
          `UPDATE clock.alarms SET ${sets.join(", ")}, updated_at = now()
           WHERE id = $1 AND user_id = $2 RETURNING *`,
          params,
        );
        return written.rows[0] ?? null;
      });
      if (!updated) throw new AppError(404, "not_found", "alarm not found");
      const view = await findAlarmView(db, request.params.id, user.id);
      if (!view) throw new AppError(404, "not_found", "alarm not found");
      return view;
    },
  });

  ctx.api.delete<{ Params: { id: string } }>("/alarms/:id", async (request, reply) => {
    const user = await ctx.auth.requireUser(request);
    if (!isUuid(request.params.id)) throw new AppError(404, "not_found", "alarm not found");
    const presented = headerPresentedHash(request.headers["x-base-hash"]);
    await db.withTransaction(async (tx) => {
      await lockOwnedTables(tx, ["clock.alarms"]);
      const current = await tx.query<{ snapshot: string }>(
        "SELECT row_to_json(a)::text AS snapshot FROM clock.alarms a WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [request.params.id, user.id],
      );
      if (!current.rows[0]) throw new AppError(404, "not_found", "alarm not found");
      assertPresentedHash(await syncWriteFenced(tx, user.id), presented, clockRowHash("clock.alarms", current.rows[0].snapshot));
      await tx.query("DELETE FROM clock.alarms WHERE id = $1 AND user_id = $2", [request.params.id, user.id]);
    });
    return reply.code(204).send();
  });

  // ---- World clocks. Timezone is always stored as an IANA name (never a UTC
  // offset) so DST is resolved by Intl at display time, not by stored data.

  ctx.api.get("/world-clocks", async (request) => {
    const user = await ctx.auth.requireUser(request);
    return worldClockList(db, user.id);
  });

  ctx.api.post("/world-clocks", {
    schema: {
      body: {
        type: "object",
        required: ["city", "timezone"],
        additionalProperties: false,
        properties: {
          city: { type: "string", minLength: 1, maxLength: 60 },
          timezone: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
    async handler(request, reply) {
      const user = await ctx.auth.requireUser(request);
      const body = request.body as { city: string; timezone: string };
      const city = body.city.trim();
      const timezone = body.timezone.trim();
      // The schema's minLength only sees the raw string; whitespace-only
      // would trim to an empty city (invalid_timezone-style app-level check).
      if (city.length === 0) throw invalidCityError();
      if (!isValidTimezone(timezone)) throw invalidTimezoneError(timezone);
      const newId = randomUUID();
      // sort_order is "append at the end", computed atomically in one statement.
      // The MAX is scoped per user (AUTH-3): each user's list is numbered 1..n
      // independently of other users' entries.
      await db.withTransaction(async (tx) => {
        await lockOwnedTables(tx, ["clock.world_clocks"]);
        await lockOwnerSet(tx, user.id, "clock.world_clocks");
        await tx.query(
          `INSERT INTO clock.world_clocks (id, user_id, city, timezone, sort_order)
           SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order), 0) + 1
           FROM clock.world_clocks WHERE user_id = $2`,
          [newId, user.id, city, timezone],
        );
      });
      return reply.code(201).send(await findWorldClockView(db, newId, user.id));
    },
  });

  ctx.api.patch<{ Params: { id: string } }>("/world-clocks/:id", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          city: { type: "string", minLength: 1, maxLength: 60 },
          timezone: { type: "string", minLength: 1, maxLength: 64 },
          baseHash: { type: "string" },
        },
      },
    },
    async handler(request) {
      const user = await ctx.auth.requireUser(request);
      if (!isUuid(request.params.id)) throw new AppError(404, "not_found", "world clock not found");
      const body = request.body as { city?: string; timezone?: string; baseHash?: unknown };
      const presented = readPresentedHash(body.baseHash);
      const city = body.city?.trim();
      const timezone = body.timezone?.trim();
      if (city !== undefined && city.length === 0) throw invalidCityError();
      if (timezone !== undefined && !isValidTimezone(timezone)) throw invalidTimezoneError(timezone);
      const sets: string[] = [];
      const params: unknown[] = [request.params.id, user.id];
      if (city !== undefined) {
        params.push(city);
        sets.push(`city = $${params.length}`);
      }
      if (timezone !== undefined) {
        params.push(timezone);
        sets.push(`timezone = $${params.length}`);
      }
      if (sets.length > 0) {
        await db.withTransaction(async (tx) => {
          await lockOwnedTables(tx, ["clock.world_clocks"]);
          const current = await tx.query<{ snapshot: string }>(
            "SELECT row_to_json(w)::text AS snapshot FROM clock.world_clocks w WHERE id = $1 AND user_id = $2 FOR UPDATE",
            [request.params.id, user.id],
          );
          if (!current.rows[0]) throw new AppError(404, "not_found", "world clock not found");
          assertPresentedHash(await syncWriteFenced(tx, user.id), presented, clockRowHash("clock.world_clocks", current.rows[0].snapshot));
          const updated = await tx.query(
            `UPDATE clock.world_clocks SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`,
            params,
          );
          if (updated.rowCount === 0) throw new AppError(404, "not_found", "world clock not found");
        });
        return findWorldClockView(db, request.params.id, user.id);
      }
      const view = await findWorldClockView(db, request.params.id, user.id);
      if (!view) throw new AppError(404, "not_found", "world clock not found");
      return view;
    },
  });

  ctx.api.delete<{ Params: { id: string } }>("/world-clocks/:id", async (request, reply) => {
    const user = await ctx.auth.requireUser(request);
    if (!isUuid(request.params.id)) throw new AppError(404, "not_found", "world clock not found");
    const presented = headerPresentedHash(request.headers["x-base-hash"]);
    await db.withTransaction(async (tx) => {
      await lockOwnedTables(tx, ["clock.world_clocks"]);
      await lockOwnerSet(tx, user.id, "clock.world_clocks");
      const current = await tx.query<{ snapshot: string }>(
        "SELECT row_to_json(w)::text AS snapshot FROM clock.world_clocks w WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [request.params.id, user.id],
      );
      if (!current.rows[0]) throw new AppError(404, "not_found", "world clock not found");
      assertPresentedHash(await syncWriteFenced(tx, user.id), presented, clockRowHash("clock.world_clocks", current.rows[0].snapshot));
      await tx.query("DELETE FROM clock.world_clocks WHERE id = $1 AND user_id = $2", [request.params.id, user.id]);
    });
    return reply.code(204).send();
  });

  // Explicit full-order replace: the client sends the complete id list in its
  // desired order and gets a dense 1..n renumber. Anything else is a 422.
  ctx.api.put("/world-clocks/order", {
    schema: {
      body: {
        type: "object",
        required: ["ids"],
        additionalProperties: false,
        properties: {
          ids: { type: "array", items: { type: "string", maxLength: 64 } },
          baseHash: { type: "string" },
        },
      },
    },
    async handler(request) {
      const user = await ctx.auth.requireUser(request);
      const body = request.body as { ids: string[]; baseHash?: unknown };
      const ids = body.ids;
      const presented = readPresentedHash(body.baseHash);
      const invalid = ids.filter((value) => !isUuid(value));
      if (invalid.length > 0) {
        throw new AppError(400, "validation_error", `ids must be uuids (got "${invalid[0]}")`, {
          ids: invalid,
        });
      }
      if (new Set(ids).size !== ids.length) {
        throw new AppError(422, "invalid_order", "ids must not contain duplicates", { ids });
      }
      // Only the calling user's entries may be (re)ordered (AUTH-3).
      await db.withTransaction(async (tx) => {
        await lockOwnedTables(tx, ["clock.world_clocks"]);
        await lockOwnerSet(tx, user.id, "clock.world_clocks");
        const existing = await tx.query<{ id: string; snapshot: string }>(
          "SELECT id, row_to_json(w)::text AS snapshot FROM clock.world_clocks w WHERE user_id = $1 ORDER BY sort_order ASC, created_at ASC FOR UPDATE",
          [user.id],
        );
        const existingIds = new Set(existing.rows.map((row) => row.id));
        if (ids.length !== existingIds.size || ids.some((value) => !existingIds.has(value))) {
          throw new AppError(422, "invalid_order", "ids must list every world clock exactly once", {
            known: [...existingIds],
          });
        }
        const parts = existing.rows.map((row) => ({ table: "clock.world_clocks", row: parseSnapshotRow(row.snapshot) }));
        const actual = parts.length === 0
          ? singletonBaseHash("clock.world_clocks", { id: "absent", sort_order: 0 })
          : editorBaseHash(parts);
        assertPresentedHash(await syncWriteFenced(tx, user.id), presented, actual);
        for (let index = 0; index < ids.length; index += 1) {
          await tx.query(
            "UPDATE clock.world_clocks SET sort_order = $2, updated_at = now() WHERE id = $1 AND user_id = $3",
            [ids[index], index + 1, user.id],
          );
        }
      });
      return worldClockList(db, user.id);
    },
  });
}

async function worldClockList(db: Db, userId: string): Promise<{ items: Array<WorldClockView & { baseHash: string }>; orderHash: string }> {
  const { rows } = await db.query<WorldClockRow & { snapshot: string }>(
    "SELECT w.*, row_to_json(w)::text AS snapshot FROM clock.world_clocks w WHERE user_id = $1 ORDER BY sort_order ASC, created_at ASC",
    [userId],
  );
  const parts = rows.map((row) => ({ table: "clock.world_clocks", row: parseSnapshotRow(row.snapshot) }));
  return {
    items: rows.map((row) => ({ ...toWorldClockView(row), baseHash: clockRowHash("clock.world_clocks", row.snapshot) })),
    orderHash: parts.length === 0 ? singletonBaseHash("clock.world_clocks", { id: "absent", sort_order: 0 }) : editorBaseHash(parts),
  };
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM clock.alarms LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const clockApp: BackendAppModule = { id, registerApi, healthcheck };

export default clockApp;
