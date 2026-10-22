import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import type { JobHandle } from "../../core/scheduler/index.js";
import { StorageError } from "../../core/storage/index.js";

/** Database surface derived from AppContext (never from core internals — notes precedent). */
type Db = AppContext["database"];

interface CategoryRow {
  id: string;
  name: string;
  color: string | null;
  created_at: Date;
}

/** Chip/accent colors a category may use; mirrors the frontend PixelAccent set. */
const CATEGORY_COLORS = ["primary", "success", "warning", "danger", "info", "mint", "yellow", "violet", "coral"] as const;

interface ItemRow {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  /** DATE column — the core pg parser hands it over as "YYYY-MM-DD". */
  acquired_at: string | null;
  target_location: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Columns shared by every attachment JSON response (storage_key stays internal). */
interface AttachmentViewRow {
  id: string;
  item_id: string;
  filename: string;
  content_type: string | null;
  size: number;
  created_at: Date;
}

interface AttachmentRow extends AttachmentViewRow {
  storage_key: string;
}

interface CleanupJobRow {
  id: string;
  kind: "delete_storage" | "drop_dangling_attachment";
  storage_key: string | null;
  attachment_id: string | null;
  user_id: string;
  reason: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Link rows for the batched category embed (notes tagsForNotes precedent). */
interface ItemCategoryLinkRow {
  item_id: string;
  id: string;
  name: string;
  color: string | null;
}

export interface ItemCategoryView {
  id: string;
  name: string;
  color: string | null;
}

export interface ItemView {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  acquiredAt: string | null;
  targetLocation: string | null;
  createdAt: string;
  updatedAt: string;
  /** Ordered by name (UNIQUE — naturally stable); empty = uncategorized. */
  categories: ItemCategoryView[];
}

export interface CategoryView {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

export interface AttachmentView {
  id: string;
  itemId: string;
  filename: string;
  contentType: string | null;
  size: number;
  createdAt: string;
}

export interface CleanupJobView {
  id: string;
  kind: CleanupJobRow["kind"];
  storageKey: string | null;
  attachmentId: string | null;
  reason: string;
  status: CleanupJobRow["status"];
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Hard upload cap, enforced server-side and mirrored in the frontend UI. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const MAX_CLEANUP_ATTEMPTS = 5;

const ITEM_COLUMNS = "id, name, description, quantity, acquired_at, target_location, created_at, updated_at";

/** Explicit sort allowlist: request values never reach SQL as identifiers. */
const ITEM_SORT_COLUMNS: Record<string, string> = {
  name: "name",
  quantity: "quantity",
  acquiredAt: "acquired_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
  targetLocation: "target_location",
};

/** Same uuid shape every platform id column uses. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

const id = "assets";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23503";
}

// ---------------------------------------------------------------------------
// camelCase view boundary (mini_game toSave / notes toNoteView precedent —
// the request body was already camelCase, now responses match it)
// ---------------------------------------------------------------------------

function toItemView(row: ItemRow, categories: ItemCategoryView[]): ItemView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    quantity: row.quantity,
    acquiredAt: row.acquired_at,
    targetLocation: row.target_location,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    categories,
  };
}

function toCategoryView(row: CategoryRow): CategoryView {
  return { id: row.id, name: row.name, color: row.color, createdAt: row.created_at.toISOString() };
}

function toAttachmentView(row: AttachmentViewRow): AttachmentView {
  return {
    id: row.id,
    itemId: row.item_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at.toISOString(),
  };
}

function toCleanupJobView(row: CleanupJobRow): CleanupJobView {
  return {
    id: row.id,
    kind: row.kind,
    storageKey: row.storage_key,
    attachmentId: row.attachment_id,
    reason: row.reason,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// item <-> category relation helpers (notes note_tags precedents)
// ---------------------------------------------------------------------------

/** Silent dedupe for request categoryIds: Set semantics, order kept. */
function dedupeCategoryIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Body categoryIds must be uuids so a malformed id fails validation at the
 * boundary (400) instead of surfacing as a pg 22P02 parse error on the FK
 * insert.
 */
function assertValidCategoryIds(categoryIds: string[]): void {
  const invalid = categoryIds.filter((categoryId) => !isUuid(categoryId));
  if (invalid.length > 0) {
    throw new AppError(400, "validation_error", `categoryIds must be uuids (got "${invalid[0]}")`, {
      categoryIds: invalid,
    });
  }
}

/**
 * Parse the `categories` query parameter: one comma-separated list of category
 * ids. Empty segments (trailing/double commas) are dropped, valid ids dedupe in
 * order, and any non-uuid segment is a 400 validation_error (notes
 * parseTagsQuery precedent). Well-formed but non-existent ids are NOT an
 * error — the filter just matches nothing.
 */
function parseCategoriesQuery(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids: string[] = [];
  for (const segment of raw.split(",")) {
    if (segment === "") continue;
    if (!isUuid(segment)) {
      throw new AppError(400, "validation_error", `invalid category id "${segment}" in categories query`, {
        categories: raw,
      });
    }
    ids.push(segment);
  }
  return dedupeCategoryIds(ids);
}

/**
 * Replace an item's category set wholesale (PATCH categoryIds semantics:
 * absent = keep, [] = clear, non-empty list = replace). Must run inside the
 * same transaction as any item-field update so an FK failure rolls the whole
 * update back (notes replaceNoteTags precedent). Only the user's OWN
 * categories can be attached — a foreign user's category id is
 * indistinguishable from a nonexistent one (422 category_not_found).
 */
async function replaceItemCategories(
  tx: Db,
  userId: string,
  itemId: string,
  categoryIds: string[],
): Promise<void> {
  await tx.query("DELETE FROM assets.item_categories WHERE item_id = $1", [itemId]);
  if (categoryIds.length > 0) {
    const inserted = await tx.query(
      `INSERT INTO assets.item_categories (item_id, category_id)
       SELECT $1, id FROM assets.categories WHERE id = ANY($2::uuid[]) AND user_id = $3`,
      [itemId, categoryIds, userId],
    );
    if ((inserted.rowCount ?? 0) !== categoryIds.length) {
      throw new AppError(422, "category_not_found", "categoryIds reference categories that do not exist", {
        categoryIds,
      });
    }
  }
}

/** 422 mapping for categoryIds referencing missing categories (notes tag_not_found precedent). */
function categoryNotFoundError(categoryIds: string[]): AppError {
  return new AppError(422, "category_not_found", "categoryIds reference categories that do not exist", {
    categoryIds,
  });
}

/** Categories for a batch of items, ordered by name; empty ids → empty map. */
async function categoriesForItems(db: Db, itemIds: string[]): Promise<Map<string, ItemCategoryView[]>> {
  const map = new Map<string, ItemCategoryView[]>();
  if (itemIds.length === 0) return map;
  const { rows } = await db.query<ItemCategoryLinkRow>(
    `SELECT ic.item_id, c.id, c.name, c.color
     FROM assets.item_categories ic
     JOIN assets.categories c ON c.id = ic.category_id
     WHERE ic.item_id = ANY($1)
     ORDER BY c.name`,
    [itemIds],
  );
  for (const row of rows) {
    const list = map.get(row.item_id) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    map.set(row.item_id, list);
  }
  return map;
}

async function findItemView(db: Db, userId: string, itemId: string): Promise<ItemView | null> {
  const { rows } = await db.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM assets.items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  );
  if (!rows[0]) return null;
  const categories = await categoriesForItems(db, [itemId]);
  return toItemView(rows[0], categories.get(itemId) ?? []);
}

async function requireItemView(db: Db, userId: string, itemId: string): Promise<ItemView> {
  const view = await findItemView(db, userId, itemId);
  if (!view) throw new AppError(404, "not_found", "item not found");
  return view;
}

// ---------------------------------------------------------------------------
// list filters + faceted counts
// ---------------------------------------------------------------------------

/** Non-category facets shared by the items list and the counts aggregates. */
interface ItemQueryFilters {
  q?: string;
  targetLocation?: string;
  acquiredAfter?: string;
  acquiredBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
}

/**
 * The ONE conditions builder behind the items list AND the faceted counts
 * (worklist §10): counts call it with an empty categoryIds so only the
 * categories facet drops out — the two WHERE clauses can never drift apart.
 * Every caller queries `FROM assets.items i`, so conditions may use the `i`
 * alias; ids and search terms only ever reach parameter slots. Ownership is
 * the leading, always-present predicate (AUTH-3).
 */
function itemConditions(
  filters: ItemQueryFilters,
  categoryIds: string[],
  userId: string,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [userId];
  conditions.push(`i.user_id = $1`);
  if (filters.q) {
    params.push(`%${filters.q}%`);
    // Search matches item name, description, or ANY assigned category name
    // via the relation table (own schema only; same-owner categories only).
    conditions.push(
      `(i.name ILIKE $${params.length} OR i.description ILIKE $${params.length} OR EXISTS (
         SELECT 1 FROM assets.item_categories ic
         JOIN assets.categories c ON c.id = ic.category_id AND c.user_id = i.user_id
         WHERE ic.item_id = i.id AND c.name ILIKE $${params.length}
       ))`,
    );
  }
  // Multi-category AND: one EXISTS per requested id (notes multi-tag style —
  // no GROUP BY/HAVING needed). A foreign user's category id matches nothing.
  for (const categoryId of categoryIds) {
    params.push(categoryId);
    conditions.push(
      `EXISTS (SELECT 1 FROM assets.item_categories ic WHERE ic.item_id = i.id AND ic.category_id = $${params.length})`,
    );
  }
  if (filters.targetLocation) {
    params.push(`%${filters.targetLocation}%`);
    conditions.push(`i.target_location ILIKE $${params.length}`);
  }
  if (filters.acquiredAfter) {
    params.push(filters.acquiredAfter);
    conditions.push(`i.acquired_at >= $${params.length}`);
  }
  if (filters.acquiredBefore) {
    params.push(filters.acquiredBefore);
    conditions.push(`i.acquired_at <= $${params.length}`);
  }
  if (filters.createdAfter) {
    params.push(filters.createdAfter);
    conditions.push(`i.created_at >= $${params.length}`);
  }
  if (filters.createdBefore) {
    params.push(filters.createdBefore);
    conditions.push(`i.created_at < $${params.length}`);
  }
  return { conditions, params };
}

function whereClause(conditions: string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

/**
 * Storage/DB consistency compensation (FP-12.1): a failed cross-store step
 * enqueues a retryable, idempotent cleanup job. Neither store can be "first"
 * safely — the queue absorbs the mismatch until both sides agree again.
 * Since AUTH-4 every job carries its owning user: the storage scope of a
 * storage_key resolves through user_id, never an implicit "current user".
 */
async function enqueueCleanup(
  ctx: AppContext,
  userId: string,
  job: Pick<CleanupJobRow, "kind" | "storage_key" | "attachment_id" | "reason">,
): Promise<void> {
  await ctx.database.query(
    `INSERT INTO assets.cleanup_jobs (id, user_id, kind, storage_key, attachment_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, job.kind, job.storage_key, job.attachment_id, job.reason],
  );
}

/**
 * Work the queue once. Every action is idempotent: deleting an absent file or
 * metadata row counts as success. Jobs that keep failing are marked `failed`
 * after MAX_CLEANUP_ATTEMPTS and stay queryable for operators.
 */
async function processCleanupQueue(ctx: AppContext): Promise<{ processed: number; failed: number }> {
  const { rows } = await ctx.database.query<CleanupJobRow>(
    `SELECT id, kind, storage_key, attachment_id, user_id, reason, status, attempts, last_error, created_at, updated_at
     FROM assets.cleanup_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
  );
  let failed = 0;
  for (const job of rows) {
    try {
      if (job.kind === "delete_storage") {
        if (job.storage_key === null) throw new Error("delete_storage job without storage_key");
        await ctx.storage.forUser(job.user_id).delete(job.storage_key);
      } else {
        if (job.attachment_id === null) throw new Error("drop_dangling_attachment job without attachment_id");
        await ctx.database.query(
          "DELETE FROM assets.attachments WHERE id = $1 AND user_id = $2",
          [job.attachment_id, job.user_id],
        );
      }
      await ctx.database.query(
        "UPDATE assets.cleanup_jobs SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE id = $1",
        [job.id],
      );
    } catch (error) {
      const attempts = job.attempts + 1;
      const exhausted = attempts >= MAX_CLEANUP_ATTEMPTS;
      await ctx.database.query(
        `UPDATE assets.cleanup_jobs
         SET attempts = $2, last_error = $3, status = $4, updated_at = now()
         WHERE id = $1`,
        [job.id, attempts, (error as Error).message, exhausted ? "failed" : "pending"],
      );
      if (exhausted) {
        failed += 1;
        ctx.log.error({ jobId: job.id, kind: job.kind, error }, "cleanup job permanently failed");
      }
    }
  }
  return { processed: rows.length, failed };
}

/**
 * Full reconciliation: work the queue, then drop metadata only after an
 * owner's storage read explicitly confirms not_found. exists=false alone
 * also covers I/O/path faults, so an inconclusive probe retains metadata.
 * Healthy attachments keep the cheap exists=true path without reading bytes.
 */
async function reconcileStorage(ctx: AppContext): Promise<{
  queue: { processed: number; failed: number };
  danglingDropped: number;
  probeFailed: number;
}> {
  const queue = await processCleanupQueue(ctx);
  const { rows } = await ctx.database.query<{ id: string; storage_key: string; user_id: string }>(
    "SELECT id, storage_key, user_id FROM assets.attachments",
  );
  let danglingDropped = 0;
  let probeFailed = 0;
  for (const attachment of rows) {
    let confirmedMissing = false;
    try {
      const storage = ctx.storage.forUser(attachment.user_id);
      if (await storage.exists(attachment.storage_key)) continue;
      try {
        await storage.read(attachment.storage_key);
      } catch (error) {
        // Only read's typed not_found is evidence of absence. An exception
        // from forUser/exists, even not_found, remains a failed probe.
        if (error instanceof StorageError && error.code === "not_found") confirmedMissing = true;
        else throw error;
      }
    } catch (error) {
      probeFailed += 1;
      ctx.log.warn({
        attachmentId: attachment.id,
        userId: attachment.user_id,
        code: error instanceof StorageError ? error.code : "unknown",
        error,
      }, "attachment storage probe failed; metadata retained");
      continue;
    }
    if (!confirmedMissing) continue;
    const deleted = await ctx.database.query(
      "DELETE FROM assets.attachments WHERE id = $1 AND user_id = $2 AND storage_key = $3",
      [attachment.id, attachment.user_id, attachment.storage_key],
    );
    const dropped = deleted.rowCount ?? 0;
    danglingDropped += dropped;
    if (dropped > 0) {
      ctx.log.warn({ attachmentId: attachment.id, userId: attachment.user_id }, "dropped attachment metadata with missing file");
    }
  }
  return { queue, danglingDropped, probeFailed };
}

/** Enqueue and immediately try to drain: most compensations succeed inline. */
async function compensate(
  ctx: AppContext,
  userId: string,
  job: Parameters<typeof enqueueCleanup>[2],
): Promise<void> {
  await enqueueCleanup(ctx, userId, job);
  await processCleanupQueue(ctx).catch((error: unknown) => {
    ctx.log.warn({ error, kind: job.kind }, "inline cleanup deferred to scheduler");
  });
}

/** Download-only header: UTF-8 names stay usable without injecting HTTP syntax. */
function attachmentDisposition(filename: string): string {
  // UTF-8 round-trip replaces a lone surrogate left by legacy name truncation.
  const name = Buffer.from(filename, "utf8").toString("utf8").replace(/[\x00-\x1f\x7f"\\/]/g, "_") || "attachment";
  const fallback = name.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Convert the multipart plugin's size abort into a stable API error. */
function attachmentTooLarge(cause: unknown): never {
  if ((cause as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
    throw new AppError(413, "attachment_too_large", `attachment exceeds the ${ATTACHMENT_MAX_BYTES} byte limit`);
  }
  throw cause;
}

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.get("/categories", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const { rows } = await db.query<CategoryRow>(
      "SELECT id, name, color, created_at FROM assets.categories WHERE user_id = $1 ORDER BY name",
      [user.id],
    );
    return { items: rows.map(toCategoryView) };
  });

  ctx.api.post<{ Body: { name: string; color?: string } }>(
    "/categories",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            color: { enum: [...CATEGORY_COLORS] },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await ctx.auth.requireUser(request);
      try {
        const { rows } = await db.query<CategoryRow>(
          "INSERT INTO assets.categories (id, user_id, name, color) VALUES ($1, $2, $3, $4) RETURNING id, name, color, created_at",
          [randomUUID(), user.id, request.body.name, request.body.color ?? null],
        );
        if (!rows[0]) throw new AppError(500, "internal_error", "category row vanished after insert");
        return reply.code(201).send(toCategoryView(rows[0]));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(422, "category_name_taken", `a category named "${request.body.name}" already exists`);
        }
        throw error;
      }
    },
  );

  // Partial update: absent fields stay unchanged, explicit null clears color.
  ctx.api.patch<{ Params: { id: string }; Body: { name?: string; color?: string | null } }>(
    "/categories/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            color: { enum: [...CATEGORY_COLORS, null] },
          },
        },
      },
    },
    async (request) => {
      const user = await ctx.auth.requireUser(request);
      const body = request.body;
      const sets: string[] = [];
      const params: unknown[] = [request.params.id, user.id];
      if (body.name !== undefined) {
        params.push(body.name);
        sets.push(`name = $${params.length}`);
      }
      if (body.color !== undefined) {
        params.push(body.color);
        sets.push(`color = $${params.length}`);
      }
      if (sets.length === 0) {
        const current = await db.query<CategoryRow>(
          "SELECT id, name, color, created_at FROM assets.categories WHERE id = $1 AND user_id = $2",
          [request.params.id, user.id],
        );
        if (!current.rows[0]) throw new AppError(404, "not_found", "category not found");
        return toCategoryView(current.rows[0]);
      }
      try {
        const { rows } = await db.query<CategoryRow>(
          `UPDATE assets.categories SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id, name, color, created_at`,
          params,
        );
        if (!rows[0]) throw new AppError(404, "not_found", "category not found");
        return toCategoryView(rows[0]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(422, "category_name_taken", `a category named "${body.name}" already exists`);
        }
        throw error;
      }
    },
  );

