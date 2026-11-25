import { randomUUID } from "node:crypto";
import type { AppAgentContext, AppAgentInvocation } from "../../core/agent/types.js";
import { AppError } from "../../core/api/errors.js";
import {
  assertPresentedHash, editorBaseHash, headerPresentedHash, lockOwnedTables, lockOwnerSet, parseSnapshotRow, parseSnapshotRows, readPresentedHash, syncWriteFenced,
} from "../../core/data-management/sync-fence.js";
import { record, validTimestamp } from "../../core/data-management/snapshot-schema.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import type { OwnedTrashEntry, TrashMutationContext, TrashRestoreContext } from "../../core/trash/types.js";
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
type NoteMutation = { database: Db; userId: string; time: AppContext["time"] };

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
            FROM notes.note_tags nt JOIN notes.tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
            WHERE nt.note_id = n.id), '[]'::json) AS tag_views`;

type Tx = AppContext["database"];

/** Table locks, then one notes-wide advisory, then parent and link reads. */
async function lockedNote(tx: Tx, userId: string, noteId: string): Promise<(Pick<NoteRow, "id" | "title" | "content"> & {
  snapshot: string;
  baseHash: string;
}) | null> {
  await lockOwnerSet(tx, userId, "notes");
  const note = await tx.query<Pick<NoteRow, "id" | "title" | "content"> & { snapshot: string }>(
    "SELECT id, title, content, row_to_json(n)::text AS snapshot FROM notes.notes n WHERE n.id = $1 AND n.user_id = $2 FOR UPDATE",
    [noteId, userId],
  );
  const current = note.rows[0];
  if (!current) return null;
  const links = await tx.query<{ snapshot: string }>(
    "SELECT row_to_json(nt)::text AS snapshot FROM notes.note_tags nt WHERE nt.note_id = $1 ORDER BY nt.tag_id FOR UPDATE",
    [noteId],
  );
  return { ...current, baseHash: noteBaseHash(current.snapshot, links.rows.map((row) => parseSnapshotRow(row.snapshot))) };
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

export async function deleteNote(
  ctx: TrashMutationContext, noteId: string, presentedHash: string | undefined, agentTime?: AppContext["time"],
): Promise<void> {
  const { database: tx, userId } = ctx;
  await lockOwnedTables(tx, ["notes.notes", "notes.note_tags", "notes.tags"]);
  const current = await lockedNote(tx, userId, noteId);
  if (!current) throw new AppError(404, "not_found", "note not found");
  await assertNoteProof(tx, userId, noteId, current.baseHash, presentedHash, agentTime);

  const { rows } = await tx.query<{ tag: unknown }>(
    `SELECT json_build_object('id', t.id, 'name', t.name, 'created_at', t.created_at) AS tag
     FROM notes.note_tags nt JOIN notes.tags t ON t.id = nt.tag_id
     WHERE nt.note_id = $1 AND t.user_id = $2 ORDER BY t.id`,
    [noteId, userId],
  );
  const { title, content, mood, occurred_at, pinned, created_at, updated_at } = parseSnapshotRow(current.snapshot);
  const summary = current.content.trim().slice(0, 160) || null;
  await ctx.moveToTrash({
    entityType: "note", entityId: current.id, title: current.title?.trim() || "Untitled note", summary,
    payload: { title, content, mood, occurred_at, pinned, created_at, updated_at, tags: rows.map((row) => row.tag) },
  });
  await tx.query("DELETE FROM notes.notes WHERE id = $1 AND user_id = $2", [noteId, userId]);
}

type ArchivedTag = { id: string; name: string; created_at: string };

function isArchivedTag(tag: unknown): tag is ArchivedTag {
  return record(tag) && typeof tag.id === "string" && isUuid(tag.id)
    && typeof tag.name === "string" && typeof tag.created_at === "string" && validTimestamp(tag.created_at);
}

async function restoreTag(tx: Db, userId: string, tag: ArchivedTag): Promise<string> {
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM notes.tags WHERE user_id = $1 AND (id = $2 OR name = $3)
     ORDER BY (id = $2) DESC LIMIT 1 FOR KEY SHARE`,
    [userId, tag.id, tag.name],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO notes.tags (id, user_id, name, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, name) DO NOTHING RETURNING id`,
    [randomUUID(), userId, tag.name, tag.created_at],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  // Standalone tag creation also uses owner/name uniqueness and can win this insert.
  const concurrent = await tx.query<{ id: string }>(
    "SELECT id FROM notes.tags WHERE user_id = $1 AND name = $2 FOR KEY SHARE",
    [userId, tag.name],
  );
  if (!concurrent.rows[0]) throw tagNotFoundError([tag.id]);
  return concurrent.rows[0].id;
}

async function restoreFromTrash(ctx: TrashRestoreContext, entry: OwnedTrashEntry): Promise<{ restoredId: string }> {
  const { database: tx, userId, restoredId } = ctx;
  const payload = record(entry.payload) ? entry.payload : {};
  const { title, content, mood, occurred_at, pinned, created_at, updated_at, tags } = payload;
  if (entry.entityType !== "note" || entry.payloadVersion !== 1 || entry.attachmentKeys.length !== 0
    || (title !== null && typeof title !== "string") || typeof content !== "string"
    || (mood !== null && !MOODS.some((knownMood) => knownMood === mood)) || typeof pinned !== "boolean"
    || typeof occurred_at !== "string" || !validTimestamp(occurred_at)
    || typeof created_at !== "string" || !validTimestamp(created_at)
    || typeof updated_at !== "string" || !validTimestamp(updated_at)
    || !Array.isArray(tags) || !tags.every(isArchivedTag)) {
    throw new AppError(422, "trash_payload_invalid", "The archived note data is unsupported or invalid.");
  }

  await lockOwnedTables(tx, ["notes.notes", "notes.note_tags", "notes.tags"]);
  await lockOwnerSet(tx, userId, "notes");
  const original = await tx.query("SELECT 1 FROM notes.notes WHERE id = $1 AND user_id = $2", [entry.entityId, userId]);
  if (original.rowCount) throw new AppError(409, "original_live", "The original note already exists.");
  await tx.query(
    `INSERT INTO notes.notes (id, user_id, title, content, mood, occurred_at, pinned, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [restoredId, userId, title, content, mood, occurred_at, pinned, created_at, updated_at],
  );

  const tagIds = new Set<string>();
  for (const tag of tags) tagIds.add(await restoreTag(tx, userId, tag));
  await replaceNoteTags(tx, restoredId, [...tagIds], userId);
  return { restoredId };
}

