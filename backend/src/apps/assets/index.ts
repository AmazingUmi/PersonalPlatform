import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import type { JobHandle } from "../../core/scheduler/index.js";

interface CategoryRow {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
}

/** Chip/accent colors a category may use; mirrors the frontend PixelAccent set. */
const CATEGORY_COLORS = ["primary", "success", "warning", "danger", "info", "mint", "yellow", "violet", "coral"] as const;

interface ItemRow {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  quantity: number;
  acquired_at: string | null;
  target_location: string | null;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  item_id: string;
  filename: string;
  content_type: string | null;
  size: number;
  storage_key: string;
  created_at: string;
}

interface CleanupJobRow {
  id: string;
  kind: "delete_storage" | "drop_dangling_attachment";
  storage_key: string | null;
  attachment_id: string | null;
  reason: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  last_error: string | null;
}

/** Hard upload cap, enforced server-side and mirrored in the frontend UI. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const MAX_CLEANUP_ATTEMPTS = 5;

const ITEM_COLUMNS = "id, category_id, name, description, quantity, acquired_at, target_location, created_at, updated_at";

/** Explicit sort allowlist: request values never reach SQL as identifiers. */
const ITEM_SORT_COLUMNS: Record<string, string> = {
  name: "name",
  quantity: "quantity",
  acquiredAt: "acquired_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
  targetLocation: "target_location",
};

const id = "assets";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/**
 * Storage/DB consistency compensation (FP-12.1): a failed cross-store step
 * enqueues a retryable, idempotent cleanup job. Neither store can be "first"
 * safely — the queue absorbs the mismatch until both sides agree again.
 */
