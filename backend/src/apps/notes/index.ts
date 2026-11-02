import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import {
  assertPresentedHash, editorBaseHash, headerPresentedHash, lockOwnedTables, lockOwnerSet, parseSnapshotRow, parseSnapshotRows, readPresentedHash, syncWriteFenced,
} from "../../core/data-management/sync-fence.js";
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
  baseHash: string;
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
const NOTE_SNAPSHOT_SQL = `
  row_to_json(n)::text AS note_snapshot,
  COALESCE((SELECT json_agg(row_to_json(nt) ORDER BY nt.tag_id) FROM notes.note_tags nt WHERE nt.note_id = n.id), '[]'::json) AS link_snapshot,
  COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name, t.id)
            FROM notes.note_tags nt JOIN notes.tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id), '[]'::json) AS tag_views`;

type Tx = AppContext["database"];

/** Table locks, then one notes-wide advisory, then parent and link reads. */
async function lockedNoteHash(tx: Tx, userId: string, noteId: string): Promise<string | null> {
  await lockOwnerSet(tx, userId, "notes");
  const note = await tx.query<{ snapshot: string }>(
    "SELECT row_to_json(n)::text AS snapshot FROM notes.notes n WHERE n.id = $1 AND n.user_id = $2 FOR UPDATE",
    [noteId, userId],
  );
  if (!note.rows[0]) return null;
  const links = await tx.query<{ snapshot: string }>(
    "SELECT row_to_json(nt)::text AS snapshot FROM notes.note_tags nt WHERE nt.note_id = $1 ORDER BY nt.tag_id FOR UPDATE",
    [noteId],
  );
  return noteBaseHash(note.rows[0].snapshot, links.rows.map((row) => parseSnapshotRow(row.snapshot)));
}

function noteBaseHash(noteSnapshot: string, linkSnapshot: unknown): string {
  return editorBaseHash([
    { table: "notes.notes", row: parseSnapshotRow(noteSnapshot) },
    ...parseSnapshotRows(linkSnapshot).map((row) => ({ table: "notes.note_tags", row })),
  ]);
}

