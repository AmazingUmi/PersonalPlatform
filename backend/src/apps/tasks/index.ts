import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import type { JobHandle } from "../../core/scheduler/index.js";

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const id = "tasks";

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.get("/tasks", async (request) => {
    const query = (request.query ?? {}) as { status?: string; dueBefore?: string };
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.dueBefore) {
      params.push(query.dueBefore);
      conditions.push(`due_at IS NOT NULL AND due_at < $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await db.query<TaskRow>(
      `SELECT id, title, description, status, due_at, completed_at, created_at, updated_at
       FROM tasks.tasks ${where} ORDER BY created_at DESC`,
      params,
    );
    return { items: rows };
  });

  ctx.api.post<{ Body: { title: string; description?: string; dueAt?: string } }>(
    "/tasks",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 300 },
            description: { type: "string" },
            dueAt: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { rows } = await db.query<TaskRow>(
        `INSERT INTO tasks.tasks (id, title, description, due_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, description, status, due_at, completed_at, created_at, updated_at`,
        [randomUUID(), request.body.title, request.body.description ?? null, request.body.dueAt ?? null],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/tasks/:id", async (request) => {
    const { rows } = await db.query<TaskRow>(
      "SELECT id, title, description, status, due_at, completed_at, created_at, updated_at FROM tasks.tasks WHERE id = $1",
      [request.params.id],
    );
    if (!rows[0]) throw new AppError(404, "not_found", "task not found");
    return rows[0];
  });

  ctx.api.put<{ Params: { id: string }; Body: { title?: string; description?: string; status?: string; dueAt?: string } }>(
    "/tasks/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1 },
            description: { type: "string" },
            status: { type: "string", enum: ["todo", "done"] },
            dueAt: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const b = request.body;
      const prev = await db.query<TaskRow>("SELECT status, title FROM tasks.tasks WHERE id = $1", [request.params.id]);
      if (!prev.rows[0]) throw new AppError(404, "not_found", "task not found");

      const completedAt = b.status === "done" ? "now()" : b.status === "todo" ? "NULL" : "completed_at";
      const { rows } = await db.query<TaskRow>(
        `UPDATE tasks.tasks SET
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           status = COALESCE($4, status),
           due_at = COALESCE($5, due_at),
           completed_at = ${completedAt},
           updated_at = now()
         WHERE id = $1
         RETURNING id, title, description, status, due_at, completed_at, created_at, updated_at`,
        [request.params.id, b.title ?? null, b.description ?? null, b.status ?? null, b.dueAt ?? null],
      );

      const updated = rows[0]!;
      if (b.status === "done" && prev.rows[0].status !== "done") {
        ctx.events.publish("tasks.task.completed.v1", { id: updated.id, title: updated.title }, "tasks");
      }
      return updated;
    },
  );

  ctx.api.delete<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const result = await db.query("DELETE FROM tasks.tasks WHERE id = $1", [request.params.id]);
    if (result.rowCount === 0) throw new AppError(404, "not_found", "task not found");
    return reply.code(204).send();
  });

  ctx.api.get("/summary", async () => {
    const today = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tasks.tasks WHERE status <> 'done' AND due_at IS NOT NULL AND due_at::date = CURRENT_DATE",
    );
    const overdue = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tasks.tasks WHERE status <> 'done' AND due_at IS NOT NULL AND due_at < now()",
    );
    const done = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tasks.tasks WHERE status = 'done'",
    );
    return {
      today: Number(today.rows[0]?.count ?? 0),
      overdue: Number(overdue.rows[0]?.count ?? 0),
      done: Number(done.rows[0]?.count ?? 0),
    };
  });
}

async function registerJobs(ctx: AppContext): Promise<JobHandle[]> {
  return [
    ctx.scheduler.register({
      id: "tasks.overdue_check",
      schedule: { cron: "0 0 * * *" },
      run: async () => {
        const { rows } = await ctx.database.query<TaskRow>(
          "SELECT id, title FROM tasks.tasks WHERE status <> 'done' AND due_at IS NOT NULL AND due_at < now()",
        );
        for (const task of rows) {
          ctx.events.publish("tasks.task.overdue.v1", { id: task.id, title: task.title }, "tasks");
        }
      },
    }),
  ];
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM tasks.tasks LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, registerJobs, healthcheck };
export default app;
