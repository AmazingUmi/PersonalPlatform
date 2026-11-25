import { randomUUID } from "node:crypto";
import { AppError } from "../api/errors.js";
import type { Database, DatabaseContext } from "../database/index.js";
import type { AgentAuthority } from "./identity.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DAY_MS = 86_400_000;
const BATCH_SIZE = 500;

export interface AgentAuditInput {
  appId: string;
  toolName: string;
  actionKind: "write" | "delete";
  resourceId?: string | null;
  status: "ok" | "replayed" | "conflict" | "denied" | "error";
  errorCode?: string | null;
  createdAt: Date;
}

export interface AgentAuditEntry {
  id: string;
  agentId: string | null;
  agentName: string;
  appId: string;
  toolName: string;
  actionKind: AgentAuditInput["actionKind"];
  resourceId: string | null;
  status: AgentAuditInput["status"];
  errorCode: string | null;
  createdAt: string;
}

export interface AgentAuditPage {
  items: AgentAuditEntry[];
  nextCursor: string | null;
}

interface AuditCursor {
  id: string;
  createdAt: string;
}

function parseCursor(cursor: string | undefined): AuditCursor | undefined {
  if (cursor === undefined) return;
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw new Error("invalid cursor");
    const raw = Buffer.from(cursor, "base64url");
    if (raw.toString("base64url") !== cursor) throw new Error("invalid cursor encoding");
    const fields: unknown = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(fields) || fields.length !== 2) throw new Error("invalid cursor fields");
    const [createdAt, id] = fields;
    if (typeof createdAt !== "string" || !CURSOR_TIMESTAMP.test(createdAt) || typeof id !== "string" || !UUID.test(id)) {
      throw new Error("invalid cursor fields");
    }
    const milliseconds = createdAt.slice(0, 23) + "Z";
    if (new Date(milliseconds).toISOString() !== milliseconds) throw new Error("invalid cursor date");
    return { id, createdAt };
  } catch {
    throw new AppError(400, "validation_error", "Invalid audit cursor.");
  }
}

export async function insertAgentAudit(
  tx: DatabaseContext,
  authority: Pick<AgentAuthority, "agentId" | "agentName" | "userId">,
  input: AgentAuditInput,
): Promise<void> {
  // An Agent can disappear after an admitted action rolls back, but its verified
  // label still belongs in the acting user's diagnostic history.
  await tx.query(
    `INSERT INTO core.agent_audit_logs (id, agent_id, agent_name, user_id, app_id, tool_name, action_kind,
       resource_id, status, error_code, created_at)
     VALUES ($1, (SELECT id FROM core.agents WHERE id = $2 FOR KEY SHARE),
       $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [randomUUID(), authority.agentId, authority.agentName, authority.userId, input.appId, input.toolName,
      input.actionKind, input.resourceId ?? null, input.status, input.errorCode ?? null, input.createdAt],
  );
}

export async function readAgentAudit(
  tx: DatabaseContext,
  userId: string,
  options: { limit?: number; cursor?: string },
): Promise<AgentAuditPage> {
  const position = parseCursor(options.cursor);
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError(400, "validation_error", "Audit limit must be an integer between 1 and 100.");
  }
  const { rows } = await tx.query<AgentAuditEntry>(
    `SELECT id, agent_id AS "agentId", agent_name AS "agentName", app_id AS "appId",
       tool_name AS "toolName", action_kind AS "actionKind", resource_id AS "resourceId",
       status, error_code AS "errorCode",
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
     FROM core.agent_audit_logs WHERE user_id = $1
       AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
     ORDER BY created_at DESC, id DESC LIMIT $4`,
    [userId, position?.createdAt ?? null, position?.id ?? null, limit + 1],
  );
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url")
    : null;
  return { items, nextCursor };
}

async function purgeBatches(database: Database, sql: string, cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    // Each statement commits separately so later batches do not inherit its row locks.
    const { rowCount } = await database.query(sql, [cutoff, BATCH_SIZE]);
    const removed = rowCount ?? 0;
    total += removed;
    if (removed < BATCH_SIZE) return total;
  }
}

export async function purgeAgentActivity(
  database: Database,
  now: Date,
  retentionDays: number,
): Promise<{ auditRemoved: number; pairingsRemoved: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const auditRemoved = await purgeBatches(database,
    `WITH expired AS (
       SELECT id FROM core.agent_audit_logs WHERE created_at < $1
       ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
     ) DELETE FROM core.agent_audit_logs WHERE id IN (SELECT id FROM expired)`,
    cutoff,
  );
  const pairingsRemoved = await purgeBatches(database,
    `WITH expired AS (
       SELECT id FROM core.agent_pairing_requests WHERE expires_at <= $1
       ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
     ) DELETE FROM core.agent_pairing_requests WHERE id IN (SELECT id FROM expired)`,
    now,
  );
  return { auditRemoved, pairingsRemoved };
}
