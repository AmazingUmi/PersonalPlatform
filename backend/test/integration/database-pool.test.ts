import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { TEST_DATABASE_URL } from "../helpers/db.js";

describe("shared database pool capacity and transaction semantics", () => {
  for (const max of [undefined, 1, 4, 10]) {
    it(`queues work at capacity ${max ?? "default 10"} and reuses a released connection`, { timeout: 15_000 }, async () => {
      const capacity = max ?? 10;
      const db = new Database(TEST_DATABASE_URL, undefined, max === undefined ? undefined : { max });
      const held: PoolClient[] = [];
      try {
        for (let index = 0; index < capacity; index++) held.push(await db.getClient());
        const pids = await Promise.all(held.map(async (client) => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
        assert.equal(new Set(pids).size, capacity);
        // All connections remain checked out when this work enters the queue.
        // Reusing one released PID proves the configured cap without a sleep.
        const queued = db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const released = held.pop()!;
        const releasedPid = pids.pop()!;
        released.release();
        assert.equal((await queued).rows[0]!.pid, releasedPid);
      } finally {
        for (const client of held) client.release();
        await db.close();
      }
    });
  }

  it("rolls back failures, releases a one-connection pool and completes subsequent concurrent work", { timeout: 15_000 }, async () => {
    const db = new Database(TEST_DATABASE_URL, undefined, { max: 1 });
    try {
      await db.query("CREATE TEMP TABLE pool_rollback_probe (id integer PRIMARY KEY)");
      await assert.rejects(db.context().withTransaction(async (tx) => {
        await tx.query("INSERT INTO pool_rollback_probe VALUES (1)");
        await tx.query("INSERT INTO pool_rollback_probe VALUES (1)");
      }), /duplicate key/);
      assert.equal((await db.query("SELECT * FROM pool_rollback_probe")).rowCount, 0);
      await db.context().withTransaction(async (tx) => {
        await tx.query("INSERT INTO pool_rollback_probe VALUES (2)");
        await tx.withTransaction(async (nested) => {
          await nested.query("INSERT INTO pool_rollback_probe VALUES (3)");
        });
      });
      const results = await Promise.all(Array.from({ length: 8 }, () => db.query<{ count: number; pid: number }>(
        "SELECT count(*)::integer AS count, pg_backend_pid() AS pid FROM pool_rollback_probe",
      )));
      assert.ok(results.every((result) => result.rows[0]!.count === 2));
      assert.equal(new Set(results.map((result) => result.rows[0]!.pid)).size, 1);
    } finally {
      await db.close();
    }
  });
});