interface NoteCreate {
  content: string;
  title?: string | null;
  mood?: string | null;
  occurredAt?: string | null;
  pinned?: boolean;
  tagIds?: string[];
}

const noteProperties = {
  content: { type: "string", minLength: 1, maxLength: 100_000 },
  title: { type: ["string", "null"], maxLength: 300 },
  mood: { enum: [...MOODS, null] },
  occurredAt: { type: ["string", "null"], format: "date-time" },
  pinned: { type: "boolean" },
  tagIds: { type: "array", items: { type: "string" } },
};

async function createNote({ database: tx, userId, time }: NoteMutation, body: NoteCreate): Promise<string> {
  const tagIds = dedupeTagIds(body.tagIds ?? []);
  assertValidTagIds(tagIds);
  const occurredAt = body.occurredAt ?? time.now().toISOString();
  const newId = randomUUID();
  try {
    await lockOwnedTables(tx, ["notes.notes", "notes.note_tags", "notes.tags"]);
    await lockOwnerSet(tx, userId, "notes");
    await tx.query(
      `INSERT INTO notes.notes (id, user_id, title, content, mood, occurred_at, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId, userId, body.title ?? null, body.content, body.mood ?? null, occurredAt, body.pinned ?? false],
    );
    await replaceNoteTags(tx, newId, tagIds, userId);
  } catch (error) {
    if (isForeignKeyViolation(error)) throw tagNotFoundError(tagIds);
    throw error;
  }
  return newId;
}

async function assertNoteProof(
  tx: Db, userId: string, noteId: string, actual: string, presented: string | undefined, agentTime?: AppContext["time"],
): Promise<void> {
  const fenced = await syncWriteFenced(tx, userId);
  if (agentTime && presented !== actual) {
    const current = await requireNoteView(tx, noteId, agentTime.timezone(), userId);
    throw new AppError(409, "conflict", "This note changed.", {
      current, retryHint: "Review the current note and retry with its baseHash.",
    });
  }
  assertPresentedHash(fenced, presented, actual);
}

async function updateNote(
  { database: tx, userId, time }: NoteMutation, noteId: string, body: Record<string, unknown>,
  presented: string | undefined, agent = false,
): Promise<void> {
  const columns = {
    content: "content", title: "title", mood: "mood", occurredAt: "occurred_at", pinned: "pinned",
  };
  const sets: string[] = [];
  const params: unknown[] = [noteId, userId];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in body)) continue;
    const value = key === "occurredAt" && body[key] === null ? time.now().toISOString() : body[key];
    sets.push(`${column} = $${params.push(value)}`);
  }
  const replaceTags = "tagIds" in body;
  const tagIds = replaceTags ? dedupeTagIds(body.tagIds as string[]) : [];
  if (replaceTags) assertValidTagIds(tagIds);
  if (!agent && !sets.length && !replaceTags) return;

  try {
    await lockOwnedTables(tx, ["notes.notes", "notes.note_tags"]);
    const current = await lockedNote(tx, userId, noteId);
    if (!current) throw new AppError(404, "not_found", "note not found");
    await assertNoteProof(tx, userId, noteId, current.baseHash, presented, agent ? time : undefined);
    if (sets.length) {
      sets.push("updated_at = now()");
      const updated = await tx.query(`UPDATE notes.notes SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id`, params);
      if (!updated.rowCount) throw new AppError(404, "not_found", "note not found");
    }
    if (replaceTags) await replaceNoteTags(tx, noteId, tagIds, userId);
  } catch (error) {
    if (isForeignKeyViolation(error)) throw tagNotFoundError(tagIds);
    throw error;
  }
}

type NoteAgentFilters = { q?: string; tag?: string; mood?: Mood; pinned?: boolean; includeContent?: boolean; limit?: number; offset?: number };
type NotePreviewRow = { id: string; title: string | null; content: string; mood: Mood | null; occurred_at: Date; pinned: boolean };

async function listAgentNotes({ database, userId }: AppAgentInvocation, filters: NoteAgentFilters) {
  const limit = filters.limit ?? 20;
  const offset = filters.offset ?? 0;
  const { rows } = await database.query<NotePreviewRow>(
    `SELECT n.id, n.title, CASE WHEN $2 THEN n.content ELSE left(n.content, 160) END AS content,
       n.mood, n.occurred_at, n.pinned FROM notes.notes n
     WHERE n.user_id = $1 AND ($3::text IS NULL OR n.title ILIKE $3 OR n.content ILIKE $3 OR EXISTS (
       SELECT 1 FROM notes.note_tags nt JOIN notes.tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
       WHERE nt.note_id = n.id AND t.name ILIKE $3
     )) AND ($4::text IS NULL OR EXISTS (
       SELECT 1 FROM notes.note_tags nt JOIN notes.tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
       WHERE nt.note_id = n.id AND (t.name = $4 OR t.id::text = $4)
     )) AND ($5::text IS NULL OR n.mood = $5) AND ($6::boolean IS NULL OR n.pinned = $6)
     ORDER BY n.occurred_at DESC, n.created_at DESC, n.id LIMIT $7 OFFSET $8`,
    [userId, filters.includeContent ?? false, filters.q ? `%${filters.q}%` : null, filters.tag ?? null, filters.mood ?? null,
      filters.pinned ?? null, limit + 1, offset],
  );
  return {
    items: rows.slice(0, limit).map(({ id, title, content, mood, occurred_at, pinned }) => ({
      id, title, ...(filters.includeContent ? { content } : { snippet: content }), mood, occurredAt: occurred_at.toISOString(), pinned,
    })),
    hasMore: rows.length > limit,
  };
}

async function noteOverview(ctx: AppAgentInvocation) {
  const { database, userId, time } = ctx;
  const { start, end } = time.todayRangeUtc();
  const { rows } = await database.query<{ total: number; today: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE occurred_at >= $2 AND occurred_at < $3)::int AS today
     FROM notes.notes WHERE user_id = $1`, [userId, start, end],
  );
  const recent = await database.query<{ id: string; title: string | null; occurredAt: Date }>(
    `SELECT id, title, occurred_at AS "occurredAt" FROM notes.notes WHERE user_id = $1
     ORDER BY occurred_at DESC, created_at DESC, id LIMIT 5`, [userId],
  );
  return { ...rows[0]!, recent: recent.rows.map((note) => ({ ...note, occurredAt: note.occurredAt.toISOString() })) };
}

function noteAgentSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object" as const, additionalProperties: false, properties, required };
}

