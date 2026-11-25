import { runTransactionOn, type Database, type DatabaseContext } from "../database/index.js";

// One lock covers own and all-account snapshots, including their old metadata
// views. This bigint advisory namespace is separate from App owner-set locks.
const ATTACHMENT_GUARD_KEY = "588086002422194704";
const attachmentLocks = {
  shared: ["pg_advisory_lock_shared", "pg_advisory_unlock_shared"],
  exclusive: ["pg_advisory_lock", "pg_advisory_unlock"],
} as const;

/**
 * The metadata transaction starts after acquiring the session lock, so a
 * repeatable-read snapshot can never predate an already-finished retirement.
 * The callback uses this connection for all queries and may finish file I/O
 * before returning. Acquire this guard before taking App or sync locks.
 */
export async function withAttachmentGuard<T>(
  database: Pick<Database, "getClient">,
  mode: keyof typeof attachmentLocks,
  run: (tx: DatabaseContext) => Promise<T>,
): Promise<T> {
  const client = await database.getClient();
  const [lock, unlock] = attachmentLocks[mode];
  let discard = true;
  try {
    await client.query(`SELECT ${lock}($1::bigint)`, [ATTACHMENT_GUARD_KEY]);
    try {
      return await runTransactionOn(client, run);
    } finally {
      // A connection that might still hold a session lock must leave the pool.
      const result = await client.query<{ released: boolean }>(
        `SELECT ${unlock}($1::bigint) AS released`, [ATTACHMENT_GUARD_KEY],
      ).catch(() => undefined);
      discard = result?.rows[0]?.released !== true;
    }
  } finally {
    client.release(discard);
  }
}
