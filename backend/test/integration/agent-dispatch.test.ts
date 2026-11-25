import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import focus from "../../src/apps/focus/index.js";
import tasks from "../../src/apps/tasks/index.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { Platform } from "../../src/core/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { buildFixturePlatform, createTestUser, loginCookie } from "../helpers/platform.js";

let db: Database;
let runtimeDb: Database;
let platform: Platform;
let cleanup: () => void;
let ownerId: string;
let cookie: string;
let now = new Date("2026-12-01T10:00:00Z");
let registrationBarrier: { entered(): void; release: Promise<void> } | undefined;
let rejectRegistration = false;
const focusEvents: unknown[] = [];

const fixture: BackendAppModule = {
  id: "agent_fixture",
  async registerApi(ctx) {
    ctx.api.get("/browser", async () => ({ ok: true }));
  },
  async registerEvents(ctx) {
    return [ctx.events.subscribe("focus.session.completed.v1", event => { focusEvents.push(event.payload); })];
  },
  async registerAgent(agent) {
    agent.tool({
      name: "agent_fixture_ping", description: "Fixture App catalog handshake.",
      action: "read", scopes: ["read"], inputSchema: { type: "object", additionalProperties: false },
      execute: async () => ({ data: { ok: true } }),
    });
    agent.resource({ uri: "pp://apps/agent_fixture/summary", name: "Fixture summary", read: async () => ({ ok: true }) });
    registrationBarrier?.entered();
    await registrationBarrier?.release;
    if (rejectRegistration) throw new Error("unfinished registration");
  },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createAgent(scopes: string[], allowedApps: string[]) {
  const response = await platform.app.inject({
    method: "POST", url: "/api/core/agents", headers: { cookie },
    payload: { name: "Dispatch fixture", scopes, allowedApps },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ agent: { id: string }; token: string }>();
}

function call(token: string, toolName: string, payload: Record<string, unknown> = {}) {
  return platform.app.inject({ method: "POST", url: `/api/agent/v1/tools/${toolName}`, headers: bearer(token), payload });
}

async function focusState(token: string) {
  const response = await call(token, "focus_state");
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data as { baseHash: string; active: { id: string; revision: number } | null };
}

describe("Agent transactional dispatch and lifecycle", () => {
  before(async () => {
    db = await resetDatabase();
    const repo = resolve(import.meta.dirname, "../../..");
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: ["focus", "tasks"].map(id => ({ scope: id, schema: id, dir: join(repo, "apps", id, "migrations") })),
    });
    const account = await createTestUser(db, "dispatch-owner");
    ownerId = account.id;
    runtimeDb = new Database(TEST_DATABASE_URL, undefined, { max: 4 });
    const runtime = await buildFixturePlatform({
      database: runtimeDb,
      manifests: [{ id: tasks.id }, { id: focus.id }, { id: fixture.id }],
      backendModules: { [tasks.id]: tasks, [focus.id]: focus, [fixture.id]: fixture },
      clock: () => new Date(now),
    });
    platform = runtime.platform;
    cleanup = runtime.cleanup;
    cookie = await loginCookie(platform, account.username, "test-password-dispatch-owner");
  });

  after(async () => {
    await platform?.stop();
    cleanup?.();
    await runtimeDb?.close();
    await db?.close();
  });

  it("reserves one concurrent write-only create and replays its ID after token rotation", async () => {
    const { agent, token } = await createAgent(["write"], ["tasks"]);
    const idempotencyKey = randomUUID();
    const args = { title: "Exactly one Task", idempotencyKey };
    const pair = await Promise.all([call(token, "tasks_create", args), call(token, "tasks_create", args)]);
    for (const result of pair) assert.equal(result.statusCode, 200, result.body);
    const id = pair[0]!.json().data.id;
    assert.deepEqual(pair.map(result => result.json().data), [{ id }, { id }]);
    assert.equal((await db.query("SELECT id FROM tasks.tasks WHERE user_id = $1 AND title = $2", [ownerId, args.title])).rowCount, 1);

    const forbidden = await call(token, "tasks_update", { id: "malformed" });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal((await call(token, "tasks_list")).statusCode, 403);

    const rotated = await platform.app.inject({
      method: "POST", url: `/api/core/agents/${agent.id}/rotate-token`, headers: { cookie },
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    assert.equal((await call(token, "tasks_create", args)).statusCode, 401);
    const newToken = rotated.json().token;
    const resumed = await call(newToken, "tasks_create", { ...args, status: "todo", priority: 1 });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.deepEqual(resumed.json().data, { id });
    const changed = await call(newToken, "tasks_create", { ...args, title: "Different input" });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json().error.code, "idempotency_conflict");
    assert.equal(changed.json().error.details, undefined);

    const history = (await db.query<{ status: string }>(
      "SELECT status FROM core.agent_audit_logs WHERE agent_id = $1 AND tool_name = 'tasks_create' ORDER BY status",
      [agent.id],
    )).rows.map(row => row.status);
    assert.deepEqual(history, ["error", "ok", "replayed", "replayed"]);
  });

  it("recovers a committed create receipt when the committing connection loses its acknowledgement", async () => {
    const { agent, token } = await createAgent(["write"], ["tasks"]);
    const args = { title: "Acknowledge once", idempotencyKey: randomUUID() };
    const withTransaction = runtimeDb.withTransaction.bind(runtimeDb);
    let lost = 0;
    runtimeDb.withTransaction = async fn => {
      let insertedReceipt = false;
      const result = await withTransaction(async tx => {
        const query = tx.query;
        tx.query = (async (sql: string, params?: unknown[]) => {
          const rows = await query(sql, params);
          if (sql.startsWith("INSERT INTO core.agent_create_receipts")) insertedReceipt = true;
          return rows;
        }) as typeof query;
        return fn(tx);
      });
      if (insertedReceipt) {
        lost++;
        throw new Error("fixture lost commit acknowledgement after a committed create");
      }
      return result;
    };
    let acknowledged;
    try {
      acknowledged = await call(token, "tasks_create", args);
    } finally {
      runtimeDb.withTransaction = withTransaction;
    }
    assert.equal(lost, 1);
    assert.equal(acknowledged.statusCode, 200, acknowledged.body);
    const expected = acknowledged.json().data;
    assert.deepEqual((await call(token, "tasks_create", args)).json().data, expected);
    assert.equal((await db.query("SELECT 1 FROM tasks.tasks WHERE id = $1 AND user_id = $2", [expected.id, ownerId])).rowCount, 1);
    const audit = await db.query("SELECT status FROM core.agent_audit_logs WHERE agent_id = $1 ORDER BY status", [agent.id]);
    assert.deepEqual(audit.rows, [{ status: "ok" }, { status: "replayed" }]);
  });

  it("requires a fresh hash with and without a WebDAV binding, and protects restored task IDs", async () => {
    const { agent, token } = await createAgent(["read", "write", "delete"], ["tasks"]);
    for (const linked of [false, true]) {
      if (linked) await db.query(`INSERT INTO core.sync_bindings
          (user_id, identity_id, replica_id, destination_endpoint, destination_username, pairing_verifier, phase)
        VALUES ($1, $2, $3, 'https://example.invalid', 'fence', 'verifier', 'linked')`,
      [ownerId, randomUUID(), randomUUID()]);
      try {
        const created = await call(token, "tasks_create", { title: "WebDAV fence", idempotencyKey: randomUUID() });
        assert.equal(created.statusCode, 200, created.body);
        const id = created.json().data.id as string;
        const before = await call(token, "tasks_get", { id });
        const baseHash = before.json().data.baseHash as string;
        assert.equal((await call(token, "tasks_complete", { id })).statusCode, 422);
        assert.equal((await call(token, "tasks_complete", { id, baseHash: "invalid" })).statusCode, 422);

        const edit = await platform.app.inject({
          method: "PATCH", url: `/api/apps/tasks/tasks/${id}`, headers: { cookie },
          payload: { title: "Browser edit", baseHash },
        });
        assert.equal(edit.statusCode, 200, edit.body);
        const stale = await call(token, "tasks_complete", { id, baseHash });
        assert.equal(stale.statusCode, 409, stale.body);
        const current = stale.json().error.details.current;
        assert.equal(current.title, "Browser edit");
        const completed = await call(token, "tasks_complete", { id, baseHash: current.baseHash });
        assert.equal(completed.statusCode, 200, completed.body);
        const freshHash = completed.json().data.baseHash;
        const deleted = await call(token, "tasks_delete", { id, baseHash: freshHash });
        assert.equal(deleted.statusCode, 200, deleted.body);
        const archived = (await db.query<{ id: string; deleted_by_agent_id: string }>(
          "SELECT id, deleted_by_agent_id FROM core.trash_items WHERE user_id = $1 AND entity_id = $2", [ownerId, id],
        )).rows[0]!;
        assert.equal(archived.deleted_by_agent_id, agent.id);
        const restore = await platform.app.inject({
          method: "POST", url: `/api/core/trash/${archived.id}/restore`, headers: { cookie },
        });
        assert.equal(restore.statusCode, 200, restore.body);
        const restored = restore.json().restoredId;
        assert.notEqual(restored, id);
        assert.equal((await call(token, "tasks_delete", { id, baseHash: freshHash })).statusCode, 404);
        assert.equal((await call(token, "tasks_get", { id: restored })).json().data.title, "Browser edit");
      } finally {
        if (linked) await db.query("DELETE FROM core.sync_bindings WHERE user_id = $1", [ownerId]);
      }
    }
  });

  it("keeps Focus reads pure at expiry and rolls back its replacement and event if audit fails", async () => {
    const { token } = await createAgent(["read", "write"], ["focus"]);
    const initial = await focusState(token);
    const first = await call(token, "focus_start", {
      kind: "focus", plannedDurationSeconds: 10, baseHash: initial.baseHash, idempotencyKey: randomUUID(),
    });
    assert.equal(first.statusCode, 200, first.body);
    const id = first.json().data.id as string;
    const running = await focusState(token);
    assert.equal(running.active?.id, id);

    const pause = await call(token, "focus_pause", { sessionId: id, baseHash: running.baseHash });
    assert.equal(pause.statusCode, 200, pause.body);
    const paused = pause.json().data;
    const stalePaused = await call(token, "focus_pause", { sessionId: id, baseHash: running.baseHash });
    assert.equal(stalePaused.statusCode, 409, stalePaused.body);
    assert.equal(stalePaused.json().error.details.current.baseHash, paused.baseHash);
    const resumed = await call(token, "focus_resume", { sessionId: id, baseHash: paused.baseHash });
    assert.equal(resumed.statusCode, 200, resumed.body);

    now = new Date(now.getTime() + 11_000);
    const expired = await focusState(token);
    assert.equal(expired.active, null);
    const stale = await call(token, "focus_stop", { sessionId: id, baseHash: resumed.json().data.baseHash });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.details.current.active, null);
    const storedStatus = async () => (await db.query<{ status: string }>("SELECT status FROM focus.sessions WHERE id = $1", [id])).rows[0]!.status;
    assert.equal(await storedStatus(), "running");
    assert.equal(focusEvents.length, 0);

    await db.query(`CREATE FUNCTION core.reject_fixture_agent_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tool_name = 'focus_start' AND NEW.status = 'ok' THEN
        RAISE EXCEPTION 'injected audit failure';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_fixture_agent_audit BEFORE INSERT ON core.agent_audit_logs
      FOR EACH ROW EXECUTE FUNCTION core.reject_fixture_agent_audit()`);
    const args = { kind: "short_break", baseHash: expired.baseHash, idempotencyKey: randomUUID() };
    try {
      const rejected = await call(token, "focus_start", args);
      assert.equal(rejected.statusCode, 500, rejected.body);
      assert.equal(await storedStatus(), "running");
      assert.equal((await db.query("SELECT 1 FROM focus.sessions WHERE user_id = $1", [ownerId])).rowCount, 1);
      assert.equal((await db.query("SELECT 1 FROM core.agent_create_receipts WHERE idempotency_key = $1", [args.idempotencyKey])).rowCount, 0);
      assert.equal(focusEvents.length, 0);
    } finally {
      await db.query("DROP TRIGGER reject_fixture_agent_audit ON core.agent_audit_logs; DROP FUNCTION core.reject_fixture_agent_audit()");
    }
    const succeeded = await call(token, "focus_start", args);
    assert.equal(succeeded.statusCode, 200, succeeded.body);
    assert.equal(await storedStatus(), "completed");
    await setImmediate();
    assert.equal(focusEvents.length, 1);
    assert.match(JSON.stringify(focusEvents[0]), new RegExp(id));
  });

  it("isolates Bearer credentials from existing Cookie routes and honors the disabled App guard", async () => {
    const { token } = await createAgent(["read"], ["tasks"]);
    const headers = bearer(token);
    const browserRoutes = [
      "/api/apps/tasks/tasks",
      "/api/core/apps",
      "/api/core/auth/me",
      "/api/core/data/sync",
      "/api/core/trash",
      "/api/core/agents",
    ];
    for (const url of browserRoutes) {
      const response = await platform.app.inject({ method: "GET", url, headers });
      assert.equal(response.statusCode, 401, url + " " + response.body);
    }
    const logout = await platform.app.inject({ method: "POST", url: "/api/core/auth/logout", headers });
    assert.equal(logout.statusCode, 204, logout.body);
    const browser = await platform.app.inject({ method: "GET", url: "/api/apps/tasks/tasks", headers: { cookie } });
    assert.equal(browser.statusCode, 200, browser.body);
    const manifest = "/api/agent/v1/manifest";
    assert.equal((await platform.app.inject({ method: "GET", url: manifest, headers })).statusCode, 200);
    assert.equal((await platform.app.inject({ method: "GET", url: manifest, headers: { cookie } })).statusCode, 401);
    await platform.setAppEnabled(tasks.id, false);
    try {
      for (const supplied of [headers, { cookie }]) {
        const disabled = await platform.app.inject({ method: "GET", url: "/api/apps/tasks/tasks", headers: supplied });
        assert.equal(disabled.statusCode, 404, disabled.body);
      }
    } finally {
      await platform.setAppEnabled(tasks.id, true);
    }
  });

  it("returns a retryable datastore result for a known rollback without leaving a create receipt", async () => {
    const { agent, token } = await createAgent(["write"], ["tasks"]);
    const args = { title: "Known rolled-back create", idempotencyKey: randomUUID() };
    await db.query(`CREATE FUNCTION core.interrupt_agent_create_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tool_name = 'tasks_create' AND NEW.status = 'ok' THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'private fixture diagnostic';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER interrupt_agent_create_audit BEFORE INSERT ON core.agent_audit_logs
      FOR EACH ROW EXECUTE FUNCTION core.interrupt_agent_create_audit()`);
    try {
      const interrupted = await call(token, "tasks_create", args);
      assert.equal(interrupted.statusCode, 503, interrupted.body);
      assert.equal(interrupted.json().error.code, "agent_datastore_busy");
      assert.doesNotMatch(interrupted.body, /private fixture diagnostic/);
      assert.equal((await db.query("SELECT 1 FROM tasks.tasks WHERE title = $1", [args.title])).rowCount, 0);
      assert.equal((await db.query("SELECT 1 FROM core.agent_create_receipts WHERE idempotency_key = $1", [args.idempotencyKey])).rowCount, 0);
      const audit = await db.query("SELECT status, error_code FROM core.agent_audit_logs WHERE agent_id = $1", [agent.id]);
      assert.deepEqual(audit.rows, [{ status: "error", error_code: "agent_datastore_busy" }]);
    } finally {
      await db.query("DROP TRIGGER interrupt_agent_create_audit ON core.agent_audit_logs; DROP FUNCTION core.interrupt_agent_create_audit()");
    }
    const retried = await call(token, "tasks_create", args);
    assert.equal(retried.statusCode, 200, retried.body);
  });

  it("bounds the separate failure audit even when schema validation stops the tool", async () => {
    const { token } = await createAgent(["write"], ["tasks"]);
    const withTransaction = runtimeDb.withTransaction.bind(runtimeDb);
    const auditLimits: unknown[] = [];
    runtimeDb.withTransaction = fn => withTransaction(async tx => {
      const query = tx.query;
      tx.query = (async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO core.agent_audit_logs")) {
          const settings = await query(`SELECT current_setting('statement_timeout') AS statement,
            current_setting('transaction_timeout') AS transaction`);
          auditLimits.push(...settings.rows);
        }
        return query(sql, params);
      }) as typeof query;
      return fn(tx);
    });
    try {
      const rejected = await call(token, "tasks_create", { title: "Missing create key" });
      assert.equal(rejected.statusCode, 422, rejected.body);
      assert.equal(rejected.json().error.code, "invalid_arguments");
      assert.deepEqual(auditLimits, [{ statement: "15s", transaction: "20s" }]);
    } finally {
      runtimeDb.withTransaction = withTransaction;
    }
  });

  it("keeps an admitted Task create within its transaction when the App is disabled", async () => {
    const { agent, token } = await createAgent(["write"], ["tasks"]);
    const args = { title: "Admitted before disable", idempotencyKey: randomUUID() };
    const { rows: [grant] } = await db.query<{ id: string }>(
      "SELECT id FROM core.agent_user_grants WHERE agent_id = $1 AND user_id = $2", [agent.id, ownerId],
    );
    assert.ok(grant);
    await db.query(`CREATE FUNCTION core.reject_disabled_app_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tool_name = 'tasks_create' AND NEW.status = 'ok' THEN
        RAISE EXCEPTION 'injected audit failure';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_disabled_app_audit BEFORE INSERT ON core.agent_audit_logs
      FOR EACH ROW EXECUTE FUNCTION core.reject_disabled_app_audit()`);
    const locked = deferred();
    const release = deferred();
    const hold = db.withTransaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify(["agent-create", grant.id, "tasks_create", args.idempotencyKey]),
      ]);
      locked.resolve();
      await release.promise;
    });
    let pending: ReturnType<typeof call> | undefined;
    try {
      await Promise.race([locked.promise, hold]);
      pending = call(token, "tasks_create", args);
      const deadline = Date.now() + 4_000;
      for (;;) {
        const [lock] = (await db.query<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND wait_event = 'advisory'
            AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'
        ) AS waiting`)).rows;
        if (lock?.waiting) break;
        assert.ok(Date.now() < deadline, "Agent create should reach the receipt lock after admission");
        await delay(10);
      }
      await platform.setAppEnabled(tasks.id, false);
      assert.equal((await call(token, "tasks_create", args)).statusCode, 404);
      release.resolve();
      const rejected = await pending;
      assert.equal(rejected.statusCode, 500, rejected.body);
      assert.equal((await db.query("SELECT id FROM tasks.tasks WHERE user_id = $1 AND title = $2", [ownerId, args.title])).rowCount, 0);
      assert.equal((await db.query("SELECT 1 FROM core.agent_create_receipts WHERE idempotency_key = $1", [args.idempotencyKey])).rowCount, 0);
      const audit = await db.query("SELECT status FROM core.agent_audit_logs WHERE agent_id = $1", [agent.id]);
      assert.deepEqual(audit.rows, [{ status: "error" }]);
    } finally {
      release.resolve();
      await Promise.allSettled([hold, pending]);
      await db.query("DROP TRIGGER reject_disabled_app_audit ON core.agent_audit_logs; DROP FUNCTION core.reject_disabled_app_audit()");
      await platform.setAppEnabled(tasks.id, true);
    }
  });

  it("discards incomplete registrations and disables cached tools during an activation race", async () => {
    const { token } = await createAgent(["read"], [fixture.id]);
    const discovery = () => platform.app.inject({ method: "GET", url: "/api/agent/v1/manifest", headers: bearer(token) });
    const manifest = async () => {
      const result = await discovery();
      assert.equal(result.statusCode, 200, result.body);
      return result.json<{ apps: { id: string }[]; tools: { name: string }[]; resources: { uri: string }[] }>();
    };
    const canFind = async () => (await manifest()).tools.some(tool => tool.name === "agent_fixture_ping");
    assert.equal(await canFind(), true);
    await platform.setAppEnabled(fixture.id, false);
    assert.equal(await canFind(), false);
    assert.equal((await call(token, "agent_fixture_ping")).statusCode, 404);

    const entered = deferred();
    const release = deferred();
    registrationBarrier = { entered: entered.resolve, release: release.promise };
    const activate = platform.setAppEnabled(fixture.id, true);
    await entered.promise;
    const disable = platform.setAppEnabled(fixture.id, false);
    try {
      assert.equal(await canFind(), false);
      assert.equal((await call(token, "agent_fixture_ping")).statusCode, 404);
    } finally {
      release.resolve();
      await Promise.all([activate, disable]);
      registrationBarrier = undefined;
    }
    assert.equal(await canFind(), false);

    rejectRegistration = true;
    try {
      await platform.setAppEnabled(fixture.id, true);
      assert.equal(await canFind(), false);
      const hidden = await manifest();
      assert.equal(hidden.apps.some(app => app.id === fixture.id), false);
      assert.equal(hidden.resources.some(resource => resource.uri.startsWith("pp://apps/" + fixture.id)), false);
      const browser = await platform.app.inject({ method: "GET", url: "/api/apps/agent_fixture/browser", headers: { cookie } });
      assert.equal(browser.statusCode, 200, browser.body);
    } finally {
      rejectRegistration = false;
    }
    await platform.setAppEnabled(fixture.id, false);
    await platform.setAppEnabled(fixture.id, true);
    assert.equal(await canFind(), true);
    assert.equal((await call(token, "agent_fixture_ping")).statusCode, 200);
  });
});