async function registerAgent(ctx: AppAgentContext): Promise<void> {
  const idField = { type: "string", format: "uuid" };
  const baseHash = { type: "string", pattern: "^[0-9a-f]{64}$" };
  const properties = { ...noteProperties, tagIds: { type: "array", items: idField } };
  ctx.tool({
    name: "notes_list", description: "List your notes with short content snippets by default.", action: "read", scopes: ["read"],
    inputSchema: noteAgentSchema({
      q: { type: "string", maxLength: 300 }, tag: { type: "string", maxLength: 50 }, mood: { enum: [...MOODS] },
      pinned: { type: "boolean" }, includeContent: { type: "boolean", default: false },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
    }),
    async execute(invocation, args) { return { data: await listAgentNotes(invocation, args) }; },
  });
  ctx.tool({
    name: "notes_get", description: "Read an owned note, its Markdown, tags and current edit proof.", action: "read", scopes: ["read"],
    inputSchema: noteAgentSchema({ id: idField }, ["id"]),
    async execute({ database, userId, time }, args) {
      return { data: await requireNoteView(database, args.id as string, time.timezone(), userId) };
    },
  });
  ctx.tool({
    name: "notes_create", description: "Create an owned note and optionally link existing tags.", action: "write", scopes: ["read", "write"], create: true,
    inputSchema: noteAgentSchema({
      ...properties,
      title: { ...properties.title, default: null },
      mood: { ...properties.mood, default: null },
      occurredAt: { ...properties.occurredAt, default: null },
      pinned: { ...properties.pinned, default: false },
      tagIds: { ...properties.tagIds, default: [] },
    }, ["content"]),
    async execute(invocation, args) {
      const id = await createNote(invocation, args as unknown as NoteCreate);
      return { data: { id }, resourceId: id };
    },
  });
  ctx.tool({
    name: "notes_update", description: "Update fields or tags on an owned note using its current edit proof.", action: "write", scopes: ["read", "write"],
    inputSchema: noteAgentSchema({ ...properties, id: idField, baseHash }, ["id", "baseHash"]),
    async execute(invocation, args) {
      const noteId = args.id as string;
      await updateNote(invocation, noteId, args, readPresentedHash(args.baseHash), true);
      return { data: await requireNoteView(invocation.database, noteId, invocation.time.timezone(), invocation.userId), resourceId: noteId };
    },
  });
  ctx.tool({
    name: "notes_delete", description: "Move an owned note to Trash using its current edit proof.", action: "delete", scopes: ["read", "delete"],
    inputSchema: noteAgentSchema({ id: idField, baseHash }, ["id", "baseHash"]),
    async execute({ trash, time }, args) {
      if (!trash) throw new Error("Agent Trash authorization is missing");
      const noteId = args.id as string;
      await deleteNote(trash, noteId, readPresentedHash(args.baseHash), time);
      return { data: { id: noteId }, resourceId: noteId };
    },
  });
  ctx.tool({
    name: "notes_tags_list", description: "List the tags you can assign to notes.", action: "read", scopes: ["read"],
    inputSchema: noteAgentSchema({}),
    async execute({ database, userId }) {
      const { rows } = await database.query<TagRow>("SELECT id, name, created_at FROM notes.tags WHERE user_id = $1 ORDER BY name, id", [userId]);
      return { data: { items: rows.map(toTagView) } };
    },
  });
  ctx.resource({ uri: "pp://apps/notes/summary", name: "Notes summary", read: noteOverview });
  ctx.overview(noteOverview);
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

  ctx.api.post<{ Body: NoteCreate }>("/notes", {
    schema: { body: { type: "object", required: ["content"], additionalProperties: false, properties: noteProperties } },
  }, async (request, reply) => {
    const user = await ctx.auth.requireUser(request);
    const newId = await db.withTransaction((database) => createNote({ database, userId: user.id, time: ctx.time }, request.body));
    return reply.code(201).send(await requireNoteView(db, newId, timezone(), user.id));
  });

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
          properties: { ...noteProperties, baseHash: { type: "string" } },
        },
      },
    },
    async (request) => {
      const user = await ctx.auth.requireUser(request);
      const presented = readPresentedHash(request.body.baseHash);
      await db.withTransaction((database) => updateNote(
        { database, userId: user.id, time: ctx.time }, request.params.id, request.body, presented,
      ));
      return requireNoteView(db, request.params.id, timezone(), user.id);
    },
  );

  // Deleting a note cascades its note_tags rows (FK ON DELETE CASCADE).
  ctx.api.delete<{ Params: { id: string } }>("/notes/:id", async (request, reply) => {
    const presented = headerPresentedHash(request.headers["x-base-hash"]);
    await ctx.trash.withMutation(request, (mutation) => deleteNote(mutation, request.params.id, presented));
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

const app: BackendAppModule = { id, registerApi, registerAgent, healthcheck, restoreFromTrash };
export default app;