async function enqueueCleanup(
  ctx: AppContext,
  job: Pick<CleanupJobRow, "kind" | "storage_key" | "attachment_id" | "reason">,
): Promise<void> {
  await ctx.database.query(
    `INSERT INTO assets.cleanup_jobs (id, kind, storage_key, attachment_id, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), job.kind, job.storage_key, job.attachment_id, job.reason],
  );
}

/**
 * Work the queue once. Every action is idempotent: deleting an absent file or
 * metadata row counts as success. Jobs that keep failing are marked `failed`
 * after MAX_CLEANUP_ATTEMPTS and stay queryable for operators.
 */
async function processCleanupQueue(ctx: AppContext): Promise<{ processed: number; failed: number }> {
  const { rows } = await ctx.database.query<CleanupJobRow>(
    `SELECT id, kind, storage_key, attachment_id, reason, status, attempts, last_error
     FROM assets.cleanup_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
  );
  let failed = 0;
  for (const job of rows) {
    try {
      if (job.kind === "delete_storage") {
        if (job.storage_key === null) throw new Error("delete_storage job without storage_key");
        await ctx.storage.delete(job.storage_key);
      } else {
        if (job.attachment_id === null) throw new Error("drop_dangling_attachment job without attachment_id");
        await ctx.database.query("DELETE FROM assets.attachments WHERE id = $1", [job.attachment_id]);
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
 * Full reconciliation: work the queue, then drop metadata whose backing file
 * vanished (manual deletion, disk loss, crash between steps).
 */
async function reconcileStorage(ctx: AppContext): Promise<{
  queue: { processed: number; failed: number };
  danglingDropped: number;
}> {
  const queue = await processCleanupQueue(ctx);
  const { rows } = await ctx.database.query<{ id: string; storage_key: string }>(
    "SELECT id, storage_key FROM assets.attachments",
  );
  let danglingDropped = 0;
  for (const attachment of rows) {
    if (await ctx.storage.exists(attachment.storage_key)) continue;
    await ctx.database.query("DELETE FROM assets.attachments WHERE id = $1", [attachment.id]);
    danglingDropped += 1;
    ctx.log.warn({ attachmentId: attachment.id }, "dropped attachment metadata with missing file");
  }
  return { queue, danglingDropped };
}

/** Enqueue and immediately try to drain: most compensations succeed inline. */
async function compensate(
  ctx: AppContext,
  job: Parameters<typeof enqueueCleanup>[1],
): Promise<void> {
  await enqueueCleanup(ctx, job);
  await processCleanupQueue(ctx).catch((error: unknown) => {
    ctx.log.warn({ error, kind: job.kind }, "inline cleanup deferred to scheduler");
  });
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

  ctx.api.get("/categories", async () => {
    const { rows } = await db.query<CategoryRow>(
      "SELECT id, name, color, created_at FROM assets.categories ORDER BY name",
    );
    return { items: rows };
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
      try {
        const { rows } = await db.query<CategoryRow>(
          "INSERT INTO assets.categories (id, name, color) VALUES ($1, $2, $3) RETURNING id, name, color, created_at",
          [randomUUID(), request.body.name, request.body.color ?? null],
        );
        return reply.code(201).send(rows[0]);
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
      const body = request.body;
      const sets: string[] = [];
      const params: unknown[] = [request.params.id];
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
          "SELECT id, name, color, created_at FROM assets.categories WHERE id = $1",
          [request.params.id],
        );
        if (!current.rows[0]) throw new AppError(404, "not_found", "category not found");
        return current.rows[0];
      }
      try {
        const { rows } = await db.query<CategoryRow>(
          `UPDATE assets.categories SET ${sets.join(", ")} WHERE id = $1 RETURNING id, name, color, created_at`,
          params,
        );
        if (!rows[0]) throw new AppError(404, "not_found", "category not found");
        return rows[0];
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(422, "category_name_taken", `a category named "${body.name}" already exists`);
        }
        throw error;
      }
    },
  );

  // Deleting a category keeps its items (ON DELETE SET NULL on items.category_id).
  ctx.api.delete<{ Params: { id: string } }>("/categories/:id", async (request, reply) => {
    const result = await db.query("DELETE FROM assets.categories WHERE id = $1", [request.params.id]);
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
            categoryId: { type: "string" },
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
      const query = request.query;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (query.q) {
        params.push(`%${query.q}%`);
        // Search matches item name, description, or the assigned category's
        // name (own schema only).
        conditions.push(
          `(name ILIKE $${params.length} OR description ILIKE $${params.length} OR EXISTS (
             SELECT 1 FROM assets.categories c
             WHERE c.id = items.category_id AND c.name ILIKE $${params.length}
           ))`,
        );
      }
      if (query.categoryId) {
        params.push(query.categoryId);
        conditions.push(`category_id = $${params.length}`);
      }
      if (query.targetLocation) {
        params.push(`%${query.targetLocation}%`);
        conditions.push(`target_location ILIKE $${params.length}`);
      }
      if (query.acquiredAfter) {
        params.push(query.acquiredAfter);
        conditions.push(`acquired_at >= $${params.length}`);
      }
      if (query.acquiredBefore) {
        params.push(query.acquiredBefore);
        conditions.push(`acquired_at <= $${params.length}`);
      }
      if (query.createdAfter) {
        params.push(query.createdAfter);
        conditions.push(`created_at >= $${params.length}`);
      }
      if (query.createdBefore) {
        params.push(query.createdBefore);
        conditions.push(`created_at < $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      const sortColumn = ITEM_SORT_COLUMNS[query.sortBy ?? "createdAt"] ?? "created_at";
      const direction = query.order === "asc" ? "ASC" : "DESC";
      const orderBy = `${sortColumn} ${direction} NULLS LAST, created_at DESC, id`;

      const { rows } = await db.query<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM assets.items ${where} ORDER BY ${orderBy}`,
        params,
      );
      return { items: rows };
    },
  );

  ctx.api.post<{ Body: { name: string; description?: string; quantity?: number; acquiredAt?: string; categoryId?: string; targetLocation?: string } }>(
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
            categoryId: { type: ["string", "null"] },
            targetLocation: { type: ["string", "null"], maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const newId = randomUUID();
      let rows: { rows: ItemRow[] };
      try {
        rows = await db.query<ItemRow>(
          `INSERT INTO assets.items (id, category_id, name, description, quantity, acquired_at, target_location)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${ITEM_COLUMNS}`,
          [newId, b.categoryId ?? null, b.name, b.description ?? null, b.quantity ?? 1, b.acquiredAt ?? null, b.targetLocation ?? null],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23503") {
          throw new AppError(422, "invalid_reference", "categoryId does not reference an existing category");
        }
        throw error;
      }
      ctx.events.publish(
        "assets.item.created.v1",
        { id: newId, name: b.name, categoryId: b.categoryId ?? null },
        "assets",
      );
      return reply.code(201).send(rows.rows[0]);
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/items/:id", async (request) => {
    const { rows } = await db.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM assets.items WHERE id = $1`,
      [request.params.id],
    );
    if (!rows[0]) throw new AppError(404, "not_found", "item not found");
    return rows[0];
  });

  // Partial update with real nullable semantics (FP-2B.1): a missing property
  // leaves the column unchanged, an explicit null clears it, a value updates it.
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
            categoryId: { type: ["string", "null"] },
            targetLocation: { type: ["string", "null"], maxLength: 300 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const columns: Array<[string, string]> = [
        ["name", "name"],
        ["description", "description"],
        ["quantity", "quantity"],
        ["acquiredAt", "acquired_at"],
        ["categoryId", "category_id"],
        ["targetLocation", "target_location"],
      ];
      const sets: string[] = [];
      const params: unknown[] = [request.params.id];
      for (const [key, column] of columns) {
        if (!(key in body)) continue;
        params.push(body[key]);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) {
        const current = await db.query<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM assets.items WHERE id = $1`,
          [request.params.id],
        );
        if (!current.rows[0]) throw new AppError(404, "not_found", "item not found");
        return current.rows[0];
      }
      sets.push("updated_at = now()");

      let rows: { rows: ItemRow[] };
      try {
        rows = await db.query<ItemRow>(
          `UPDATE assets.items SET ${sets.join(", ")}
           WHERE id = $1
           RETURNING ${ITEM_COLUMNS}`,
          params,
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23503") {
          throw new AppError(422, "invalid_reference", "categoryId does not reference an existing category");
        }
        throw error;
      }
      if (!rows.rows[0]) throw new AppError(404, "not_found", "item not found");
      return rows.rows[0];
    },
  );

  ctx.api.delete<{ Params: { id: string } }>("/items/:id", async (request, reply) => {
    // Collect attachment metadata first, remove the physical objects, then
    // drop the row. Storage failures abort with metadata intact. If the DB
    // delete fails after files are gone, the dangling metadata rows are
    // enqueued for compensation (FP-12.1).
    const attachments = await db.query<AttachmentRow>(
      "SELECT id, item_id, filename, content_type, size, storage_key, created_at FROM assets.attachments WHERE item_id = $1",
      [request.params.id],
    );
    const deletedFiles: AttachmentRow[] = [];
    for (const row of attachments.rows) {
      try {
        await ctx.storage.delete(row.storage_key);
        deletedFiles.push(row);
      } catch (error) {
        // Files already removed above must not keep dangling metadata, but
        // the row stays (the item delete aborted), so enqueue the drop.
        for (const done of deletedFiles) {
          await compensate(ctx, {
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
      const result = await db.query("DELETE FROM assets.items WHERE id = $1", [request.params.id]);
      if (result.rowCount === 0) throw new AppError(404, "not_found", "item not found");
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Files are gone but the row remains: queue metadata drops.
      for (const done of deletedFiles) {
        await compensate(ctx, {
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
      const item = await db.query<ItemRow>("SELECT id FROM assets.items WHERE id = $1", [request.params.id]);
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
      await ctx.storage.save(storageKey, data);
      try {
        const { rows } = await db.query(
          `INSERT INTO assets.attachments (id, item_id, filename, content_type, size, storage_key)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, item_id, filename, content_type, size, created_at`,
          [attachmentId, request.params.id, filename, file.mimetype || null, data.length, storageKey],
        );
        return reply.code(201).send(rows[0]);
      } catch (error) {
        // DB failed after the file landed: compensate so no orphan remains
        // (enqueued + inline best-effort, hourly scheduler as backstop).
        await compensate(ctx, {
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
    const { rows } = await db.query(
      "SELECT id, item_id, filename, content_type, size, created_at FROM assets.attachments WHERE item_id = $1 ORDER BY created_at",
      [request.params.id],
    );
    return { items: rows };
  });

  ctx.api.get<{ Params: { id: string; attachmentId: string } }>(
    "/items/:id/attachments/:attachmentId",
    async (request, reply) => {
      const { rows } = await db.query<{ storage_key: string; filename: string; content_type: string | null }>(
        "SELECT storage_key, filename, content_type FROM assets.attachments WHERE id = $1 AND item_id = $2",
        [request.params.attachmentId, request.params.id],
      );
      if (!rows[0]) throw new AppError(404, "not_found", "attachment not found");
      const data = await ctx.storage.read(rows[0].storage_key);
      const safeFilename = rows[0].filename.replace(/[\r\n"]/g, "_");
      return reply
        .type(rows[0].content_type ?? "application/octet-stream")
        .header("content-disposition", `inline; filename="${safeFilename}"`)
        .send(data);
    },
  );

  // Delete one attachment: storage object first, metadata second. If the DB
  // delete fails after the file is gone, the dangling row is queued for
  // compensation instead of silently pointing at nothing (FP-12.1).
  ctx.api.delete<{ Params: { id: string; attachmentId: string } }>(
    "/items/:id/attachments/:attachmentId",
    async (request, reply) => {
      const { rows } = await db.query<{ id: string; storage_key: string }>(
        "SELECT id, storage_key FROM assets.attachments WHERE id = $1 AND item_id = $2",
        [request.params.attachmentId, request.params.id],
      );
      if (!rows[0]) throw new AppError(404, "not_found", "attachment not found");
      await ctx.storage.delete(rows[0].storage_key);
      try {
        await db.query("DELETE FROM assets.attachments WHERE id = $1", [request.params.attachmentId]);
      } catch (error) {
        await compensate(ctx, {
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

  ctx.api.get("/summary", async () => {
    const items = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM assets.items");
    const categories = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM assets.categories",
    );
    return {
      items: Number(items.rows[0]?.count ?? 0),
      categories: Number(categories.rows[0]?.count ?? 0),
    };
  });

  // Operator surface for the consistency machinery: run reconciliation on
  // demand and observe the queue (also used by integration tests).
  ctx.api.post("/maintenance/reconcile", async () => {
    return reconcileStorage(ctx);
  });
  ctx.api.get("/maintenance/cleanup-jobs", async () => {
    const { rows } = await db.query<CleanupJobRow>(
      `SELECT id, kind, storage_key, attachment_id, reason, status, attempts, last_error, created_at, updated_at
       FROM assets.cleanup_jobs ORDER BY created_at DESC LIMIT 100`,
    );
    return { items: rows };
  });
}

async function registerJobs(ctx: AppContext): Promise<JobHandle[]> {
  const reconcile = async () => {
    const result = await reconcileStorage(ctx);
    if (result.queue.processed > 0 || result.danglingDropped > 0) {
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
