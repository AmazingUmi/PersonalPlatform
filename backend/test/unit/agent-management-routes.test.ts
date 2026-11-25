import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import Fastify, { type FastifyRequest } from "fastify";
import { AppError, sendError } from "../../src/core/api/errors.js";
import { registerAgentManagement } from "../../src/core/agent/management-routes.js";

const base = "/api/core/agents";
const agentId = "fe061349-a797-43db-9ccc-641fac7729f4";
const grantId = "927aff23-8d5c-468d-a299-80cd2eb55057";
const secretToken = "fixture-secret-bearer";
const secretCode = "fixture-secret-pair-code";
const at = "2026-11-25T08:00:00.000Z";
const fixtureAgent = {
  id: agentId, name: "Pepper", description: "", status: "active" as const, tokenPrefix: "fixture",
  requiresExplicitActor: true, createdAt: at, updatedAt: at, lastUsedAt: null,
};
const fixtureGrant = {
  id: grantId, agentId, agentName: "Pepper", ownerName: "Owner",
  status: "active" as const, agentStatus: "active" as const, expiresAt: null, scopes: ["read" as const], allowedApps: ["tasks"],
  grantedAt: at, updatedAt: at, revokedAt: null,
};

type Manager = NonNullable<Parameters<typeof registerAgentManagement>[1]>;
function build(t: TestContext, overrides: Partial<Manager> = {}) {
  const output: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output.push(String(chunk));
      done();
    },
  });
  const app = Fastify({ logger: { stream }, trustProxy: false });
  const calls: string[] = [];
  const remember = (action: string, request: FastifyRequest) => {
    calls.push(action + ":" + request.user!.id);
  };
  const manager: Manager = {
    async list(request) { remember("list", request); return { owned: [fixtureAgent], grants: [fixtureGrant] }; },
    async create(request) { remember("create", request); return { agent: fixtureAgent, grant: fixtureGrant, token: secretToken }; },
    async rotateToken(request) { remember("rotate", request); return { agent: fixtureAgent, token: secretToken }; },
    async revokeAgent(request) { remember("revoke-agent", request); },
    async createPairing(request) { remember("pair-code", request); return { code: secretCode, expiresAt: at }; },
    async previewPairing(request) {
      remember("preview", request);
      return { agentId, agentName: fixtureAgent.name, ownerName: "Owner", scopes: ["read"], allowedApps: ["tasks"], expiresAt: at };
    },
    async approvePairing(request) { remember("approve", request); return { grant: fixtureGrant }; },
    async narrowGrant(request) { remember("narrow", request); return { grant: fixtureGrant }; },
    async revokeGrant(request) { remember("revoke-grant", request); },
    async audit(request) { remember("audit", request); return { items: [], nextCursor: null }; },
    ...overrides,
  };
  registerAgentManagement(app, manager, async (request, reply) => {
    const user = request.headers.cookie?.match(/^pp_session=([a-z0-9_-]+)$/i)?.[1];
    if (!user) {
      sendError(reply, 401, "unauthorized", "authentication required", request.id);
      return;
    }
    request.user = { id: user, username: user, displayName: null, role: "user" };
  });
  t.after(() => app.close());
  return { app, calls, output };
}

const cookie = { cookie: "pp_session=ada" };
const permissions = { scopes: ["read"], allowedApps: ["tasks"] };

