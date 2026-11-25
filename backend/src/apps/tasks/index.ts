import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppAgentContext, AppAgentInvocation } from "../../core/agent/types.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import {
  assertPresentedHash, editorBaseHash, headerPresentedHash, lockOwnedTables, parseSnapshotRow, readPresentedHash, syncWriteFenced,
} from "../../core/data-management/sync-fence.js";
import { record, validTimestamp } from "../../core/data-management/snapshot-schema.js";
import type { JobHandle } from "../../core/scheduler/index.js";
import type { OwnedTrashEntry, TrashMutationContext, TrashRestoreContext } from "../../core/trash/types.js";

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

type Tx = AppContext["database"];

function taskHash(snapshot: string): string {
  return editorBaseHash([{ table: "tasks.tasks", row: parseSnapshotRow(snapshot) }]);
}

function withTaskHash<T extends TaskRow>(row: T & { snapshot: string }): TaskRow & { baseHash: string } {
  const { snapshot, ...task } = row;
  return { ...task, baseHash: taskHash(snapshot) };
}

/** Reject dueAt earlier than startAt unless both are absent/unchanged (FP-4.2). */
function assertValidInterval(startAt: string | null | undefined, dueAt: string | null | undefined): void {
  if (startAt && dueAt && new Date(dueAt).getTime() < new Date(startAt).getTime()) {
    throw new AppError(422, "invalid_time_interval", "dueAt must not be earlier than startAt");
  }
}

