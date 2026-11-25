import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { InjectOptions } from "fastify";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Platform } from "../../src/core/platform.js";
import { Database, type DatabaseContext } from "../../src/core/database/index.js";
import { registerTestSchemas, resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { buildFixturePlatform, createTestUser, loginCookie } from "../helpers/platform.js";

const appId = "agent_races";
const toolName = "agent_races_create";
const uri = "pp://apps/agent_races/summary";
const managementPath = "/api/core/agents";
const users = { owner: "races-owner", recipient: "races-recipient", expiryOwner: "races-expiry-owner" } as const;
const permissions = { scopes: ["read", "write"], allowedApps: [appId] };

type User = keyof typeof users;
type Change = "narrow" | "revoke" | "rotate";
type Operation = "resource" | "mutation" | "replay";
interface Enrollment {
  agentId: string;
  token: string;
  recipientGrantId: string;
}

let db: Database;
let runtimeDb: Database;
let platform: Platform;
let cleanup: () => void;
let now = new Date("2026-11-25T10:00:00Z");
const cookies = {} as Record<User, string>;
const userIds = {} as Record<User, string>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}

function barrier() {
  return { entered: deferred(), release: deferred() };
}

let resourceBarrier: ReturnType<typeof barrier> | undefined;
let mutationBarrier: ReturnType<typeof barrier> | undefined;
let resourceReads = 0;

const fixture: BackendAppModule = {
  id: appId,
  async registerApi() {},
  async registerAgent(agent) {
    agent.resource({
      name: "Private summary", uri,
      async read(ctx) {
        resourceReads++;
        const active = resourceBarrier;
        active?.entered.resolve();
        await active?.release.promise;
        return { owner: ctx.userId, summary: "Already authorized resource" };
      },
    });
    agent.tool({
      name: toolName, description: "Create a race fixture for the acting user.",
      action: "write", scopes: ["write"], create: true,
      inputSchema: {
        type: "object", additionalProperties: false, required: ["label"],
        properties: { label: { type: "string", minLength: 1, maxLength: 100 } },
      },
      async execute(ctx, args) {
        const id = randomUUID();
        await ctx.database.query("INSERT INTO agent_races.items (id, user_id, label) VALUES ($1,$2,$3)", [id, ctx.userId, args.label]);
        const active = mutationBarrier;
        active?.entered.resolve();
        await active?.release.promise;
        return { data: { id }, resourceId: id };
      },
    });
  },
};

function manage(user: User, method: InjectOptions["method"], path = "", payload?: InjectOptions["payload"]) {
  return platform.app.inject({ method, url: managementPath + path, payload, headers: { cookie: cookies[user] } });
}

async function createAgent(owner: User = "owner") {
  const response = await manage(owner, "POST", "", { name: "Race fixture", ...permissions });
  assert.equal(response.statusCode, 201, response.body);
  const { agent, token } = response.json<{ agent: { id: string }; token: string }>();
  return { agentId: agent.id, token };
}

async function newCode(agentId: string, owner: User = "owner"): Promise<string> {
  const response = await manage(owner, "POST", `/${agentId}/pairing-codes`, permissions);
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ code: string }>().code;
}

function approve(code: string, expiresAt?: string) {
  return manage("recipient", "POST", "/pairings/approve", { ...permissions, code, expiresAt });
}

async function enroll(owner?: User, expiresAt?: string): Promise<Enrollment> {
  const agent = await createAgent(owner);
  const paired = await approve(await newCode(agent.agentId, owner), expiresAt);
  assert.equal(paired.statusCode, 200, paired.body);
  return { ...agent, recipientGrantId: paired.json<{ grant: { id: string } }>().grant.id };
}

function bearer(token: string, user?: User) {
  return {
    authorization: `Bearer ${token}`,
    ...(user ? { "x-pp-acting-user": users[user] } : {}),
  };
}

function read(token: string, user?: User) {
  return platform.app.inject({
    url: "/api/agent/v1/resources?uri=" + encodeURIComponent(uri), headers: bearer(token, user),
  });
}

function create(token: string, payload: { label: string; idempotencyKey: string }) {
  return platform.app.inject({
    method: "POST", url: "/api/agent/v1/tools/" + toolName, headers: bearer(token, "recipient"), payload,
  });
}

