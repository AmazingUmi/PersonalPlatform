import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import {
  DEFAULT_SORT_BY,
  MOODS,
  SORT_COLUMNS,
  dayKeys,
  dedupeTagIds,
  isUuid,
  normalizeTagName,
  parseTagsQuery,
  type Mood,
} from "./model.js";

/** Database surface derived from AppContext (never from core internals — focus repository precedent). */
type Db = AppContext["database"];

interface NoteRow {
  id: string;
  title: string | null;
  content: string;
  mood: Mood | null;
  occurred_at: Date;
  pinned: boolean;
  created_at: Date;
  updated_at: Date;
  day_key: string;
  /** Window count over the full filtered set (present on list rows only). */
  total_count?: number;
}

interface TagLinkRow {
  note_id: string;
  id: string;
  name: string;
}

interface TagRow {
  id: string;
  name: string;
  created_at: Date;
}

export interface NoteTagView {
  id: string;
  name: string;
}

export interface NoteView {
  id: string;
  title: string | null;
  content: string;
  mood: Mood | null;
  occurredAt: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  tags: NoteTagView[];
  dayKey: string;
}

export interface TagView {
  id: string;
  name: string;
  createdAt: string;
}

const id = "notes";

/** Hard server-side cap; V1 ships no pagination (worklist §2.5). */
const LIST_LIMIT = 500;

const NOTE_COLUMNS = "id, title, content, mood, occurred_at, pinned, created_at, updated_at";

function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23503";
}

/** camelCase view boundary (mini_game toSave precedent — not assets' snake_case pass-through). */
function toNoteView(row: NoteRow, tags: NoteTagView[]): NoteView {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    mood: row.mood,
    occurredAt: row.occurred_at.toISOString(),
    pinned: row.pinned,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    tags,
    dayKey: row.day_key,
  };
}

function toTagView(row: TagRow): TagView {
  return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() };
}

/**
 * Body tagIds must be uuids so a malformed id fails validation at the boundary
 * (400) instead of surfacing as a pg 22P02 parse error on the FK insert.
 */
function assertValidTagIds(tagIds: string[]): void {
  const invalid = tagIds.filter((tagId) => !isUuid(tagId));
  if (invalid.length > 0) {
    throw new AppError(400, "validation_error", `tagIds must be uuids (got "${invalid[0]}")`, {
      tagIds: invalid,
    });
  }
}

/** Tags for a batch of notes, ordered by name; empty ids → empty map. */
async function tagsForNotes(db: Db, noteIds: string[]): Promise<Map<string, NoteTagView[]>> {
  const map = new Map<string, NoteTagView[]>();
  if (noteIds.length === 0) return map;
  const { rows } = await db.query<TagLinkRow>(
    `SELECT nt.note_id, t.id, t.name
     FROM notes.note_tags nt
     JOIN notes.tags t ON t.id = nt.tag_id
     WHERE nt.note_id = ANY($1)
     ORDER BY t.name, t.id`,
    [noteIds],
  );
  for (const row of rows) {
    const list = map.get(row.note_id) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.note_id, list);
  }
  return map;
}

/**
 * Single note with embedded tags and the server-computed dayKey. The dayKey
 * expression is the same parameterized `(occurred_at AT TIME ZONE $tz)::date`
 * form the list filter uses, so grouping and filtering never drift apart
 * (focus repository AT TIME ZONE precedent; CURRENT_DATE is forbidden).
 */
async function findNoteView(db: Db, noteId: string, timezone: string): Promise<NoteView | null> {
  const { rows } = await db.query<NoteRow>(
    `SELECT ${NOTE_COLUMNS}, (occurred_at AT TIME ZONE $2)::date::text AS day_key
     FROM notes.notes WHERE id = $1`,
    [noteId, timezone],
  );
  if (!rows[0]) return null;
  const tags = await tagsForNotes(db, [noteId]);
  return toNoteView(rows[0], tags.get(noteId) ?? []);
}

async function requireNoteView(db: Db, noteId: string, timezone: string): Promise<NoteView> {
  const view = await findNoteView(db, noteId, timezone);
  if (!view) throw new AppError(404, "not_found", "note not found");
  return view;
}

/**
 * Replace a note's tag set wholesale (PATCH tagIds semantics). Must run inside
 * the same transaction as any note-field update so an FK failure rolls the
 * whole update back (worklist §8).
 */
async function replaceNoteTags(tx: Db, noteId: string, tagIds: string[]): Promise<void> {
  await tx.query("DELETE FROM notes.note_tags WHERE note_id = $1", [noteId]);
  if (tagIds.length > 0) {
    await tx.query("INSERT INTO notes.note_tags (note_id, tag_id) SELECT $1, unnest($2::uuid[])", [
      noteId,
      tagIds,
    ]);
  }
}

