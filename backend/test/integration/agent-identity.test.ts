import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import cookiePlugin from "@fastify/cookie";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { insertAgentAudit, purgeAgentActivity } from "../../src/core/agent/audit.js";
import { AgentIdentityService, type AgentView, type AgentGrantView } from "../../src/core/agent/identity.js";
import { registerAgentManagement } from "../../src/core/agent/management-routes.js";
import { createRequireAuth } from "../../src/core/auth/guard.js";
import { registerAuthRoutes } from "../../src/core/auth/routes.js";
import type { Database } from "../../src/core/database/index.js";
import { createTimeService } from "../../src/core/time/index.js";
import { resetDatabase } from "../helpers/db.js";
import { createTestUser } from "../helpers/platform.js";

const BASE = "/api/core/agents";
const perms = { scopes: ["read", "write", "delete"], allowedApps: ["tasks", "assets"] } as const;
const caller = { owner: "agent-owner", other: "agent-other", third: "agent-third" } as const;
const password = "agent-test-password-1";
let db: Database;
let app: FastifyInstance;
let identity: AgentIdentityService;
let clock = new Date("2026-11-25T10:00:00Z");
const cookies = {} as Record<keyof typeof caller, string>;
const userIds = {} as Record<keyof typeof caller, string>;
const time = createTimeService({ defaultTimezone: "UTC", clock: () => clock });

function advance(ms = 1_000): void {
  clock = new Date(clock.getTime() + ms);
}

function call(member: keyof typeof caller, method: InjectOptions["method"], url: string, payload?: InjectOptions["payload"]) {
  return app.inject({ method, url, headers: { cookie: cookies[member] }, payload });
}

async function create(input: Record<string, unknown> = {}) {
  const outcome = await call("owner", "POST", BASE, { name: "Test Agent", ...perms, ...input });
  assert.equal(outcome.statusCode, 201, outcome.body);
  assert.equal(outcome.headers["cache-control"], "private, no-store");
  return outcome.json<{ agent: AgentView; grant: AgentGrantView; token: string }>();
}

async function issue(agent: AgentView) {
  const response = await call("owner", "POST", `${BASE}/${agent.id}/pairing-codes`, perms);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  return response.json<{ code: string; expiresAt: string }>().code;
}

function approve(member: keyof typeof caller, code: string, changes: Record<string, unknown> = {}) {
  return call(member, "POST", `${BASE}/pairings/approve`, { code, ...perms, ...changes });
}

async function authorize(token: string, selector?: string) {
  const credential = await identity.recognizeToken(token);
  return db.withTransaction((tx) => identity.authorize(tx, credential, selector));
}

async function untilLockWaits(): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const locks = await db.query(`
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM core.agents%FOR UPDATE%'`);
    if (locks.rowCount) return;
    assert.ok(Date.now() < deadline, "Agent management must wait for the admitted transaction");
    await delay(10);
  }
}