function changeEnrollment(member: Enrollment, change: Change) {
  if (change === "rotate") return manage("owner", "POST", `/${member.agentId}/rotate-token`);
  if (change === "revoke") return manage("recipient", "DELETE", `/grants/${member.recipientGrantId}`);
  return manage("recipient", "PATCH", `/grants/${member.recipientGrantId}`, { allowedApps: [] });
}

function waitForChange(change: Change) {
  return waitForLock(change === "rotate" ? "%FROM core.agents%FOR UPDATE%" : "%FROM core.agent_user_grants%FOR UPDATE%");
}

async function waitForLock(queryPattern: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const { rowCount } = await db.query(`
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE $1`, [queryPattern]);
    if (rowCount) return;
    assert.ok(Date.now() < deadline, "Expected a real lock wait for " + queryPattern);
    await delay(10);
  }
}

function holdDatabaseLock(lock: (tx: DatabaseContext) => Promise<unknown>) {
  const paused = barrier();
  const settled = db.withTransaction(async (tx) => {
    await lock(tx);
    paused.entered.resolve();
    await paused.release.promise;
  });
  return { ...paused, settled };
}

function holdAdvisory(key: string) {
  return holdDatabaseLock(tx => tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]));
}

registerTestSchemas(appId);

describe("Agent gateway authorization races", () => {
  before(async () => {
    db = await resetDatabase();
    await db.query(`
      CREATE SCHEMA agent_races;
      CREATE TABLE agent_races.items (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
        label text NOT NULL
      )`);
    for (const user of ["owner", "recipient", "expiryOwner"] as const) {
      userIds[user] = (await createTestUser(db, users[user])).id;
    }
    runtimeDb = new Database(TEST_DATABASE_URL, undefined, { max: 5 });
    const runtime = await buildFixturePlatform({
      database: runtimeDb,
      manifests: [{ id: appId }],
      backendModules: { [appId]: fixture },
      clock: () => new Date(now),
    });
    platform = runtime.platform;
    cleanup = runtime.cleanup;
    for (const user of ["owner", "recipient", "expiryOwner"] as const) {
      cookies[user] = await loginCookie(platform, users[user], `test-password-${users[user]}`);
    }
  });

  after(async () => {
    await platform?.stop();
    cleanup?.();
    await runtimeDb?.close();
    await db?.close();
  });

  for (const operation of ["resource", "mutation", "replay"] as const satisfies readonly Operation[]) {
    for (const change of ["narrow", "revoke", "rotate"] as const satisfies readonly Change[]) {
      it(`lets an admitted ${operation} finish before ${change} wins over new requests`, async () => {
        const member = await enroll();
        const input = { label: `${operation} ${change} ${randomUUID()}`, idempotencyKey: randomUUID() };
        let originalId: string | undefined;
        if (operation === "replay") {
          const original = await create(member.token, input);
          assert.equal(original.statusCode, 200, original.body);
          originalId = original.json<{ data: { id: string } }>().data.id;
        }
        const paused = barrier();
        const receiptLock = operation === "replay"
          ? holdAdvisory(JSON.stringify(["agent-create", member.recipientGrantId, toolName, input.idempotencyKey]))
          : undefined;
        if (receiptLock) await Promise.race([receiptLock.entered.promise, receiptLock.settled]);
        if (operation === "resource") resourceBarrier = paused;
        if (operation === "mutation") mutationBarrier = paused;
        const run = () => operation === "resource" ? read(member.token, "recipient") : create(member.token, input);
        const admitted = run();
        let changing: ReturnType<typeof manage> | undefined;
        try {
          if (receiptLock) {
            await waitForLock("%pg_advisory_xact_lock(hashtextextended%");
          } else {
            await Promise.race([
              paused.entered.promise,
              admitted.then(response => assert.fail("Request finished before it hit the barrier: " + response.body)),
            ]);
          }
          changing = changeEnrollment(member, change);
          await waitForChange(change);

          paused.release.resolve();
          receiptLock?.release.resolve();
          const changeResult = await changing;
          assert.equal(changeResult.statusCode, change === "revoke" ? 204 : 200, changeResult.body);
          const stale = await run();
          assert.equal(stale.statusCode, change === "rotate" ? 401 : 403, stale.body);
          const previous = await admitted;
          assert.equal(previous.statusCode, 200, previous.body);
          if (operation === "resource") {
            assert.deepEqual(JSON.parse(previous.json().text), { owner: userIds.recipient, summary: "Already authorized resource" });
          } else {
            const id = previous.json<{ data: { id: string } }>().data.id;
            if (originalId) assert.equal(id, originalId);
            const records = await db.query("SELECT id FROM agent_races.items WHERE user_id=$1 AND label=$2", [userIds.recipient, input.label]);
            assert.deepEqual(records.rows, [{ id }]);
            const audit = await db.query<{ status: string }>(
              "SELECT status FROM core.agent_audit_logs WHERE agent_id=$1 AND user_id=$2 AND resource_id=$3 ORDER BY status",
              [member.agentId, userIds.recipient, id],
            );
            assert.deepEqual(audit.rows.map(row => row.status), operation === "replay" ? ["ok", "replayed"] : ["ok"]);
          }
          const surviving = change === "rotate"
            ? await read(changeResult.json<{ token: string }>().token, "recipient")
            : await read(member.token, "owner");
          assert.equal(surviving.statusCode, 200, surviving.body);
          assert.equal(JSON.parse(surviving.json().text).owner, userIds[change === "rotate" ? "recipient" : "owner"]);
        } finally {
          resourceBarrier = undefined;
          mutationBarrier = undefined;
          paused.release.resolve();
          receiptLock?.release.resolve();
          await Promise.allSettled([admitted, changing, receiptLock?.settled]);
        }
      });
    }
  }

  it("requires the actor when the first pairing commits before a waiting admission", async () => {
    const member = await createAgent();
    const initial = await read(member.token);
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(JSON.parse(initial.json().text).owner, userIds.owner);
    const code = await newCode(member.agentId);
    const lockKey = "pp_agent_first_pairing_race";
    await db.query(`
      CREATE FUNCTION core.agent_test_wait_for_first_pairing() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('pp_agent_first_pairing_race', 0));
        RETURN NEW;
      END $$;
      CREATE TRIGGER agent_test_wait_for_first_pairing BEFORE INSERT ON core.agent_user_grants
      FOR EACH ROW EXECUTE FUNCTION core.agent_test_wait_for_first_pairing()`);
    const paused = holdAdvisory(lockKey);
    let approval: ReturnType<typeof approve> | undefined;
    let admitted: ReturnType<typeof read> | undefined;
    try {
      await Promise.race([paused.entered.promise, paused.settled]);
      approval = approve(code);
      await waitForLock("%INSERT INTO core.agent_user_grants%");
      const readsBefore = resourceReads;
      admitted = read(member.token);
      await waitForLock("%FROM core.agents%FOR SHARE%");
      paused.release.resolve();

      const granted = await approval;
      assert.equal(granted.statusCode, 200, granted.body);
      const rejected = await admitted;
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.equal(rejected.json().error.code, "acting_user_required");
      assert.deepEqual(rejected.json().error.details.actingUsers, [users.owner, users.recipient]);
      assert.equal(resourceReads, readsBefore);
      const scoped = await read(member.token, "recipient");
      assert.equal(scoped.statusCode, 200, scoped.body);
      assert.equal(JSON.parse(scoped.json().text).owner, userIds.recipient);
    } finally {
      paused.release.resolve();
      await Promise.allSettled([paused.settled, approval, admitted]);
      await db.query("DROP TRIGGER agent_test_wait_for_first_pairing ON core.agent_user_grants; DROP FUNCTION core.agent_test_wait_for_first_pairing()");
    }
  });

  it("rechecks expiry after waiting for the grant lock", async () => {
    const expiry = new Date(now.getTime() + 1_000);
    const member = await enroll("expiryOwner", expiry.toISOString());
    const paused = holdDatabaseLock(tx => tx.query("SELECT id FROM core.agent_user_grants WHERE id=$1 FOR UPDATE", [member.recipientGrantId]));
    let admitted: ReturnType<typeof read> | undefined;
    try {
      await Promise.race([paused.entered.promise, paused.settled]);
      const readsBefore = resourceReads;
      admitted = read(member.token, "recipient");
      await waitForLock("%FROM core.agent_user_grants%FOR SHARE%");
      now = expiry;
      paused.release.resolve();
      const rejected = await admitted;
      assert.equal(rejected.statusCode, 403, rejected.body);
      assert.equal(rejected.json().error.code, "forbidden");
      assert.equal(resourceReads, readsBefore);
      const owner = await read(member.token, "expiryOwner");
      assert.equal(owner.statusCode, 200, owner.body);
      assert.equal(JSON.parse(owner.json().text).owner, userIds.expiryOwner);
    } finally {
      paused.release.resolve();
      await Promise.allSettled([paused.settled, admitted]);
    }
  });
});
