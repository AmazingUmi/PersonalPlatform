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
  created_at: string;
  updated_at: string;
}

const id = "assets";

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
      const { rows } = await db.query<CategoryRow>(
        "INSERT INTO assets.categories (id, name) VALUES ($1, $2) RETURNING id, name, created_at",
        [randomUUID(), request.body.name],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  ctx.api.get("/items", async (request) => {
    const query = (request.query ?? {}) as { q?: string; categoryId?: string };
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
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await db.query<ItemRow>(
      `SELECT id, category_id, name, description, quantity, acquired_at, created_at, updated_at
       FROM assets.items ${where} ORDER BY created_at DESC`,
      params,
    );
    return { items: rows };
  });

  ctx.api.post<{ Body: { name: string; description?: string; quantity?: number; acquiredAt?: string; categoryId?: string } }>(
    "/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 300 },
            description: { type: "string" },
            quantity: { type: "integer", minimum: 0 },
            acquiredAt: { type: "string" },
            categoryId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const newId = randomUUID();
      const { rows } = await db.query<ItemRow>(
        `INSERT INTO assets.items (id, category_id, name, description, quantity, acquired_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, category_id, name, description, quantity, acquired_at, created_at, updated_at`,
        [newId, b.categoryId ?? null, b.name, b.description ?? null, b.quantity ?? 1, b.acquiredAt ?? null],
      );
      ctx.events.publish(
        "assets.item.created.v1",
        { id: newId, name: b.name, categoryId: b.categoryId ?? null },
        "assets",
      );
      return reply.code(201).send(rows[0]);
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/items/:id", async (request) => {
    const { rows } = await db.query<ItemRow>(
      "SELECT id, category_id, name, description, quantity, acquired_at, created_at, updated_at FROM assets.items WHERE id = $1",
      [request.params.id],
    );
    if (!rows[0]) throw new AppError(404, "not_found", "item not found");
    return rows[0];
  });

  ctx.api.put<{ Params: { id: string }; Body: { name?: string; description?: string; quantity?: number; acquiredAt?: string; categoryId?: string } }>(
    "/items/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
            quantity: { type: "integer", minimum: 0 },
            acquiredAt: { type: "string" },
            categoryId: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const b = request.body;
      const { rows } = await db.query<ItemRow>(
        `UPDATE assets.items SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           quantity = COALESCE($4, quantity),
           acquired_at = COALESCE($5, acquired_at),
           category_id = COALESCE($6, category_id),
           updated_at = now()
         WHERE id = $1
         RETURNING id, category_id, name, description, quantity, acquired_at, created_at, updated_at`,
        [request.params.id, b.name ?? null, b.description ?? null, b.quantity ?? null, b.acquiredAt ?? null, b.categoryId ?? null],
      );
      if (!rows[0]) throw new AppError(404, "not_found", "item not found");
      return rows[0];
    },
  );

  ctx.api.delete<{ Params: { id: string } }>("/items/:id", async (request, reply) => {
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
            filename: { type: "string", minLength: 1 },
            contentType: { type: "string" },
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
      return reply
        .type(rows[0].content_type ?? "application/octet-stream")
        .header("content-disposition", `inline; filename="${rows[0].filename}"`)
        .send(data);
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