describe("Agent identity and management", () => {
  before(async () => {
    db = await resetDatabase();
    identity = new AgentIdentityService({ database: db, time, installedApps: () => ["tasks", "assets"] });
    app = Fastify();
    await app.register(cookiePlugin);
    registerAuthRoutes(app, { database: db, sessionCookieSecure: false, now: () => clock });
    registerAgentManagement(app, identity, createRequireAuth({ database: db, now: () => clock }));
    for (const member of Object.keys(caller) as (keyof typeof caller)[]) {
      userIds[member] = (await createTestUser(db, caller[member], password)).id;
      const login = await app.inject({ method: "POST", url: "/api/core/auth/login", payload: { username: caller[member], password } });
      assert.equal(login.statusCode, 200, login.body);
      const header = login.headers["set-cookie"];
      const first = Array.isArray(header) ? header[0] : header;
      if (!first) throw new Error("Login returned no Cookie");
      cookies[member] = first.split(";")[0]!;
    }
  });

  after(async () => {
    await app?.close();
    await db?.close();
  });

  it("hashes the credential, makes management Cookie-only and rejects rotation by another user", async () => {
    const entry = await create();
    assert.equal(entry.token.length, 43);
    assert.equal(entry.agent.tokenPrefix, entry.token.slice(0, 8));
    assert.equal((await db.query("SELECT token_hash FROM core.agents WHERE id = $1", [entry.agent.id])).rows[0]?.token_hash,
      createHash("sha256").update(entry.token).digest("hex"));
    assert.equal((await authorize(entry.token)).userId, userIds.owner);
    const forbidden = await call("other", "POST", `${BASE}/${entry.agent.id}/rotate-token`);
    assert.equal(forbidden.statusCode, 404);
    const foreign = await app.inject({ method: "GET", url: BASE, headers: { authorization: `Bearer ${entry.token}` } });
    assert.equal(foreign.statusCode, 401);
    const list = await call("owner", "GET", BASE);
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.includes(entry.token));
    const stale = await identity.recognizeToken(entry.token);
    const rotated = await call("owner", "POST", `${BASE}/${entry.agent.id}/rotate-token`);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const newToken = rotated.json<{ token: string }>().token;
    assert.notEqual(newToken, entry.token);
    await assert.rejects(identity.recognizeToken(entry.token), { code: "unauthorized" });
    await assert.rejects(db.withTransaction((tx) => identity.authorize(tx, stale)), { code: "unauthorized" });
    assert.equal((await authorize(newToken)).grantId, entry.grant.id);
    await identity.recordUse(await identity.recognizeToken(newToken));
    assert.ok((await call("owner", "GET", BASE)).json<{ owned: AgentView[] }>().owned.find((agent) => agent.id === entry.agent.id)?.lastUsedAt);
  });

  it("previews without granting, admits one competing recipient and makes actor selection sticky", async () => {
    const entry = await create();
    const code = await issue(entry.agent);
    const preview = await call("other", "POST", `${BASE}/pairings/preview`, { code });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().agentId, entry.agent.id);
    await assert.rejects(authorize(entry.token, caller.other), { code: "forbidden" });
    const approvals = await Promise.all([approve("other", code), approve("third", code)]);
    assert.deepEqual(approvals.map((response) => response.statusCode).sort(), [200, 409]);
    const winner = approvals[0]!.statusCode === 200 ? "other" : "third";
    const grant = approvals.find((response) => response.statusCode === 200)!.json<{ grant: AgentGrantView }>().grant;
    await assert.rejects(authorize(entry.token), { code: "acting_user_required", details: { actingUsers: [caller[winner], caller.owner].sort() } });
    assert.equal((await authorize(entry.token, caller[winner])).grantId, grant.id);
    assert.equal((await call("owner", "DELETE", `${BASE}/grants/${grant.id}`)).statusCode, 404);

    assert.equal((await call("owner", "DELETE", `${BASE}/grants/${entry.grant.id}`)).statusCode, 204);
    await assert.rejects(authorize(entry.token, caller.owner), { code: "forbidden" });
    await assert.rejects(authorize(entry.token), { code: "acting_user_required", details: { actingUsers: [caller[winner]] } });
    const rotated = await call("owner", "POST", `${BASE}/${entry.agent.id}/rotate-token`);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const newToken = rotated.json<{ token: string }>().token;
    await assert.rejects(authorize(newToken), { code: "acting_user_required" });
    assert.equal((await call(winner, "DELETE", `${BASE}/grants/${grant.id}`)).statusCode, 204);
    await assert.rejects(authorize(newToken), { code: "no_active_grant" });
  });

  it("enforces grant subsets and rejects a code issued before expiry or revocation", async () => {
    const entry = await create();
    const code = await issue(entry.agent);
    const expiresAt = new Date(clock.getTime() + 2_000).toISOString();
    const paired = await approve("other", code, { scopes: ["read"], allowedApps: ["tasks"], expiresAt });
    assert.equal(paired.statusCode, 200, paired.body);
    const grant = paired.json<{ grant: AgentGrantView }>().grant;
    const expansion = await call("other", "PATCH", `${BASE}/grants/${grant.id}`, { scopes: ["read", "write"] });
    assert.equal(expansion.statusCode, 409);
    assert.equal(expansion.json().error.code, "grant_expansion");
    const stale = await issue(entry.agent);
    const redundant = await approve("other", stale);
    assert.equal(redundant.json().error.code, "grant_already_active");
    advance(3_000);
    await assert.rejects(authorize(entry.token, caller.other), { code: "forbidden" });
    assert.equal((await approve("other", stale)).json().error.code, "pairing_unavailable");
    const fresh = await issue(entry.agent);
    assert.equal((await approve("other", fresh)).statusCode, 200);
    const issuedEarly = await issue(entry.agent);
    advance();
    assert.equal((await call("other", "DELETE", `${BASE}/grants/${grant.id}`)).statusCode, 204);
    assert.equal((await approve("other", issuedEarly)).json().error.code, "pairing_unavailable");
    advance();
    const afterRevoke = await issue(entry.agent);
    const resumed = await approve("other", afterRevoke);
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json<{ grant: AgentGrantView }>().grant.id, grant.id);
  });

  it("rolls back code consumption and invalidates an outstanding code on global revocation", async () => {
    const entry = await create();
    const code = await issue(entry.agent);
    await db.query(`CREATE FUNCTION core.fail_test_agent_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test grant insertion failure'; END $$`);
    await db.query(`CREATE TRIGGER fail_test_agent_grant BEFORE INSERT ON core.agent_user_grants
      FOR EACH ROW EXECUTE FUNCTION core.fail_test_agent_grant()`);
    try {
      assert.equal((await approve("other", code)).statusCode, 500);
      const stored = await db.query("SELECT consumed_at FROM core.agent_pairing_requests WHERE code_hash = $1",
        [createHash("sha256").update(code).digest("hex")]);
      assert.deepEqual(stored.rows, [{ consumed_at: null }]);
    } finally {
      await db.query("DROP TRIGGER fail_test_agent_grant ON core.agent_user_grants");
      await db.query("DROP FUNCTION core.fail_test_agent_grant()");
    }
    assert.equal((await approve("other", code)).statusCode, 200);
    const unused = await issue(entry.agent);
    assert.equal((await call("owner", "DELETE", `${BASE}/${entry.agent.id}`)).statusCode, 204);
    await assert.rejects(identity.recognizeToken(entry.token), { code: "unauthorized" });
    assert.equal((await approve("third", unused)).json().error.code, "pairing_unavailable");
  });

  it("holds token rotation and the first secondary approval behind an admitted operation", async () => {
    const entry = await create();
    const code = await issue(entry.agent);
    const credential = await identity.recognizeToken(entry.token);
    for (const change of ["rotate", "pair"] as const) {
      const current = change === "rotate" ? credential : await identity.recognizeToken(
        (await call("owner", "POST", `${BASE}/${entry.agent.id}/rotate-token`)).json<{ token: string }>().token,
      );
      let started!: () => void;
      let release!: () => void;
      const locked = new Promise<void>((resolve) => { started = resolve; });
      const allowed = new Promise<void>((resolve) => { release = resolve; });
      const admitted = db.withTransaction(async (tx) => {
        const who = await identity.authorize(tx, current);
        started();
        await allowed;
        return who;
      });
      let pending: ReturnType<typeof call> | undefined;
      try {
        await Promise.race([locked, admitted]);
        pending = change === "rotate"
          ? call("owner", "POST", `${BASE}/${entry.agent.id}/rotate-token`)
          : approve("other", code);
        await untilLockWaits();
        release();
        assert.equal((await admitted).userId, userIds.owner);
        const response = await pending;
        assert.equal(response.statusCode, 200, response.body);
        const error = change === "rotate" ? "unauthorized" : "acting_user_required";
        await assert.rejects(db.withTransaction((tx) => identity.authorize(tx, current)), { code: error });
      } finally {
        release();
        await Promise.allSettled([admitted, pending]);
      }
    }
  });

  it("paginates activity safely at equal timestamps and retains create receipts during cleanup", async () => {
    const entry = await create();
    const actor = await authorize(entry.token);
    const old = new Date(clock.getTime() - 91 * 86_400_000);
    await db.withTransaction(async (tx) => {
      for (const createdAt of [old, clock, clock, clock]) {
        await insertAgentAudit(tx, actor, { appId: "tasks", toolName: "tasks_create", actionKind: "write", status: "ok", createdAt });
      }
      await tx.query(`INSERT INTO core.agent_create_receipts (grant_id, tool_name, idempotency_key, fingerprint, entity_id, created_at)
        VALUES ($1, 'tasks_create', $2, $3, $4, $5)`, [actor.grantId, randomUUID(), "a".repeat(64), randomUUID(), old]);
    });
    assert.equal((await purgeAgentActivity(db, clock, 90)).auditRemoved, 1);
    const first = (await call("owner", "GET", `${BASE}/audit?limit=2`)).json<{ items: { id: string }[]; nextCursor: string }>();
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const last = (await call("owner", "GET", `${BASE}/audit?limit=2&cursor=${first.nextCursor}`)).json<{ items: { id: string }[]; nextCursor: string | null }>();
    assert.equal(last.items.length, 1);
    assert.equal(last.nextCursor, null);
    assert.equal(new Set([...first.items, ...last.items].map((item) => item.id)).size, 3);
    assert.deepEqual((await call("other", "GET", `${BASE}/audit`)).json().items, []);
    assert.equal((await db.query("SELECT idempotency_key FROM core.agent_create_receipts WHERE grant_id = $1", [actor.grantId])).rowCount, 1);
    await db.query("DELETE FROM core.agents WHERE id = $1", [entry.agent.id]);
    const retained = (await call("owner", "GET", `${BASE}/audit`)).json<{ items: { agentId: string | null; agentName: string }[] }>();
    assert.ok(retained.items.every((log) => log.agentId === null && log.agentName === entry.agent.name));
    assert.equal((await db.query("SELECT idempotency_key FROM core.agent_create_receipts WHERE grant_id = $1", [actor.grantId])).rowCount, 0);
  });

  it("drains multiple batches of expired activity and preserves the audit cutoff", async () => {
    const entry = await create();
    const actor = await authorize(entry.token);
    const count = 1_001;
    const cutoff = new Date(clock.getTime() - 90 * 86_400_000);
    const older = new Date(cutoff.getTime() - 1);
    const future = new Date(clock.getTime() + 1);
    const prefix = randomUUID();
    await db.withTransaction(async (tx) => {
      await tx.query(`
        INSERT INTO core.agent_audit_logs (id, agent_id, agent_name, user_id, app_id, tool_name, action_kind, status, created_at)
        SELECT gen_random_uuid(), $1, $2, $3, 'tasks', 'tasks_create', 'write', 'ok', $4
        FROM generate_series(1, $5::int)`, [actor.agentId, actor.agentName, actor.userId, older, count]);
      for (const createdAt of [cutoff, clock]) {
        await insertAgentAudit(tx, actor, { appId: "tasks", toolName: "tasks_create", actionKind: "write", status: "ok", createdAt });
      }
      await tx.query(`
        INSERT INTO core.agent_pairing_requests (id, agent_id, code_hash, requested_scopes, requested_apps,
          created_by_user_id, expires_at, created_at)
        SELECT gen_random_uuid(), $1, md5($2 || n::text) || md5(n::text || $2), ARRAY['read'], ARRAY['tasks'],
          $3, CASE WHEN n <= $6 THEN $4::timestamptz ELSE $5::timestamptz END, $4::timestamptz - interval '15 minutes'
        FROM generate_series(1, $6::int + 1) AS numbers(n)`, [actor.agentId, prefix, actor.userId, clock, future, count]);
    });

    assert.deepEqual(await purgeAgentActivity(db, clock, 90), { auditRemoved: count, pairingsRemoved: count });
    const audit = await db.query(
      "SELECT created_at FROM core.agent_audit_logs WHERE agent_id = $1 ORDER BY created_at", [actor.agentId],
    );
    assert.deepEqual(audit.rows, [{ created_at: cutoff }, { created_at: clock }]);
    const pairings = await db.query("SELECT expires_at FROM core.agent_pairing_requests WHERE agent_id = $1", [actor.agentId]);
    assert.deepEqual(pairings.rows, [{ expires_at: future }]);
    assert.deepEqual(await purgeAgentActivity(db, clock, 90), { auditRemoved: 0, pairingsRemoved: 0 });
  });
});
