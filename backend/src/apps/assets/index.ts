import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";

interface CategoryRow {
  id: string;
  name: string;
  created_at: string;
}

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

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.get("/categories", async () => {
    const { rows } = await db.query<CategoryRow>(
      "SELECT id, name, created_at FROM assets.categories ORDER BY name",
    );
    return { items: rows };
  });

  ctx.api.post<{ Body: { name: string } }>(
    "/categories",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      try {
        const { rows } = await db.query<CategoryRow>(
          "INSERT INTO assets.categories (id, name) VALUES ($1, $2) RETURNING id, name, created_at",
          [randomUUID(), request.body.name],
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

  ctx.api.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/categories/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request) => {
      try {
        const { rows } = await db.query<CategoryRow>(
          "UPDATE assets.categories SET name = $2 WHERE id = $1 RETURNING id, name, created_at",
          [request.params.id, request.body.name],
        );
        if (!rows[0]) throw new AppError(404, "not_found", "category not found");
        return rows[0];
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(422, "category_name_taken", `a category named "${request.body.name}" already exists`);
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
        conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
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
    // Collect attachment storage keys first and remove the physical objects;
    // only then drop the row (which cascades attachment metadata). Storage
    // failures abort the request so no orphan files are left behind (FP-2B.2).
    const attachments = await db.query<{ storage_key: string }>(
      "SELECT storage_key FROM assets.attachments WHERE item_id = $1",
      [request.params.id],
    );
    for (const row of attachments.rows) {
      await ctx.storage.delete(row.storage_key);
    }
    const result = await db.query("DELETE FROM assets.items WHERE id = $1", [request.params.id]);
    if (result.rowCount === 0) throw new AppError(404, "not_found", "item not found");
    return reply.code(204).send();
  });

  ctx.api.post<{ Params: { id: string }; Body: { filename: string; contentType?: string; dataBase64: string } }>(
    "/items/:id/attachments",
    {
      schema: {
        body: {
          type: "object",
          required: ["filename", "dataBase64"],
          additionalProperties: false,
          properties: {
            filename: { type: "string", minLength: 1, maxLength: 300 },
            contentType: { type: "string", maxLength: 200 },
            dataBase64: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const item = await db.query<ItemRow>("SELECT id FROM assets.items WHERE id = $1", [request.params.id]);
      if (!item.rows[0]) throw new AppError(404, "not_found", "item not found");

      const data = Buffer.from(request.body.dataBase64, "base64");
      const attachmentId = randomUUID();
      const storageKey = `attachments/${request.params.id}/${attachmentId}`;
      await ctx.storage.save(storageKey, data);

      const { rows } = await db.query(
        `INSERT INTO assets.attachments (id, item_id, filename, content_type, size, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, item_id, filename, content_type, size, created_at`,
        [attachmentId, request.params.id, request.body.filename, request.body.contentType ?? null, data.length, storageKey],
      );
      return reply.code(201).send(rows[0]);
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

  // Delete one attachment: storage object first, metadata second, so a failure
  // never leaves an orphaned file behind (FP-2B.2).
  ctx.api.delete<{ Params: { id: string; attachmentId: string } }>(
    "/items/:id/attachments/:attachmentId",
    async (request, reply) => {
      const { rows } = await db.query<{ storage_key: string }>(
        "SELECT storage_key FROM assets.attachments WHERE id = $1 AND item_id = $2",
        [request.params.attachmentId, request.params.id],
      );
      if (!rows[0]) throw new AppError(404, "not_found", "attachment not found");
      await ctx.storage.delete(rows[0].storage_key);
      await db.query("DELETE FROM assets.attachments WHERE id = $1", [request.params.attachmentId]);
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
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM assets.items LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, healthcheck };
export default app;