async function lockedTask(
  tx: Tx,
  taskId: string,
  userId: string,
): Promise<(TaskRow & { snapshot: string }) | null> {
  const { rows } = await tx.query<TaskRow & { snapshot: string }>(
    `SELECT ${TASK_COLUMNS}, row_to_json(t)::text AS snapshot
     FROM tasks.tasks t WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [taskId, userId],
  );
  return rows[0] ?? null;
}

export async function deleteTask(ctx: TrashMutationContext, taskId: string, presentedHash: string | undefined, agent = false): Promise<void> {
  const { database: tx, userId } = ctx;
  await lockOwnedTables(tx, ["tasks.tasks"]);
  const current = await lockedTask(tx, taskId, userId);
  if (!current) throw new AppError(404, "not_found", "task not found");
  await checkTaskHash(tx, userId, presentedHash, withTaskHash(current), agent);

  const { title, description, status, start_at, due_at, priority, completed_at, created_at, updated_at } = parseSnapshotRow(current.snapshot);
  await ctx.moveToTrash({
    entityType: "task", entityId: current.id, title: current.title,
    summary: current.description?.slice(0, 160) || null,
    payload: { title, description, status, start_at, due_at, priority, completed_at, created_at, updated_at },
  });
  await tx.query("DELETE FROM tasks.tasks WHERE id = $1 AND user_id = $2", [taskId, userId]);
}

function nullableTaskTimestamp(value: unknown): boolean {
  return value === null || (typeof value === "string" && validTimestamp(value));
}

async function restoreFromTrash(ctx: TrashRestoreContext, entry: OwnedTrashEntry): Promise<{ restoredId: string }> {
  const { database: tx, userId, restoredId } = ctx;
  const payload = record(entry.payload) ? entry.payload : {};
  const { title, description, status, start_at, due_at, priority, completed_at, created_at, updated_at } = payload;
  if (entry.entityType !== "task" || entry.payloadVersion !== 1 || entry.attachmentKeys.length !== 0
    || typeof title !== "string" || (description !== null && typeof description !== "string")
    || (status !== "todo" && status !== "done")
    || typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 3
    || !nullableTaskTimestamp(start_at) || !nullableTaskTimestamp(due_at) || !nullableTaskTimestamp(completed_at)
    || typeof created_at !== "string" || !validTimestamp(created_at)
    || typeof updated_at !== "string" || !validTimestamp(updated_at)) {
    throw new AppError(422, "trash_payload_invalid", "The archived task data is unsupported or invalid.");
  }

  await lockOwnedTables(tx, ["tasks.tasks"]);
  const original = await tx.query("SELECT 1 FROM tasks.tasks WHERE id = $1 AND user_id = $2", [entry.entityId, userId]);
  if (original.rowCount) throw new AppError(409, "original_live", "The original task already exists.");
  await tx.query(
    `INSERT INTO tasks.tasks (id, user_id, title, description, status, start_at, due_at, priority, completed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [restoredId, userId, title, description, status, start_at, due_at, priority, completed_at, created_at, updated_at],
  );
  return { restoredId };
}


async function readTask(db: Tx, taskId: string, userId: string) {
  const { rows } = await db.query<TaskRow & { snapshot: string }>(
    `SELECT ${TASK_COLUMNS}, row_to_json(t)::text AS snapshot
     FROM tasks.tasks t WHERE id = $1 AND user_id = $2`,
    [taskId, userId],
  );
  if (!rows[0]) throw new AppError(404, "not_found", "task not found");
  return withTaskHash(rows[0]);
}

interface TaskInput {
  title: string;
  description?: string | null;
  status?: string;
  startAt?: string | null;
  dueAt?: string | null;
  priority?: number;
}

interface TaskFilters {
  q?: string;
  status?: string;
  priority?: number | string;
  startAfter?: string;
  startBefore?: string;
  dueAfter?: string;
  dueBefore?: string;
}

const taskProperties = {
  title: { type: "string", minLength: 1, maxLength: 300 },
  description: { type: ["string", "null"], maxLength: 5000 },
  status: { type: "string", enum: ["todo", "done"] },
  startAt: { type: ["string", "null"], format: "date-time" },
  dueAt: { type: ["string", "null"], format: "date-time" },
  priority: { type: "integer", minimum: 0, maximum: 3 },
};
const taskUuid = { type: "string", format: "uuid" };
const taskBaseHash = { type: "string", pattern: "^[0-9a-fA-F]{64}$" };

function taskArgs(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object" as const, additionalProperties: false, properties, required };
}

function taskFilters(userId: string, query: TaskFilters): { where: string; params: unknown[] } {
  // Ownership is the leading, always-present predicate (AUTH-3).
  const conditions: string[] = ["user_id = $1"];
  const params: unknown[] = [userId];
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
  const where = `WHERE ${conditions.join(" AND ")}`;

  return { where, params };
}

async function createTask(tx: Tx, userId: string, b: TaskInput) {
  assertValidInterval(b.startAt ?? null, b.dueAt ?? null);
  await lockOwnedTables(tx, ["tasks.tasks"]);
  const { rows } = await tx.query<TaskRow & { snapshot: string }>(
    `INSERT INTO tasks.tasks AS t (id, user_id, title, description, status, start_at, due_at, priority, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $5 = 'done' THEN now() ELSE NULL END)
     RETURNING ${TASK_COLUMNS}, row_to_json(t)::text AS snapshot`,
    [
      randomUUID(),
      userId,
      b.title,
      b.description ?? null,
      b.status ?? "todo",
      b.startAt ?? null,
      b.dueAt ?? null,
      b.priority ?? 1,
    ],
  );
  return withTaskHash(rows[0]!);
}

async function checkTaskHash(tx: Tx, userId: string, presented: string | undefined, current: TaskRow & { baseHash: string }, agent: boolean): Promise<void> {
  const fenced = await syncWriteFenced(tx, userId);
  try {
    assertPresentedHash(fenced, presented, current.baseHash);
  } catch (error) {
    if (agent && error instanceof AppError && error.code === "sync_stale") {
      throw new AppError(409, "conflict", "The task changed. Review the current data before retrying.",
        { current, retryHint: "Retry with the returned baseHash after reviewing the changes." });
    }
    throw error;
  }
}

async function updateTask(tx: Tx, userId: string, taskId: string, body: Record<string, unknown>, presented: string | undefined, agent = false) {
  await lockOwnedTables(tx, ["tasks.tasks"]);
  const current = await lockedTask(tx, taskId, userId);
  if (!current) throw new AppError(404, "not_found", "task not found");
  const previous = withTaskHash(current);
  if (agent) await checkTaskHash(tx, userId, presented, previous, true);
  assertValidInterval(
    ("startAt" in body ? (body.startAt as string | null) : previous.start_at),
    ("dueAt" in body ? (body.dueAt as string | null) : previous.due_at),
  );
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
  const params: unknown[] = [taskId, userId];
  for (const [key, column] of columns) {
    if (!(key in body)) continue;
    params.push(body[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return { updated: previous, completed: false };
  if (!agent) await checkTaskHash(tx, userId, presented, previous, false);
  sets.push(`completed_at = ${completedAt}`, "updated_at = now()");
  const { rows } = await tx.query<TaskRow & { snapshot: string }>(
    `UPDATE tasks.tasks AS t SET ${sets.join(", ")}
     WHERE id = $1 AND user_id = $2
     RETURNING ${TASK_COLUMNS}, row_to_json(t)::text AS snapshot`,
    params,
  );
  if (!rows[0]) throw new AppError(404, "not_found", "task not found");
  return {
    updated: withTaskHash(rows[0]),
    completed: nextStatus === "done" && previous.status !== "done",
  };
}

async function taskSummary(db: Tx, userId: string, time: AppContext["time"], at?: Date) {
  // "Today" is the user's local calendar day from the platform TimeService
  // (FP-10.3), expressed as a UTC [start, end) window — never
  // due_at::date = CURRENT_DATE, which would use the server timezone.
  // Overdue = not done and due_at < now; completed tasks are excluded from
  // both (FP-4.5).
  // doneToday + overdueBeforeToday extend the snapshot for the dashboard
  // completion meter. The meter's three segments are disjoint by
  // construction: doneToday (done, completed today) vs open tasks split by
  // due date (today window / strictly before it) — a task due 9am and still
  // todo at 10am counts once, in `today`, unlike the overlapping
  // today/overdue pair kept for the counters above.
  const { start, end } = time.todayRangeUtc(at);
  const today = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM tasks.tasks WHERE user_id = $1 AND status <> 'done' AND due_at IS NOT NULL AND due_at >= $2 AND due_at < $3",
    [userId, start.toISOString(), end.toISOString()],
  );
  const overdue = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM tasks.tasks WHERE user_id = $1 AND status <> 'done' AND due_at IS NOT NULL AND due_at < COALESCE($2::timestamptz, now())",
    [userId, at ?? null],
  );
  const done = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM tasks.tasks WHERE user_id = $1 AND status = 'done'",
    [userId],
  );
  const doneToday = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM tasks.tasks WHERE user_id = $1 AND status = 'done' AND completed_at >= $2 AND completed_at < $3",
    [userId, start.toISOString(), end.toISOString()],
  );
  const overdueBeforeToday = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM tasks.tasks WHERE user_id = $1 AND status <> 'done' AND due_at IS NOT NULL AND due_at < $2",
    [userId, start.toISOString()],
  );
  return {
    today: Number(today.rows[0]?.count ?? 0),
    overdue: Number(overdue.rows[0]?.count ?? 0),
    done: Number(done.rows[0]?.count ?? 0),
    doneToday: Number(doneToday.rows[0]?.count ?? 0),
    overdueBeforeToday: Number(overdueBeforeToday.rows[0]?.count ?? 0),
  };
}