function toNoteView(row: NoteRow, tags: NoteTagView[], baseHash: string): NoteView {
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
    baseHash,
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

/**
 * Single note with embedded tags and the server-computed dayKey. The dayKey
 * expression is the same parameterized `(occurred_at AT TIME ZONE $tz)::date`
 * form the list filter uses, so grouping and filtering never drift apart
 * (focus repository AT TIME ZONE precedent; CURRENT_DATE is forbidden).
 * AUTH-3: scoped to the owning user — a foreign note id is a 404, never a leak.
 */
async function findNoteView(
  db: Db,
  noteId: string,
  timezone: string,
  userId: string,
): Promise<NoteView | null> {
  const { rows } = await db.query<NoteRow & { note_snapshot: string; link_snapshot: unknown; tag_views: NoteTagView[] | null }>(
    `SELECT ${NOTE_COLUMNS}, (n.occurred_at AT TIME ZONE $2)::date::text AS day_key,
            ${NOTE_SNAPSHOT_SQL}
     FROM notes.notes n WHERE n.id = $1 AND n.user_id = $3`,
    [noteId, timezone, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return toNoteView(row, row.tag_views ?? [], noteBaseHash(row.note_snapshot, row.link_snapshot));
}

async function requireNoteView(
  db: Db,
  noteId: string,
  timezone: string,
  userId: string,
): Promise<NoteView> {
  const view = await findNoteView(db, noteId, timezone, userId);
  if (!view) throw new AppError(404, "not_found", "note not found");
  return view;
}

/**
 * Replace a note's tag set wholesale (PATCH tagIds semantics). Must run inside
 * the same transaction as any note-field update so a failure rolls the whole
 * update back (worklist §8). AUTH-3: only tags owned by the same user may be
 * linked — the INSERT ... SELECT filters on user_id, so a foreign user's tag
 * id is indistinguishable from a nonexistent one and fails the count check
 * with the same 422 tag_not_found (never a cross-user attach).
 */
async function replaceNoteTags(
  tx: Db,
  noteId: string,
  tagIds: string[],
  userId: string,
): Promise<void> {
  await tx.query("DELETE FROM notes.note_tags WHERE note_id = $1", [noteId]);
  if (tagIds.length === 0) return;
  const inserted = await tx.query(
    `INSERT INTO notes.note_tags (note_id, tag_id)
     SELECT $1, id FROM notes.tags WHERE id = ANY($2::uuid[]) AND user_id = $3`,
    [noteId, tagIds, userId],
  );
  if (inserted.rowCount !== tagIds.length) {
    throw tagNotFoundError(tagIds);
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
      const user = await ctx.auth.requireUser(request);
      const query = request.query;
      const tagFilter = parseTagsQuery(query.tags);
      const params: unknown[] = [];
      const placeholder = (value: unknown): string => `$${params.push(value)}`;
      // Ownership is the leading, always-present predicate (AUTH-3).
      const conditions: string[] = [`n.user_id = ${placeholder(user.id)}`];
      // One timezone parameter shared by the dayKey projection and the
      // occurredFrom/To filters — same expression, same value, no drift.
      const tzParam = placeholder(ctx.time.timezone());
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
      // conditions always holds the ownership predicate — the WHERE is never empty.
      const where = `WHERE ${conditions.join(" AND ")}`;

      const sortColumn = SORT_COLUMNS[query.sortBy ?? DEFAULT_SORT_BY] ?? SORT_COLUMNS[DEFAULT_SORT_BY];
      const direction = query.order === "asc" ? "ASC" : "DESC";
      // Stable tie-break per worklist §2.4.
      const orderBy = `${sortColumn} ${direction}, created_at DESC, id`;

      const { rows } = await db.query<NoteRow & { note_snapshot: string; link_snapshot: unknown; tag_views: NoteTagView[] | null }>(
        `SELECT ${NOTE_COLUMNS}, (n.occurred_at AT TIME ZONE ${tzParam})::date::text AS day_key,
                (count(*) OVER ())::int AS total_count,
                ${NOTE_SNAPSHOT_SQL}
         FROM notes.notes n
         ${where}
         ORDER BY ${orderBy}
         LIMIT ${LIST_LIMIT}`,
        params,
      );
      const keys = dayKeys(ctx.time.timezone(), ctx.time.todayRangeUtc().start);
      return {
        items: rows.map((row) => toNoteView(row, row.tag_views ?? [], noteBaseHash(row.note_snapshot, row.link_snapshot))),
        total: rows[0]?.total_count ?? 0,
        todayKey: keys.todayKey,
        yesterdayKey: keys.yesterdayKey,
      };
    },
  );

  // Lightweight count surface for shell chrome (dock badge / status chip):
  // the list route materializes every note just to expose `total`, so
  // polling it from the navigation would be wasteful.
  ctx.api.get("/summary", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM notes.notes WHERE user_id = $1",
      [user.id],
    );
    return { total: Number(rows[0]?.count ?? 0) };
  });

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
      const user = await ctx.auth.requireUser(request);
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
          await lockOwnedTables(tx, ["notes.notes", "notes.note_tags", "notes.tags"]);
          await lockOwnerSet(tx, user.id, "notes");
          await tx.query(
            `INSERT INTO notes.notes (id, user_id, title, content, mood, occurred_at, pinned)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newId, user.id, b.title ?? null, b.content, b.mood ?? null, occurredAt, b.pinned ?? false],
          );
          await replaceNoteTags(tx, newId, tagIds, user.id);
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) throw tagNotFoundError(tagIds);
        throw error;
      }
      // capabilities.events is false: no publish (worklist §2.6).
      return reply.code(201).send(await requireNoteView(db, newId, timezone(), user.id));
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/notes/:id", async (request) => {
    const user = await ctx.auth.requireUser(request);
    return requireNoteView(db, request.params.id, timezone(), user.id);
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
            baseHash: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const user = await ctx.auth.requireUser(request);
      const body = request.body;
      const presented = readPresentedHash(body.baseHash);
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
        return requireNoteView(db, request.params.id, timezone(), user.id);
      }
      // Ownership predicate appended after the SET params; foreign note ids
      // 404 (AUTH-3: never a 403, never another user's row).
      params.push(user.id);
      const owned = `id = $1 AND user_id = $${params.length}`;

      try {
        await ctx.database.withTransaction(async (tx) => {
          await lockOwnedTables(tx, ["notes.notes", "notes.note_tags"]);
          const actual = await lockedNoteHash(tx, user.id, request.params.id);
          if (actual === null) throw new AppError(404, "not_found", "note not found");
          assertPresentedHash(await syncWriteFenced(tx, user.id), presented, actual);
          if (sets.length > 0) {
            sets.push("updated_at = now()");
            const updated = await tx.query(
              `UPDATE notes.notes SET ${sets.join(", ")} WHERE ${owned} RETURNING id`,
              params,
            );
            if (!updated.rows[0]) throw new AppError(404, "not_found", "note not found");
          }
          if (replaceTags) await replaceNoteTags(tx, request.params.id, tagIds, user.id);
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) throw tagNotFoundError(tagIds);
        throw error;
      }
      return requireNoteView(db, request.params.id, timezone(), user.id);
    },
  );

  // Deleting a note cascades its note_tags rows (FK ON DELETE CASCADE).
  ctx.api.delete<{ Params: { id: string } }>("/notes/:id", async (request, reply) => {
    const user = await ctx.auth.requireUser(request);
    const presented = headerPresentedHash(request.headers["x-base-hash"]);
    await db.withTransaction(async (tx) => {
      await lockOwnedTables(tx, ["notes.notes", "notes.note_tags"]);
      const actual = await lockedNoteHash(tx, user.id, request.params.id);
      if (actual === null) throw new AppError(404, "not_found", "note not found");
      assertPresentedHash(await syncWriteFenced(tx, user.id), presented, actual);
      await tx.query("DELETE FROM notes.notes WHERE id = $1 AND user_id = $2", [request.params.id, user.id]);
    });
    return reply.code(204).send();
  });

  ctx.api.get("/tags", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const { rows } = await db.query<TagRow & { snapshot: string; link_snapshot: unknown }>(
      `SELECT t.id, t.name, t.created_at, row_to_json(t)::text AS snapshot,
              COALESCE((SELECT json_agg(row_to_json(nt) ORDER BY nt.note_id) FROM notes.note_tags nt WHERE nt.tag_id = t.id), '[]'::json) AS link_snapshot
       FROM notes.tags t WHERE t.user_id = $1 ORDER BY t.name`,
      [user.id],
    );
    return {
      items: rows.map((row) => ({
        ...toTagView(row),
        baseHash: editorBaseHash([
          { table: "notes.tags", row: parseSnapshotRow(row.snapshot) },
          ...parseSnapshotRows(row.link_snapshot).map((link) => ({ table: "notes.note_tags", row: link })),
        ]),
      })),
    };
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
      const user = await ctx.auth.requireUser(request);
      const name = normalizeTagName(request.body.name);
      if (name === null) {
        throw new AppError(400, "validation_error", "tag name must be 1-50 characters after trimming");
      }
      const inserted = await db.query<TagRow>(
        "INSERT INTO notes.tags (id, user_id, name) VALUES ($1, $2, $3) ON CONFLICT (user_id, name) DO NOTHING RETURNING id, name, created_at",
        [randomUUID(), user.id, name],
      );
      if (inserted.rows[0]) return reply.code(201).send(toTagView(inserted.rows[0]));
      const existing = await db.query<TagRow>(
        "SELECT id, name, created_at FROM notes.tags WHERE name = $1 AND user_id = $2",
        [name, user.id],
      );
      if (!existing.rows[0]) throw new AppError(500, "internal_error", "tag vanished after upsert");
      return reply.code(200).send(toTagView(existing.rows[0]));
    },
  );

  // Deleting a tag keeps notes (only the note_tags links cascade away).
  ctx.api.delete<{ Params: { id: string } }>("/tags/:id", async (request, reply) => {
    const user = await ctx.auth.requireUser(request);
    const presented = headerPresentedHash(request.headers["x-base-hash"]);
    await db.withTransaction(async (tx) => {
      await lockOwnedTables(tx, ["notes.tags", "notes.note_tags"]);
      await lockOwnerSet(tx, user.id, "notes");
      const tag = await tx.query<{ snapshot: string }>(
        "SELECT row_to_json(t)::text AS snapshot FROM notes.tags t WHERE t.id = $1 AND t.user_id = $2 FOR UPDATE",
        [request.params.id, user.id],
      );
      if (!tag.rows[0]) throw new AppError(404, "not_found", "tag not found");
      const links = await tx.query<{ snapshot: string }>(
        "SELECT row_to_json(nt)::text AS snapshot FROM notes.note_tags nt WHERE nt.tag_id = $1 ORDER BY nt.note_id FOR UPDATE",
        [request.params.id],
      );
      const actual = editorBaseHash([
        { table: "notes.tags", row: parseSnapshotRow(tag.rows[0].snapshot) },
        ...links.rows.map((link) => ({ table: "notes.note_tags", row: parseSnapshotRow(link.snapshot) })),
      ]);
      assertPresentedHash(await syncWriteFenced(tx, user.id), presented, actual);
      await tx.query("DELETE FROM notes.tags WHERE id = $1 AND user_id = $2", [request.params.id, user.id]);
    });
    return reply.code(204).send();
  });
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM notes.notes LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, healthcheck };
export default app;