function tagNotFoundError(tagIds: string[]): AppError {
  return new AppError(422, "tag_not_found", "tagIds reference tags that do not exist", { tagIds });
}

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;
  const timezone = (): string => ctx.time.timezone();

  ctx.api.get<{ Querystring: Record<string, string> }>(
    "/notes",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", maxLength: 300 },
            tags: { type: "string" },
            mood: { enum: [...MOODS] },
            pinned: { enum: ["true", "false"] },
            occurredFrom: { type: "string", format: "date" },
            occurredTo: { type: "string", format: "date" },
            sortBy: { enum: Object.keys(SORT_COLUMNS) },
            order: { enum: ["asc", "desc"] },
          },
        },
      },
    },
    async (request) => {
      const query = request.query;
      const tagFilter = parseTagsQuery(query.tags);
      const params: unknown[] = [];
      const placeholder = (value: unknown): string => `$${params.push(value)}`;
      // One timezone parameter shared by the dayKey projection and the
      // occurredFrom/To filters — same expression, same value, no drift.
      const tzParam = placeholder(ctx.time.timezone());
      const conditions: string[] = [];
      if (query.q) {
        const p = placeholder(`%${query.q}%`);
        conditions.push(
          `(n.title ILIKE ${p} OR n.content ILIKE ${p} OR EXISTS (
             SELECT 1 FROM notes.note_tags nt
             JOIN notes.tags t ON t.id = nt.tag_id
             WHERE nt.note_id = n.id AND t.name ILIKE ${p}
           ))`,
        );
      }
      // Multi-tag AND: one EXISTS per requested id (repo EXISTS style).
      for (const tagId of tagFilter) {
        const p = placeholder(tagId);
        conditions.push(
          `EXISTS (SELECT 1 FROM notes.note_tags nt WHERE nt.note_id = n.id AND nt.tag_id = ${p})`,
        );
      }
      if (query.mood) {
        const p = placeholder(query.mood);
        conditions.push(`n.mood = ${p}`);
      }
      if (query.pinned !== undefined) {
        const p = placeholder(query.pinned === "true");
        conditions.push(`n.pinned = ${p}`);
      }
      if (query.occurredFrom) {
        const p = placeholder(query.occurredFrom);
        conditions.push(`(n.occurred_at AT TIME ZONE ${tzParam})::date >= ${p}::date`);
      }
      if (query.occurredTo) {
        const p = placeholder(query.occurredTo);
        conditions.push(`(n.occurred_at AT TIME ZONE ${tzParam})::date <= ${p}::date`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const sortColumn = SORT_COLUMNS[query.sortBy ?? DEFAULT_SORT_BY] ?? SORT_COLUMNS[DEFAULT_SORT_BY];
      const direction = query.order === "asc" ? "ASC" : "DESC";
      // Stable tie-break per worklist §2.4.
      const orderBy = `${sortColumn} ${direction}, created_at DESC, id`;

      const { rows } = await db.query<NoteRow>(
        `SELECT ${NOTE_COLUMNS}, (n.occurred_at AT TIME ZONE ${tzParam})::date::text AS day_key,
                (count(*) OVER ())::int AS total_count
         FROM notes.notes n
         ${where}
         ORDER BY ${orderBy}
         LIMIT ${LIST_LIMIT}`,
        params,
      );
      const tags = await tagsForNotes(db, rows.map((row) => row.id));
      const keys = dayKeys(ctx.time.timezone(), ctx.time.todayRangeUtc().start);
      return {
        items: rows.map((row) => toNoteView(row, tags.get(row.id) ?? [])),
        total: rows[0]?.total_count ?? 0,
        todayKey: keys.todayKey,
        yesterdayKey: keys.yesterdayKey,
      };
    },
  );

  ctx.api.post<{
    Body: {
      content: string;
      title?: string | null;
      mood?: string | null;
      occurredAt?: string | null;
      pinned?: boolean;
      tagIds?: string[];
    };
  }>(
    "/notes",
    {
      schema: {
        body: {
          type: "object",
          required: ["content"],
          additionalProperties: false,
          properties: {
            content: { type: "string", minLength: 1, maxLength: 100_000 },
            title: { type: ["string", "null"], maxLength: 300 },
            mood: { enum: [...MOODS, null] },
            occurredAt: { type: ["string", "null"], format: "date-time" },
            pinned: { type: "boolean" },
            tagIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const tagIds = dedupeTagIds(b.tagIds ?? []);
      assertValidTagIds(tagIds);
      // occurred_at has no DB default on purpose (worklist §1): the handler
      // injects the platform clock. An explicit null takes the same default —
      // the column is NOT NULL and "no custom time" means capture time.
      const occurredAt = b.occurredAt ?? ctx.time.now().toISOString();
      const newId = randomUUID();
      try {
        await ctx.database.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO notes.notes (id, title, content, mood, occurred_at, pinned)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [newId, b.title ?? null, b.content, b.mood ?? null, occurredAt, b.pinned ?? false],
          );
          await replaceNoteTags(tx, newId, tagIds);
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) throw tagNotFoundError(tagIds);
        throw error;
      }
      // capabilities.events is false: no publish (worklist §2.6).
      return reply.code(201).send(await requireNoteView(db, newId, timezone()));
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/notes/:id", async (request) => {
    return requireNoteView(db, request.params.id, timezone());
  });

  // Partial update with three-state semantics (assets PATCH precedent):
  // absent = keep, explicit null = clear (title/mood), value = update.
  ctx.api.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/notes/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            // Value-only: content is NOT NULL, so an explicit null is a 400
            // rather than a "clear" (only title/mood are clearable).
            content: { type: "string", minLength: 1, maxLength: 100_000 },
            title: { type: ["string", "null"], maxLength: 300 },
            mood: { enum: [...MOODS, null] },
            occurredAt: { type: ["string", "null"], format: "date-time" },
            pinned: { type: "boolean" },
            // Arrays only: `tagIds: null` fails this schema → 400 (use [] to clear).
            tagIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request) => {
      const body = request.body;
      const columns: Array<[string, string]> = [
        ["content", "content"],
        ["title", "title"],
        ["mood", "mood"],
        ["occurredAt", "occurred_at"],
        ["pinned", "pinned"],
      ];
      const sets: string[] = [];
      const params: unknown[] = [request.params.id];
      for (const [key, column] of columns) {
        if (!(key in body)) continue;
        // occurred_at is NOT NULL: an explicit null re-stamps with the platform
        // clock, the same "no custom time" default POST uses.
        const value = key === "occurredAt" && body[key] === null ? ctx.time.now().toISOString() : body[key];
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
      const replaceTags = "tagIds" in body;
      const tagIds = replaceTags ? dedupeTagIds(body.tagIds as string[]) : [];
      if (replaceTags) assertValidTagIds(tagIds);

      if (sets.length === 0 && !replaceTags) {
        // Nothing mutable supplied: return the current view as-is.
        return requireNoteView(db, request.params.id, timezone());
      }

      try {
        await ctx.database.withTransaction(async (tx) => {
          if (sets.length > 0) {
            sets.push("updated_at = now()");
            const updated = await tx.query(
              `UPDATE notes.notes SET ${sets.join(", ")} WHERE id = $1 RETURNING id`,
              params,
            );
            if (!updated.rows[0]) throw new AppError(404, "not_found", "note not found");
          } else {
            const exists = await tx.query("SELECT id FROM notes.notes WHERE id = $1", [
              request.params.id,
            ]);
            if (!exists.rows[0]) throw new AppError(404, "not_found", "note not found");
          }
          if (replaceTags) await replaceNoteTags(tx, request.params.id, tagIds);
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) throw tagNotFoundError(tagIds);
        throw error;
      }
      return requireNoteView(db, request.params.id, timezone());
    },
  );

  // Deleting a note cascades its note_tags rows (FK ON DELETE CASCADE).
  ctx.api.delete<{ Params: { id: string } }>("/notes/:id", async (request, reply) => {
    const result = await db.query("DELETE FROM notes.notes WHERE id = $1", [request.params.id]);
    if (result.rowCount === 0) throw new AppError(404, "not_found", "note not found");
    return reply.code(204).send();
  });

  ctx.api.get("/tags", async () => {
    const { rows } = await db.query<TagRow>("SELECT id, name, created_at FROM notes.tags ORDER BY name");
    return { items: rows.map(toTagView) };
  });

  // Get-or-create upsert (worklist §2.3): the UNIQUE conflict is absorbed by
  // ON CONFLICT DO NOTHING — a 23505 path never reaches the error mapper.
  ctx.api.post<{ Body: { name: string } }>(
    "/tags",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const name = normalizeTagName(request.body.name);
      if (name === null) {
        throw new AppError(400, "validation_error", "tag name must be 1-50 characters after trimming");
      }
      const inserted = await db.query<TagRow>(
        "INSERT INTO notes.tags (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING id, name, created_at",
        [randomUUID(), name],
      );
      if (inserted.rows[0]) return reply.code(201).send(toTagView(inserted.rows[0]));
      const existing = await db.query<TagRow>(
        "SELECT id, name, created_at FROM notes.tags WHERE name = $1",
        [name],
      );
      if (!existing.rows[0]) throw new AppError(500, "internal_error", "tag vanished after upsert");
      return reply.code(200).send(toTagView(existing.rows[0]));
    },
  );

  // Deleting a tag keeps notes (only the note_tags links cascade away).
  ctx.api.delete<{ Params: { id: string } }>("/tags/:id", async (request, reply) => {
    const result = await db.query("DELETE FROM notes.tags WHERE id = $1", [request.params.id]);
    if (result.rowCount === 0) throw new AppError(404, "not_found", "tag not found");
    return reply.code(204).send();
  });
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM notes.notes LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, healthcheck };
export default app;