  // Deleting a category keeps its items: the item_categories links cascade
  // away (ON DELETE CASCADE), so each item only loses this one category —
  // items with no other category become uncategorized.
  ctx.api.delete<{ Params: { id: string } }>("/categories/:id", async (request, reply) => {
    const user = await ctx.auth.requireUser(request);
    const result = await db.query("DELETE FROM assets.categories WHERE id = $1 AND user_id = $2", [
      request.params.id,
      user.id,
    ]);
    if (result.rowCount === 0) throw new AppError(404, "not_found", "category not found");
    return reply.code(204).send();
  });

  ctx.api.get<{ Querystring: Record<string, string> }>(
    "/items",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", maxLength: 300 },
            // Comma-separated category ids, multi-select AND semantics.
            categories: { type: "string" },
            targetLocation: { type: "string", maxLength: 300 },
            acquiredAfter: { type: "string", format: "date" },
            acquiredBefore: { type: "string", format: "date" },
            createdAfter: { type: "string", format: "date-time" },
            createdBefore: { type: "string", format: "date-time" },
            sortBy: { type: "string", enum: Object.keys(ITEM_SORT_COLUMNS) },
            order: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
    },
    async (request) => {
      const user = await ctx.auth.requireUser(request);
      const query = request.query;
      const categoryFilter = parseCategoriesQuery(query.categories);
      const { conditions, params } = itemConditions(query, categoryFilter, user.id);

      const sortColumn = ITEM_SORT_COLUMNS[query.sortBy ?? "createdAt"] ?? "created_at";
      const direction = query.order === "asc" ? "ASC" : "DESC";
      const orderBy = `${sortColumn} ${direction} NULLS LAST, created_at DESC, id`;

      const { rows } = await db.query<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM assets.items i ${whereClause(conditions)} ORDER BY ${orderBy}`,
        params,
      );
      const categories = await categoriesForItems(db, rows.map((row) => row.id));

      // Faceted counts (worklist §2.4): computed under all CURRENT filters
      // except the categories facet itself — `all` counts items regardless of
      // category, `categories[cid]` counts items in that category under the
      // remaining filters. Selecting category A therefore never zeroes out
      // category B's count, and an item in several categories counts once per
      // category (the relation PK keeps each count duplicate-free). Same
      // builder as the items query, minus the categories conditions, so the
      // two can never drift apart.
      const facet = itemConditions(query, [], user.id);
      const facetWhere = whereClause(facet.conditions);
      const all = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM assets.items i ${facetWhere}`,
        facet.params,
      );
      const byCategory = await db.query<{ category_id: string; count: number }>(
        `SELECT ic.category_id, count(*)::int AS count
         FROM assets.items i
         JOIN assets.item_categories ic ON ic.item_id = i.id
         ${facetWhere}
         GROUP BY ic.category_id`,
        facet.params,
      );
      // Every existing category of THIS user is present, including zero-item ones.
      const existing = await db.query<{ id: string }>(
        "SELECT id FROM assets.categories WHERE user_id = $1",
        [user.id],
      );
      const categoryCounts: Record<string, number> = {};
      for (const category of existing.rows) categoryCounts[category.id] = 0;
      for (const row of byCategory.rows) categoryCounts[row.category_id] = row.count;

