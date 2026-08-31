import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
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
}

export interface WorldClockView {
  id: string;
  city: string;
  timezone: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
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
async function findAlarmView(db: Db, alarmId: string): Promise<AlarmView | null> {
  if (!isUuid(alarmId)) return null;
  const { rows } = await db.query<AlarmRow>("SELECT * FROM clock.alarms WHERE id = $1", [alarmId]);
  return rows[0] ? toAlarmView(rows[0]) : null;
}

async function findWorldClockView(db: Db, id: string): Promise<WorldClockView | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<WorldClockRow>(
    "SELECT * FROM clock.world_clocks WHERE id = $1",
    [id],
  );
  return rows[0] ? toWorldClockView(rows[0]) : null;
}

const id = "clock";
const SETTINGS_ID = "current";

async function getSettings(db: Db): Promise<ClockSettingsView> {
  const { rows } = await db.query<{ value: unknown }>(
    "SELECT value FROM clock.settings WHERE id = $1",
    [SETTINGS_ID],
  );
  return sanitizeClockSettings(rows[0]?.value) ?? DEFAULT_CLOCK_SETTINGS;
}

async function saveSettings(db: Db, next: ClockSettingsView): Promise<void> {
  await db.query(
    `INSERT INTO clock.settings (id, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTINGS_ID, JSON.stringify(next)],
  );
}

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  // ---- Settings (focus GET/PUT /settings precedent: single-row, full replace).
  // One source of truth — the dashboard card and the app page read the same row.

  ctx.api.get("/settings", async () => getSettings(db));

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
        },
      },
    },
    async handler(request) {
      // Defense in depth after the schema (focus PUT /settings precedent).
      const sanitized = sanitizeClockSettings(request.body);
      if (!sanitized) {
        throw new AppError(422, "invalid_settings", "settings payload is not a legal settings object");
      }
      await saveSettings(db, sanitized);
      return getSettings(db);
    },
  });

  // ---- Alarms. `time` is a local wall-clock 'HH:MM' — firing is detected by
  // the client while the app is open (browser limitation, see apps/clock/README.md).

  ctx.api.get("/alarms", async () => {
    const { rows } = await db.query<AlarmRow>(
      "SELECT * FROM clock.alarms ORDER BY time ASC, created_at ASC",
    );
    return { items: rows.map(toAlarmView) };
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
      const body = request.body as {
        time: string;
        label?: string;
        enabled?: boolean;
        repeatDays?: number[];
      };
      const newId = randomUUID();
      await db.query(
        `INSERT INTO clock.alarms (id, time, label, enabled, repeat_days)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId, body.time, body.label?.trim() ?? "", body.enabled ?? true, body.repeatDays ?? []],
      );
      return reply.code(201).send(await findAlarmView(db, newId));
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
        },
      },
    },
    async handler(request) {
      if (!isUuid(request.params.id)) throw new AppError(404, "not_found", "alarm not found");
      const body = request.body as {
        time?: string;
        label?: string | null;
        enabled?: boolean;
        repeatDays?: number[];
      };
      if (Object.keys(body).length === 0) {
        const view = await findAlarmView(db, request.params.id);
        if (!view) throw new AppError(404, "not_found", "alarm not found");
        return view;
      }
      const sets: string[] = [];
      const params: unknown[] = [request.params.id];
      const set = (column: string, value: unknown): void => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (body.time !== undefined) set("time", body.time);
      if (body.label !== undefined) set("label", body.label === null ? "" : body.label.trim());
      if (body.enabled !== undefined) set("enabled", body.enabled);
      if (body.repeatDays !== undefined) set("repeat_days", normalizeRepeatDays(body.repeatDays));
      const updated = await db.query<AlarmRow>(
        `UPDATE clock.alarms SET ${sets.join(", ")}, updated_at = now()
         WHERE id = $1 RETURNING *`,
        params,
      );
      if (!updated.rows[0]) throw new AppError(404, "not_found", "alarm not found");
      return toAlarmView(updated.rows[0]);
    },
  });

  ctx.api.delete<{ Params: { id: string } }>("/alarms/:id", async (request, reply) => {
    if (!isUuid(request.params.id)) throw new AppError(404, "not_found", "alarm not found");
    const result = await db.query("DELETE FROM clock.alarms WHERE id = $1", [request.params.id]);
    if (result.rowCount === 0) throw new AppError(404, "not_found", "alarm not found");
    return reply.code(204).send();
  });

  // ---- World clocks. Timezone is always stored as an IANA name (never a UTC
  // offset) so DST is resolved by Intl at display time, not by stored data.

  ctx.api.get("/world-clocks", async () => {
    const { rows } = await db.query<WorldClockRow>(
      "SELECT * FROM clock.world_clocks ORDER BY sort_order ASC, created_at ASC",
    );
    return { items: rows.map(toWorldClockView) };
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
      const body = request.body as { city: string; timezone: string };
      const city = body.city.trim();
      const timezone = body.timezone.trim();
      // The schema's minLength only sees the raw string; whitespace-only
      // would trim to an empty city (invalid_timezone-style app-level check).
      if (city.length === 0) throw invalidCityError();
      if (!isValidTimezone(timezone)) throw invalidTimezoneError(timezone);
      const newId = randomUUID();
      // sort_order is "append at the end", computed atomically in one statement.
      await db.query(
        `INSERT INTO clock.world_clocks (id, city, timezone, sort_order)
         SELECT $1, $2, $3, COALESCE(MAX(sort_order), 0) + 1 FROM clock.world_clocks`,
        [newId, city, timezone],
      );
      return reply.code(201).send(await findWorldClockView(db, newId));
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
        },
      },
    },
    async handler(request) {
      if (!isUuid(request.params.id)) throw new AppError(404, "not_found", "world clock not found");
      const body = request.body as { city?: string; timezone?: string };
      const city = body.city?.trim();
      const timezone = body.timezone?.trim();
      if (city !== undefined && city.length === 0) throw invalidCityError();
      if (timezone !== undefined && !isValidTimezone(timezone)) throw invalidTimezoneError(timezone);
      const sets: string[] = [];
      const params: unknown[] = [request.params.id];
      if (city !== undefined) {
        params.push(city);
        sets.push(`city = $${params.length}`);
      }
      if (timezone !== undefined) {
        params.push(timezone);
        sets.push(`timezone = $${params.length}`);
      }
      if (sets.length > 0) {
        const updated = await db.query<WorldClockRow>(
          `UPDATE clock.world_clocks SET ${sets.join(", ")}, updated_at = now()
           WHERE id = $1 RETURNING *`,
          params,
        );
        if (!updated.rows[0]) throw new AppError(404, "not_found", "world clock not found");
        return toWorldClockView(updated.rows[0]);
      }
      const view = await findWorldClockView(db, request.params.id);
      if (!view) throw new AppError(404, "not_found", "world clock not found");
      return view;
    },
  });

  ctx.api.delete<{ Params: { id: string } }>("/world-clocks/:id", async (request, reply) => {
    if (!isUuid(request.params.id)) throw new AppError(404, "not_found", "world clock not found");
    const result = await db.query("DELETE FROM clock.world_clocks WHERE id = $1", [
      request.params.id,
    ]);
    if (result.rowCount === 0) throw new AppError(404, "not_found", "world clock not found");
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
          ids: { type: "array", minItems: 1, items: { type: "string", maxLength: 64 } },
        },
      },
    },
    async handler(request) {
      const ids = (request.body as { ids: string[] }).ids;
      const invalid = ids.filter((value) => !isUuid(value));
      if (invalid.length > 0) {
        throw new AppError(400, "validation_error", `ids must be uuids (got "${invalid[0]}")`, {
          ids: invalid,
        });
      }
      if (new Set(ids).size !== ids.length) {
        throw new AppError(422, "invalid_order", "ids must not contain duplicates", { ids });
      }
      const existing = await db.query<{ id: string }>("SELECT id FROM clock.world_clocks");
      const existingIds = new Set(existing.rows.map((row) => row.id));
      if (ids.length !== existingIds.size || ids.some((value) => !existingIds.has(value))) {
        throw new AppError(422, "invalid_order", "ids must list every world clock exactly once", {
          known: [...existingIds],
        });
      }
      await db.withTransaction(async (tx) => {
        for (let index = 0; index < ids.length; index += 1) {
          await tx.query(
            "UPDATE clock.world_clocks SET sort_order = $2, updated_at = now() WHERE id = $1",
            [ids[index], index + 1],
          );
        }
      });
      const { rows } = await db.query<WorldClockRow>(
        "SELECT * FROM clock.world_clocks ORDER BY sort_order ASC, created_at ASC",
      );
      return { items: rows.map(toWorldClockView) };
    },
  });
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM clock.alarms LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const clockApp: BackendAppModule = { id, registerApi, healthcheck };

export default clockApp;