function publishTaskCompletion(ctx: Pick<AppContext, "events"> | AppAgentInvocation, userId: string, task: TaskRow): void {
  ctx.events.publish("tasks.task.completed.v1", { userId, id: task.id, title: task.title }, "tasks");
}

async function registerAgent(agent: AppAgentContext): Promise<void> {
  agent.tool({
    name: "tasks_list", description: "List owned tasks with pagination, status and due-date filters.",
    action: "read", scopes: ["read"],
    inputSchema: taskArgs({
      q: { type: "string", maxLength: 300 }, status: taskProperties.status, priority: taskProperties.priority,
      dueAfter: { type: "string", format: "date-time" }, dueBefore: { type: "string", format: "date-time" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      offset: { type: "integer", minimum: 0, maximum: 2_147_483_647, default: 0 },
      includeDescription: { type: "boolean", default: false },
    }),
    execute: async ({ database, userId }, args) => {
      const { where, params } = taskFilters(userId, args);
      const columns = args.includeDescription ? TASK_COLUMNS : "id, title, status, start_at, due_at, priority, completed_at, created_at, updated_at";
      const limit = params.length + 1;
      const { rows } = await database.query(
        `SELECT ${columns} FROM tasks.tasks ${where} ORDER BY created_at DESC, id LIMIT $${limit} OFFSET $${limit + 1}`,
        [...params, args.limit, args.offset],
      );
      return { data: { items: rows } };
    },
  });
  agent.tool({
    name: "tasks_get", description: "Get an owned task and its concurrency hash.",
    action: "read", scopes: ["read"], inputSchema: taskArgs({ id: taskUuid }, ["id"]),
    execute: async ({ database, userId }, args) => ({ data: await readTask(database, args.id as string, userId) }),
  });
  agent.tool({
    name: "tasks_create", description: "Create one owned task.",
    action: "write", scopes: ["write"], create: true,
    inputSchema: taskArgs({
      ...taskProperties,
      description: { ...taskProperties.description, default: null },
      status: { ...taskProperties.status, default: "todo" },
      startAt: { ...taskProperties.startAt, default: null },
      dueAt: { ...taskProperties.dueAt, default: null },
      priority: { ...taskProperties.priority, default: 1 },
    }, ["title"]),
    execute: async ({ database, userId }, args) => {
      const task = await createTask(database, userId, args as unknown as TaskInput);
      return { data: { id: task.id }, resourceId: task.id };
    },
  });

  const update = async (ctx: AppAgentInvocation, args: Record<string, unknown>, body: Record<string, unknown>) => {
    const outcome = await updateTask(ctx.database, ctx.userId, args.id as string, body, readPresentedHash(args.baseHash), true);
    if (outcome.completed) publishTaskCompletion(ctx, ctx.userId, outcome.updated);
    return { data: outcome.updated, resourceId: outcome.updated.id };
  };
  agent.tool({
    name: "tasks_update", description: "Update selected fields of an owned task using its baseHash.",
    action: "write", scopes: ["read", "write"],
    inputSchema: taskArgs({ ...taskProperties, id: taskUuid, baseHash: taskBaseHash }, ["id", "baseHash"]),
    execute: (ctx, args) => update(ctx, args, args),
  });
  agent.tool({
    name: "tasks_complete", description: "Mark an owned task done, or return it to todo, using its baseHash.",
    action: "write", scopes: ["read", "write"],
    inputSchema: taskArgs({ id: taskUuid, baseHash: taskBaseHash, done: { type: "boolean", default: true } }, ["id", "baseHash"]),
    execute: (ctx, args) => update(ctx, args, { status: args.done ? "done" : "todo" }),
  });
  agent.tool({
    name: "tasks_delete", description: "Move an owned task to Trash using its baseHash.",
    action: "delete", scopes: ["read", "delete"], inputSchema: taskArgs({ id: taskUuid, baseHash: taskBaseHash }, ["id", "baseHash"]),
    execute: async ({ trash }, args) => {
      if (!trash) throw new Error("Missing authorized task Trash operation");
      const taskId = args.id as string;
      await deleteTask(trash, taskId, readPresentedHash(args.baseHash), true);
      return { data: { id: taskId }, resourceId: taskId };
    },
  });

  const summary = ({ database, userId, time }: AppAgentInvocation) => taskSummary(database, userId, time, time.now());
  agent.resource({ uri: "pp://apps/tasks/summary", name: "Tasks summary", read: summary });
  agent.overview(summary);
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
      const user = await ctx.auth.requireUser(request);
      const query = request.query;
      const { where, params } = taskFilters(user.id, query);
      const sortColumn = TASK_SORT_COLUMNS[query.sortBy ?? "createdAt"] ?? "created_at";
      const direction = query.order === "asc" ? "ASC" : "DESC";
      const orderBy = `${sortColumn} ${direction} NULLS LAST, created_at DESC, id`;

      const { rows } = await db.query<TaskRow & { snapshot: string }>(
        `SELECT ${TASK_COLUMNS}, row_to_json(t)::text AS snapshot
         FROM tasks.tasks t ${where} ORDER BY ${orderBy}`,
        params,
      );
      return { items: rows.map(withTaskHash) };
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
      const user = await ctx.auth.requireUser(request);
      const created = await db.withTransaction(tx => createTask(tx, user.id, request.body));
      return reply.code(201).send(created);
    },
  );

  ctx.api.get<{ Params: { id: string } }>("/tasks/:id", async (request) => {
    const user = await ctx.auth.requireUser(request);
    return readTask(db, request.params.id, user.id);
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
            baseHash: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const user = await ctx.auth.requireUser(request);
      const body = request.body as Record<string, unknown>;
      const presented = readPresentedHash(body.baseHash);
      const outcome = await db.withTransaction(tx => updateTask(tx, user.id, request.params.id, body, presented));
      if (outcome.completed) {
        publishTaskCompletion(ctx, user.id, outcome.updated);
      }
      return outcome.updated;
    },
  );

  ctx.api.delete<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const presented = headerPresentedHash(request.headers["x-base-hash"]);
    await ctx.trash.withMutation(request, (mutation) => deleteTask(mutation, request.params.id, presented));
    return reply.code(204).send();
  });

  ctx.api.get("/summary", async (request) => {
    const user = await ctx.auth.requireUser(request);
    return taskSummary(db, user.id, ctx.time);
  });

  // ---- Public status (cross-app read surface) --------------------------------
  //
  // The only sanctioned way for another app (Clock today; Calendar /
  // Statistics later) to consume task timing: a read-only HTTP contract
  // instead of table access. Authenticated and USER-SCOPED since AUTH-3:
  // "public" means a stable cross-app read contract, never cross-user —
  // the response always reflects the calling user's tasks only.
  // Frozen semantics (apps/tasks/README.md):
  //   current = most recently started todo task with start_at <= now
  //             (now == start_at is current; due_at NEVER ends it — an
  //             overdue todo task stays current until it is done)
  //   next    = earliest todo task with start_at > now (strictly future, so
  //             now == start_at can never be both)
  //   today.remainingCount = additional todo tasks starting later in the
  //             platform-local day, excluding next (current is excluded by
  //             start_at > now; tasks without start_at never count)
  ctx.api.get("/public/status", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const now = ctx.time.now();
    const current = await getCurrentTask(db, now, user.id);
    const next = await getNextTask(db, now, user.id);
    const exclude = next ? [next.id] : [];
    const { start, end } = ctx.time.todayRangeUtc(now);
    const remaining = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks.tasks
       WHERE user_id = $1 AND status = 'todo' AND start_at IS NOT NULL
         AND start_at > $4 AND start_at >= $2 AND start_at < $3
         AND id <> ALL($5::uuid[])`,
      [user.id, start.toISOString(), end.toISOString(), now.toISOString(), exclude],
    );
    return {
      current,
      next,
      today: { remainingCount: Number(remaining.rows[0]?.count ?? 0) },
    };
  });
}

/** Minimal view for /public/status — only the fields a consumer needs. */
export interface PublicTaskView {
  id: string;
  title: string;
  startAt: string;
}

/** Most recently started todo task (start_at <= now); due_at never ends it. */
async function getCurrentTask(
  db: AppContext["database"],
  now: Date,
  userId: string,
): Promise<PublicTaskView | null> {
  const { rows } = await db.query<{ id: string; title: string; start_at: string }>(
    `SELECT id, title, start_at FROM tasks.tasks
     WHERE user_id = $2 AND status = 'todo' AND start_at IS NOT NULL AND start_at <= $1
     ORDER BY start_at DESC, id
     LIMIT 1`,
    [now.toISOString(), userId],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, title: rows[0].title, startAt: rows[0].start_at };
}

/** Earliest strictly-future start. */
async function getNextTask(
  db: AppContext["database"],
  now: Date,
  userId: string,
): Promise<PublicTaskView | null> {
  const { rows } = await db.query<{ id: string; title: string; start_at: string }>(
    `SELECT id, title, start_at FROM tasks.tasks
     WHERE user_id = $2 AND status = 'todo' AND start_at IS NOT NULL AND start_at > $1
     ORDER BY start_at ASC, id
     LIMIT 1`,
    [now.toISOString(), userId],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, title: rows[0].title, startAt: rows[0].start_at };
}

async function registerJobs(ctx: AppContext): Promise<JobHandle[]> {
  // The daily boundary follows the platform timezone (FP-10.4); the app never
  // reads a system timezone itself. The sweep is platform-level but iterates
  // per-user rows explicitly: every overdue event carries its owner's userId
  // (AUTH-GATE-06) — there is no implicit "current user" in jobs.
  return [
    ctx.scheduler.register({
      id: "tasks.overdue_check",
      schedule: { cron: "0 0 * * *", timezone: ctx.time.timezone() },
      run: async () => {
        const { rows } = await ctx.database.query<{ id: string; title: string; user_id: string }>(
          "SELECT id, title, user_id FROM tasks.tasks WHERE status <> 'done' AND due_at IS NOT NULL AND due_at < now()",
        );
        for (const task of rows) {
          ctx.events.publish(
            "tasks.task.overdue.v1",
            { userId: task.user_id, id: task.id, title: task.title },
            "tasks",
          );
        }
      },
    }),
  ];
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM tasks.tasks LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, registerJobs, healthcheck, restoreFromTrash, registerAgent };
export default app;