      return {
        items: rows.map((row) => toItemView(row, categories.get(row.id) ?? [])),
        counts: { all: all.rows[0]?.count ?? 0, categories: categoryCounts },
      };
    },
  );

  ctx.api.post<{ Body: { name: string; description?: string; quantity?: number; acquiredAt?: string; categoryIds?: string[]; targetLocation?: string } }>(
    "/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 300 },
            description: { type: ["string", "null"], maxLength: 5000 },
            quantity: { type: "integer", minimum: 0 },
            acquiredAt: { type: ["string", "null"], format: "date" },
            // Arrays only: `categoryIds: null` fails this schema → 400 (use []
            // to clear on PATCH; create simply defaults to no categories).
            categoryIds: { type: "array", items: { type: "string" } },
            targetLocation: { type: ["string", "null"], maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await ctx.auth.requireUser(request);
      const b = request.body;
      const categoryIds = dedupeCategoryIds(b.categoryIds ?? []);
      assertValidCategoryIds(categoryIds);
      const newId = randomUUID();
      try {
        await ctx.database.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO assets.items (id, user_id, name, description, quantity, acquired_at, target_location)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newId, user.id, b.name, b.description ?? null, b.quantity ?? 1, b.acquiredAt ?? null, b.targetLocation ?? null],
          );
          await replaceItemCategories(tx, user.id, newId, categoryIds);
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) throw categoryNotFoundError(categoryIds);
        throw error;
      }
      // The create transaction has committed — publish only now so the event
      // reflects persisted state (focus/notes "events after commit" precedent).
      ctx.events.publish(
        "assets.item.created.v2",
        { userId: user.id, id: newId, name: b.name, categoryIds },
        "assets",
      );
      return reply.code(201).send(await requireItemView(db, user.id, newId));
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/items/:id", async (request) => {
    const user = await ctx.auth.requireUser(request);
    return requireItemView(db, user.id, request.params.id);
  });

  // Partial update with real nullable semantics (FP-2B.1): a missing property
  // leaves the column unchanged, an explicit null clears it, a value updates
  // it. `categoryIds` is array-tri-state: absent = keep the current set,
  // [] = clear all, non-empty list = replace wholesale (null → 400 above).
  ctx.api.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/items/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 300 },
            description: { type: ["string", "null"], maxLength: 5000 },
            quantity: { type: "integer", minimum: 0 },
            acquiredAt: { type: ["string", "null"], format: "date" },
            categoryIds: { type: "array", items: { type: "string" } },
            targetLocation: { type: ["string", "null"], maxLength: 300 },
          },
        },
      },
    },
    async (request) => {
      const user = await ctx.auth.requireUser(request);
      const body = request.body as Record<string, unknown>;
      const columns: Array<[string, string]> = [
        ["name", "name"],
        ["description", "description"],
        ["quantity", "quantity"],
        ["acquiredAt", "acquired_at"],
        ["targetLocation", "target_location"],
      ];
      const sets: string[] = [];
      const params: unknown[] = [request.params.id, user.id];
      for (const [key, column] of columns) {
        if (!(key in body)) continue;
        params.push(body[key]);
        sets.push(`${column} = $${params.length}`);
      }
      const replaceCategories = "categoryIds" in body;
      const categoryIds = replaceCategories ? dedupeCategoryIds(body.categoryIds as string[]) : [];
      if (replaceCategories) assertValidCategoryIds(categoryIds);

      if (sets.length === 0 && !replaceCategories) {
        return requireItemView(db, user.id, request.params.id);
      }

      try {
        await ctx.database.withTransaction(async (tx) => {
          if (sets.length > 0) {
            sets.push("updated_at = now()");
            const updated = await tx.query(
              `UPDATE assets.items SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id`,
              params,
            );
            if (!updated.rows[0]) throw new AppError(404, "not_found", "item not found");
          } else {
            const exists = await tx.query("SELECT id FROM assets.items WHERE id = $1 AND user_id = $2", [
              request.params.id,
              user.id,
            ]);
            if (!exists.rows[0]) throw new AppError(404, "not_found", "item not found");
          }
          if (replaceCategories) await replaceItemCategories(tx, user.id, request.params.id, categoryIds);
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) throw categoryNotFoundError(categoryIds);
        throw error;
      }
      return requireItemView(db, user.id, request.params.id);
    },
  );

  ctx.api.delete<{ Params: { id: string } }>("/items/:id", async (request, reply) => {
    const user = await ctx.auth.requireUser(request);
    // Collect attachment metadata first, remove the physical objects, then
    // drop the row. Storage failures abort with metadata intact. If the DB
    // delete fails after files are gone, the dangling metadata rows are
    // enqueued for compensation (FP-12.1). All file operations run inside
    // the OWNER's storage root (AUTH-4).
    const attachments = await db.query<AttachmentRow>(
      "SELECT id, item_id, filename, content_type, size, storage_key, created_at FROM assets.attachments WHERE item_id = $1 AND user_id = $2",
      [request.params.id, user.id],
    );
    const deletedFiles: AttachmentRow[] = [];
    for (const row of attachments.rows) {
      try {
        await ctx.storage.forUser(user.id).delete(row.storage_key);
        deletedFiles.push(row);
      } catch (error) {
        // Files already removed above must not keep dangling metadata, but
        // the row stays (the item delete aborted), so enqueue the drop.
        for (const done of deletedFiles) {
          await compensate(ctx, user.id, {
            kind: "drop_dangling_attachment",
            storage_key: null,
            attachment_id: done.id,
            reason: "item delete aborted mid-file-removal",
          });
        }
        throw error;
      }
    }
    try {
      const result = await db.query("DELETE FROM assets.items WHERE id = $1 AND user_id = $2", [
        request.params.id,
        user.id,
      ]);
      if (result.rowCount === 0) throw new AppError(404, "not_found", "item not found");
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Files are gone but the row remains: queue metadata drops.
      for (const done of deletedFiles) {
        await compensate(ctx, user.id, {
          kind: "drop_dangling_attachment",
          storage_key: null,
          attachment_id: done.id,
          reason: "item row delete failed after storage removal",
        });
      }
      throw error;
    }
    return reply.code(204).send();
  });

  // Multipart upload (FP-12.2): one `file` part, server-enforced size cap.
  await ctx.api.register(multipart, {
    attachFieldsToBody: false,
    limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1, fields: 0 },
  });
  ctx.api.post<{ Params: { id: string } }>(
    "/items/:id/attachments",
    async (request, reply) => {
      const user = await ctx.auth.requireUser(request);
      const item = await db.query<ItemRow>(
        "SELECT id FROM assets.items WHERE id = $1 AND user_id = $2",
        [request.params.id, user.id],
      );
      if (!item.rows[0]) throw new AppError(404, "not_found", "item not found");

      // The plugin may abort an oversized part while opening or draining it.
      const file = await request.file().catch(attachmentTooLarge);
      if (!file) {
        throw new AppError(400, "validation_error", "expected a multipart/form-data upload with a 'file' part");
      }
      if (file.fieldname !== "file") {
        throw new AppError(400, "validation_error", `unexpected part '${file.fieldname}'; use field name 'file'`);
      }
      const data = await file.toBuffer().catch(attachmentTooLarge);
      if (file.file.truncated || data.length > ATTACHMENT_MAX_BYTES) {
        throw new AppError(
          413,
          "attachment_too_large",
          `attachment exceeds the ${ATTACHMENT_MAX_BYTES} byte limit`,
        );
      }
      const filename = (file.filename ?? "attachment").slice(0, 300);
      if (filename.length === 0) {
        throw new AppError(400, "validation_error", "file part must carry a filename");
      }

      const attachmentId = randomUUID();
      const storageKey = `attachments/${request.params.id}/${attachmentId}`;
      // User-owned data lands inside the OWNER's storage root (AUTH-4);
      // guessing ids or keys cannot cross into another user's tree.
      await ctx.storage.forUser(user.id).save(storageKey, data);
      try {
        const { rows } = await db.query<AttachmentViewRow>(
          `INSERT INTO assets.attachments (id, user_id, item_id, filename, content_type, size, storage_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, item_id, filename, content_type, size, created_at`,
          [attachmentId, user.id, request.params.id, filename, file.mimetype || null, data.length, storageKey],
        );
        if (!rows[0]) throw new Error("attachment metadata row vanished after insert");
        return reply.code(201).send(toAttachmentView(rows[0]));
      } catch (error) {
        // DB failed after the file landed: compensate so no orphan remains
        // (enqueued + inline best-effort, hourly scheduler as backstop).
        await compensate(ctx, user.id, {
          kind: "delete_storage",
          storage_key: storageKey,
          attachment_id: null,
          reason: "attachment metadata insert failed after storage save",
        });
        throw error;
      }
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/items/:id/attachments", async (request) => {
    const user = await ctx.auth.requireUser(request);
    // Foreign items answer 404 like GET /items/:id (no existence leak).
    const item = await db.query<{ id: string }>("SELECT id FROM assets.items WHERE id = $1 AND user_id = $2", [
      request.params.id,
      user.id,
    ]);
    if (!item.rows[0]) throw new AppError(404, "not_found", "item not found");
    const { rows } = await db.query<AttachmentViewRow>(
      "SELECT id, item_id, filename, content_type, size, created_at FROM assets.attachments WHERE item_id = $1 AND user_id = $2 ORDER BY created_at",
      [request.params.id, user.id],
    );
    return { items: rows.map(toAttachmentView) };
  });

  ctx.api.get<{ Params: { id: string; attachmentId: string } }>(
    "/items/:id/attachments/:attachmentId",
    async (request, reply) => {
      const user = await ctx.auth.requireUser(request);
      const { rows } = await db.query<{ storage_key: string; filename: string; content_type: string | null }>(
        "SELECT storage_key, filename, content_type FROM assets.attachments WHERE id = $1 AND item_id = $2 AND user_id = $3",
        [request.params.attachmentId, request.params.id, user.id],
      );
      if (!rows[0]) throw new AppError(404, "not_found", "attachment not found");
      const data = await ctx.storage.forUser(user.id).read(rows[0].storage_key);
      return reply
        .type("application/octet-stream")
        .header("content-disposition", attachmentDisposition(rows[0].filename))
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        .send(data);
    },
  );

  // Delete one attachment: storage object first, metadata second. If the DB
  // delete fails after the file is gone, the dangling row is queued for
  // compensation instead of silently pointing at nothing (FP-12.1).
  ctx.api.delete<{ Params: { id: string; attachmentId: string } }>(
    "/items/:id/attachments/:attachmentId",
    async (request, reply) => {
      const user = await ctx.auth.requireUser(request);
      const { rows } = await db.query<{ id: string; storage_key: string }>(
        "SELECT id, storage_key FROM assets.attachments WHERE id = $1 AND item_id = $2 AND user_id = $3",
        [request.params.attachmentId, request.params.id, user.id],
      );
      if (!rows[0]) throw new AppError(404, "not_found", "attachment not found");
      await ctx.storage.forUser(user.id).delete(rows[0].storage_key);
      try {
        await db.query("DELETE FROM assets.attachments WHERE id = $1 AND user_id = $2", [
          request.params.attachmentId,
          user.id,
        ]);
      } catch (error) {
        await compensate(ctx, user.id, {
          kind: "drop_dangling_attachment",
          storage_key: null,
          attachment_id: rows[0].id,
          reason: "attachment row delete failed after storage removal",
        });
        throw error;
      }
      return reply.code(204).send();
    },
  );

  ctx.api.get("/summary", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const items = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM assets.items WHERE user_id = $1",
      [user.id],
    );
    const categories = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM assets.categories WHERE user_id = $1",
      [user.id],
    );
    return {
      items: Number(items.rows[0]?.count ?? 0),
      categories: Number(categories.rows[0]?.count ?? 0),
    };
  });

  // Operator surface for the consistency machinery: run reconciliation on
  // demand and observe the queue (also used by integration tests).
  // Admin-only: it sweeps every user's queue state.
  ctx.api.post("/maintenance/reconcile", async (request) => {
    await ctx.auth.requireRole(request, "admin");
    return reconcileStorage(ctx);
  });
  ctx.api.get("/maintenance/cleanup-jobs", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const { rows } = await db.query<CleanupJobRow>(
      `SELECT id, kind, storage_key, attachment_id, user_id, reason, status, attempts, last_error, created_at, updated_at
       FROM assets.cleanup_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [user.id],
    );
    return { items: rows.map(toCleanupJobView) };
  });
}

async function registerJobs(ctx: AppContext): Promise<JobHandle[]> {
  // Platform-level sweep with explicit per-row ownership (AUTH-GATE-06):
  // every queue entry and attachment carries its user_id, and every file
  // operation resolves the scope through forUser(user_id).
  const reconcile = async () => {
    const result = await reconcileStorage(ctx);
    if (result.queue.processed > 0 || result.danglingDropped > 0 || result.probeFailed > 0) {
      ctx.log.info(result, "storage reconciliation ran");
    }
  };
  return [
    ctx.scheduler.register({ id: "assets.storage_reconcile", schedule: { cron: "0 * * * *", timezone: ctx.time.timezone() }, run: reconcile }),
    // One sweep shortly after boot catches anything left by a crash.
    ctx.scheduler.register({ id: "assets.storage_reconcile_boot", schedule: { onceAfterMs: 1_000 }, run: reconcile }),
  ];
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM assets.items LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, registerJobs, healthcheck };
export default app;