test("management stays Cookie-only and returns only the configured one-time values with no-store", async t => {
  const { app, calls } = build(t);
  const bearer = await app.inject({ method: "POST", url: base, headers: { authorization: "Bearer " + secretToken },
    payload: { name: "Pepper", ...permissions } });
  assert.equal(bearer.statusCode, 401);
  assert.equal(bearer.headers["cache-control"], "private, no-store");
  assert.deepEqual(calls, []);

  const targets = [
    { action: "list", method: "GET", url: base, status: 200 },
    { action: "create", method: "POST", url: base, payload: { name: "Pepper", ...permissions }, status: 201, secret: ["token", secretToken] },
    { action: "rotate", method: "POST", url: base + "/" + agentId + "/rotate-token", status: 200, secret: ["token", secretToken] },
    { action: "pair-code", method: "POST", url: base + "/" + agentId + "/pairing-codes", payload: permissions, status: 201, secret: ["code", secretCode] },
    { action: "preview", method: "POST", url: base + "/pairings/preview", payload: { code: secretCode }, status: 200 },
    { action: "approve", method: "POST", url: base + "/pairings/approve", payload: { code: secretCode, ...permissions }, status: 200 },
    { action: "narrow", method: "PATCH", url: base + "/grants/" + grantId, payload: { scopes: ["read"] }, status: 200 },
    { action: "revoke-grant", method: "DELETE", url: base + "/grants/" + grantId, status: 204 },
    { action: "audit", method: "GET", url: base + "/audit?limit=1", status: 200 },
    { action: "revoke-agent", method: "DELETE", url: base + "/" + agentId, status: 204 },
  ] as const;

  for (const target of targets) {
    const response = await app.inject({
      method: target.method, url: target.url, headers: cookie, payload: "payload" in target ? target.payload : undefined,
    });
    assert.equal(response.statusCode, target.status, response.body);
    assert.equal(response.headers["cache-control"], "private, no-store");
    if ("secret" in target) assert.equal(response.json()[target.secret[0]], target.secret[1]);
    else assert.doesNotMatch(response.body, /fixture-secret/);
  }
  assert.deepEqual(calls, targets.map(target => target.action + ":ada"));
});

test("pairing preview and approval are bounded by account and network separately from per-owner code issuance", async t => {
  const { app, calls } = build(t);
  const preview = (user: string, remoteAddress: string, spoofed: string) => app.inject({
    method: "POST", url: base + "/pairings/preview", remoteAddress,
    headers: { cookie: "pp_session=" + user, "X-Forwarded-For": spoofed },
    payload: { code: secretCode },
  });
  for (let i = 0; i < 20; i++) assert.equal((await preview("ada", "10.0.0." + (i + 1), "192.0.2.1")).statusCode, 200);
  assert.equal((await preview("ada", "10.0.0.100", "192.0.2.1")).statusCode, 429);
  for (let i = 0; i < 60; i++) assert.equal((await preview("fresh-" + i, "10.1.0.1", "192.0.2." + (i + 1))).statusCode, 200);
  const limited = await preview("fresh-other", "10.1.0.1", "192.0.2.140");
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "agent_rate_limited");
  assert.ok(Number(limited.headers["retry-after"]) > 0);

  for (let i = 0; i < 20; i++) assert.equal((await app.inject({
    method: "POST", url: base + "/pairings/approve", headers: cookie, payload: { code: secretCode, ...permissions },
  })).statusCode, 200);
  const deniedApproval = await app.inject({
    method: "POST", url: base + "/pairings/approve", headers: cookie, payload: { code: secretCode, ...permissions },
  });
  assert.equal(deniedApproval.statusCode, 429);
  assert.equal(calls.filter(call => call === "approve:ada").length, 20);

  for (let i = 0; i < 11; i++) {
    const response = await app.inject({
      method: "POST", url: base + "/" + agentId + "/pairing-codes", remoteAddress: "10.2.0." + (i + 1),
      headers: cookie, payload: permissions,
    });
    assert.equal(response.statusCode, i === 10 ? 429 : 201);
  }
  assert.equal(calls.filter(call => call === "pair-code:ada").length, 10);
});

test("management errors omit schema input, credential data and raw datastore errors", async t => {
  const { app, output } = build(t, {
    async previewPairing(_request, code) {
      if (code === secretCode) throw new Error("database failure contains " + secretCode);
      throw new AppError(409, "pairing_unavailable", code, { leaked: code });
    },
  });
  const invalid = await app.inject({ method: "POST", url: base + "/pairings/preview", headers: cookie, payload: { code: [secretCode, secretCode] } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "validation_error");
  const unavailable = await app.inject({ method: "POST", url: base + "/pairings/preview", headers: cookie, payload: { code: "sensitive-domain-reason" } });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.json().error.code, "pairing_unavailable");
  const internal = await app.inject({ method: "POST", url: base + "/pairings/preview", headers: cookie, payload: { code: secretCode } });
  assert.equal(internal.statusCode, 500);
  assert.equal(internal.json().error.code, "internal_error");
  assert.doesNotMatch([invalid.body, unavailable.body, internal.body, ...output].join(" "), /fixture-secret|sensitive-domain-reason|database failure contains/);
});
