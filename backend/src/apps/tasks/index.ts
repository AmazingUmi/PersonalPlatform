import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import type { JobHandle } from "../../core/scheduler/index.js";

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  start_at: string | null;
  due_at: string | null;
  priority: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Explicit sort allowlist: request values never reach SQL as identifiers. */
const TASK_SORT_COLUMNS: Record<string, string> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  startAt: "start_at",
  dueAt: "due_at",
  priority: "priority",
  title: "title",
  status: "status",
};

const TASK_COLUMNS =
  "id, title, description, status, start_at, due_at, priority, completed_at, created_at, updated_at";

const id = "tasks";

/** Reject dueAt earlier than startAt unless both are absent/unchanged (FP-4.2). */
function assertValidInterval(startAt: string | null | undefined, dueAt: string | null | undefined): void {
  if (startAt && dueAt && new Date(dueAt).getTime() < new Date(startAt).getTime()) {
    throw new AppError(422, "invalid_time_interval", "dueAt must not be earlier than startAt");
  }
}

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.get<{ Querystring: Record<string, string> }>(
    "/tasks",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", maxLength: 300 },
            status: { type: "string", enum: ["todo", "done"] },
            priority: { type: "integer", minimum: 0, maximum: 3 },
            startAfter: { type: "string", format: "date-time" },
            startBefore: { type: "string", format: "date-time" },
            dueAfter: { type: "string", format: "date-time" },
            dueBefore: { type: "string", format: "date-time" },
            sortBy: { type: "string", enum: Object.keys(TASK_SORT_COLUMNS) },
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
        conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
      }
      if (query.status) {
        params.push(query.status);
        conditions.push(`status = $${params.length}`);
      }
      if (query.priority !== undefined) {
        params.push(query.priority);
        conditions.push(`priority = $${params.length}`);
      }
      if (query.startAfter) {
        params.push(query.startAfter);
        conditions.push(`start_at >= $${params.length}`);
      }
      if (query.startBefore) {
        params.push(query.startBefore);
        conditions.push(`start_at < $${params.length}`);
      }
      if (query.dueAfter) {
        params.push(query.dueAfter);
        conditions.push(`due_at >= $${params.length}`);
      }
      if (query.dueBefore) {
        params.push(query.dueBefore);
        conditions.push(`due_at < $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      const sortColumn = TASK_SORT_COLUMNS[query.sortBy ?? "createdAt"] ?? "created_at";
      const direction = query.order === "asc" ? "ASC" : "DESC";
      const orderBy = `${sortColumn} ${direction} NULLS LAST, created_at DESC, id`;

      const { rows } = await db.query<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM tasks.tasks ${where} ORDER BY ${orderBy}`,
        params,
      );
      return { items: rows };
    },
  );

  ctx.api.post<{ Body: { title: string; description?: string | null; status?: string; startAt?: string | null; dueAt?: string | null; priority?: number } }>(
    "/tasks",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 300 },
            description: { type: ["string", "null"], maxLength: 5000 },
            status: { type: "string", enum: ["todo", "done"] },
            startAt: { type: ["string", "null"], format: "date-time" },
            dueAt: { type: ["string", "null"], format: "date-time" },
            priority: { type: "integer", minimum: 0, maximum: 3 },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      assertValidInterval(b.startAt ?? null, b.dueAt ?? null);
      const { rows } = await db.query<TaskRow>(
        `INSERT INTO tasks.tasks (id, title, description, status, start_at, due_at, priority, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 = 'done' THEN now() ELSE NULL END)
         RETURNING ${TASK_COLUMNS}`,
        [
          randomUUID(),
          b.title,
          b.description ?? null,
          b.status ?? "todo",
          b.startAt ?? null,
          b.dueAt ?? null,
          b.priority ?? 1,
        ],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/tasks/:id", async (request) => {
    const { rows } = await db.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks.tasks WHERE id = $1`, [
      request.params.id,
    ]);
    if (!rows[0]) throw new AppError(404, "not_found", "task not found");
    return rows[0];
  });

  // Partial update with real nullable semantics: a missing property leaves the
  // column unchanged, an explicit null clears it, a value updates it.
  ctx.api.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/tasks/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 300 },
            description: { type: ["string", "null"], maxLength: 5000 },
            status: { type: "string", enum: ["todo", "done"] },
            startAt: { type: ["string", "null"], format: "date-time" },
            dueAt: { type: ["string", "null"], format: "date-time" },
            priority: { type: "integer", minimum: 0, maximum: 3 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const prev = await db.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks.tasks WHERE id = $1`, [
        request.params.id,
      ]);
      if (!prev.rows[0]) throw new AppError(404, "not_found", "task not found");
      const previous = prev.rows[0];

      assertValidInterval(
        ("startAt" in body ? (body.startAt as string | null) : previous.start_at),
        ("dueAt" in body ? (body.dueAt as string | null) : previous.due_at),
      );

      // Completion timestamp transitions (FP-2C.1):
      //   todo -> done  => completed_at = now()
      //   done -> done  => completed_at unchanged (no refresh on repeat)
      //   done -> todo  => completed_at = null
      const nextStatus = ("status" in body ? body.status : undefined) as string | undefined;
      const completedAt =
        nextStatus === "done" && previous.status !== "done"
          ? "now()"
          : nextStatus === "todo"
            ? "NULL"
            : "completed_at";

      const columns: Array<[string, string]> = [
        ["title", "title"],
        ["description", "description"],
        ["status", "status"],
        ["startAt", "start_at"],
        ["dueAt", "due_at"],
        ["priority", "priority"],
      ];
      const sets: string[] = [];
      const params: unknown[] = [request.params.id];
      for (const [key, column] of columns) {
        if (!(key in body)) continue;
        params.push(body[key]);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) return previous;
      sets.push(`completed_at = ${completedAt}`, "updated_at = now()");

      const { rows } = await db.query<TaskRow>(
        `UPDATE tasks.tasks SET ${sets.join(", ")}
         WHERE id = $1
         RETURNING ${TASK_COLUMNS}`,
        params,
      );

      const updated = rows[0]!;
      if (nextStatus === "done" && previous.status !== "done") {
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
    // Today = deadline today; overdue = not done and due_at < now(). Completed
    // tasks are excluded from both (FP-4.5).
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
        // Known limitation: this fires daily and re-notifies every still-
        // overdue task; dedupe is deferred until notification persistence
        // exists (FP-4.5 documents the current behavior).
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
