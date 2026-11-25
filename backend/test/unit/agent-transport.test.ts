import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import { AppError } from "../../src/core/api/errors.js";
import { registerAgentIngress, type AgentIngressGateway, type AgentIngressOptions } from "../../src/core/agent/transport.js";
import type { AgentManifest } from "../../src/core/agent/types.js";

const token = Buffer.alloc(32, 34).toString("base64url");
const auth = { authorization: "Bearer " + token };
const mcp = {
  ...auth,
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2025-11-25",
  "x-pp-acting-user": "paired_user",
};
const credential = { agentId: "agent-fixture", tokenHash: "hash-fixture" };
const manifest: AgentManifest = {
  agent: { id: credential.agentId, name: "Fixture" },
  actingUser: { id: "owner-fixture", username: "paired_user" },
  apps: [],
  scopes: ["read"],
  tools: [{ name: "platform_status", description: "Read status", inputSchema: { type: "object" } }],
  resources: [{ name: "Overview", uri: "pp://platform/overview", mimeType: "application/json" }],
};

function fixture(t: TestContext, changes: Partial<AgentIngressGateway> = {}, options: Partial<AgentIngressOptions> = {}, trustProxy = false) {
  const app = Fastify({ trustProxy });
  const gateway: AgentIngressGateway = {
    async authenticate(input) {
      if (input !== token) throw new AppError(401, "unauthorized", "Invalid token.");
      return credential;
    },
    async manifest() { return manifest; },
    async invoke(_credential, actor, _name, args, admit) {
      admit?.();
      return { ok: true, data: { actor, args } };
    },
    async resource(_credential, _actor, uri) { return { uri, mimeType: "text/plain", text: "Fixture resource" }; },
    ...changes,
  };
  registerAgentIngress(app, gateway, { enabled: true, allowedOrigins: ["https://trusted.example"], ...options });
  t.after(() => app.close());
  return app;
}

const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, params });

test("MCP negotiates only the fixed version and acknowledges initialized notifications", async (t) => {
  const app = fixture(t);
  const { "mcp-protocol-version": _, ...initial } = mcp;
  const initialize = await app.inject({
    method: "POST", url: "/api/agent/mcp", headers: initial,
    payload: rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "Fixture", version: "1" }, capabilities: {} }),
  });
  assert.equal(initialize.statusCode, 200);
  assert.equal(initialize.headers["mcp-session-id"], undefined);
  assert.equal(initialize.headers["cache-control"], "private, no-store");
  assert.deepEqual(initialize.json().result.capabilities, { tools: {}, resources: {} });
  assert.equal(initialize.json().result.protocolVersion, "2025-11-25");

  const initialized = await app.inject({
    method: "POST", url: "/api/agent/mcp", headers: mcp,
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.equal(initialized.statusCode, 202);
  assert.equal(initialized.body, "");

  for (const headers of [initial, { ...mcp, "mcp-protocol-version": "2025-06-18" }]) {
    const wrong = await app.inject({ method: "POST", url: "/api/agent/mcp", headers, payload: rpc("tools/list") });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error.data.code, "unsupported_protocol_version");
  }
  const ping = await app.inject({ method: "POST", url: "/api/agent/mcp", headers: mcp, payload: rpc("ping") });
  assert.equal(ping.statusCode, 200);
  assert.deepEqual(ping.json().result, {});
});

test("MCP checks Origin, method, accepted representations and single-message framing", async (t) => {
  const app = fixture(t);
  for (const method of ["GET", "DELETE", "POST", "OPTIONS"] as const) {
    const denied = await app.inject({ method, url: "/api/agent/mcp", headers: { origin: "https://untrusted.example" } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.data.code, "invalid_origin");
  }
  for (const method of ["GET", "DELETE"] as const) {
    const rejected = await app.inject({ method, url: "/api/agent/mcp", headers: { ...auth, origin: "https://trusted.example" } });
    assert.equal(rejected.statusCode, 405);
    assert.equal(rejected.headers.allow, "POST");
  }
  const onlyJson = await app.inject({
    method: "POST", url: "/api/agent/mcp", headers: { ...mcp, accept: "application/json, text/event-stream;q=0" },
    payload: rpc("tools/list"),
  });
  assert.equal(onlyJson.statusCode, 406);
  const batch = await app.inject({ method: "POST", url: "/api/agent/mcp", headers: mcp, payload: [rpc("ping")] });
  assert.equal(batch.statusCode, 400);
  assert.equal(batch.json().error.code, -32600);
});

test("REST and MCP read the same scoped catalog and resources", async (t) => {
  const calls: Array<string | undefined> = [];
  const app = fixture(t, {
    async manifest(_credential, actor) { calls.push(actor); return manifest; },
    async resource(_credential, actor, uri) { calls.push(actor); return { uri, mimeType: "text/plain", text: "Fixture resource" }; },
  });
  const manifestResponse = await app.inject({
    url: "/api/agent/v1/manifest?actingUser=paired_user", headers: auth,
  });
  assert.deepEqual(manifestResponse.json(), manifest);
  const discovered = await app.inject({ method: "POST", url: "/api/agent/mcp", headers: mcp, payload: rpc("tools/list") });
  assert.deepEqual(discovered.json().result.tools, manifest.tools);
  const listed = await app.inject({ method: "POST", url: "/api/agent/mcp", headers: mcp, payload: rpc("resources/list") });
  assert.deepEqual(listed.json().result.resources, manifest.resources);
  const read = await app.inject({
    method: "POST", url: "/api/agent/mcp", headers: mcp,
    payload: rpc("resources/read", { uri: "pp://platform/overview" }),
  });
  const resource = await app.inject({
    url: "/api/agent/v1/resources?uri=pp%3A%2F%2Fplatform%2Foverview&actingUser=paired_user", headers: auth,
  });
  assert.deepEqual(resource.json(), read.json().result.contents[0]);
  assert.equal(resource.headers["cache-control"], "private, no-store");
  assert.deepEqual(calls, Array.from({ length: 5 }, () => "paired_user"));
});

test("JSON and MCP keep credential lookup and discovery datastore failures retryable", async (t) => {
  const abort = () => { throw Object.assign(new Error("private fixture diagnostic"), { code: "40P01" }); };
  const discovery = fixture(t, { manifest: abort });
  const authentication = fixture(t, { authenticate: abort });
  for (const app of [discovery, authentication]) {
    const json = await app.inject({ method: "GET", url: "/api/agent/v1/manifest", headers: auth });
    const discovered = await app.inject({ method: "POST", url: "/api/agent/mcp", headers: mcp, payload: rpc("tools/list") });
    assert.equal(json.statusCode, 503, json.body);
    assert.equal(discovered.statusCode, 503, discovered.body);
    assert.equal(json.json().error.code, "agent_datastore_busy");
    assert.equal(discovered.json().error.data.code, "agent_datastore_busy");
    assert.doesNotMatch(json.body + discovered.body, /private fixture diagnostic/);
  }
});

test("REST removes its acting-user control field and rejects competing or repeated selectors", async (t) => {
  const app = fixture(t);
  const destination = "/api/agent/v1/tools/platform_status";
  const response = await app.inject({
    method: "POST", url: destination, headers: auth,
    payload: { _actingUser: "paired_user", projection: { _actingUser: "ordinary tool data" } },
  });
  assert.deepEqual(response.json(), { ok: true, data: { actor: "paired_user", args: { projection: { _actingUser: "ordinary tool data" } } } });
  const duplicateBody = await app.inject({
    method: "POST", url: destination, headers: { ...auth, "content-type": "application/json" },
    payload: '{"_actingUser":"paired_user","\\u005factingUser":"other_user"}',
  });
  assert.equal(duplicateBody.statusCode, 400);
  assert.equal(duplicateBody.json().error.code, "invalid_acting_user");
  const both = await app.inject({
    method: "POST", url: destination, headers: { ...auth, "x-pp-acting-user": "other_user" },
    payload: { _actingUser: "paired_user" },
  });
  assert.equal(both.statusCode, 400);
  const multipleQueries = await app.inject({
    url: "/api/agent/v1/manifest?actingUser=paired_user&actingUser=other_user", headers: auth,
  });
  assert.equal(multipleQueries.statusCode, 400);
  const repeatedHeaders = await app.inject({
    url: "/api/agent/v1/manifest",
    headers: { ...auth, "x-pp-acting-user": ["paired_user", "other_user"] },
  });
  assert.equal(repeatedHeaders.statusCode, 400);
  const nonJson = await app.inject({
    method: "POST", url: destination, headers: { ...auth, "content-type": "text/plain" }, payload: "{}",
  });
  assert.equal(nonJson.statusCode, 415);
});

test("MCP retains HTTP authorization failures and streams admitted tool errors as results", async (t) => {
  const app = fixture(t, {
    async invoke(_credential, actor, _name, _args, admit) {
      if (!actor) throw new AppError(400, "acting_user_required", "Select an acting user.", { usernames: ["paired_user"] });
      admit?.();
      return { ok: false, status: 409, error: { code: "conflict", message: "Version changed.", details: { baseHash: "current" } } };
    },
  });
  const args = rpc("tools/call", { name: "platform_status" });
  const { "x-pp-acting-user": _, ...actorless } = mcp;
  const denied = await app.inject({ method: "POST", url: "/api/agent/mcp", headers: actorless, payload: args });
  assert.equal(denied.statusCode, 400);
  assert.equal(denied.json().error.data.code, "acting_user_required");
  const invalid = await app.inject({ method: "POST", url: "/api/agent/mcp", headers: mcp, payload: rpc("tools/call", { arguments: [] }) });
  assert.match(invalid.headers["content-type"] ?? "", /^application\/json/);
  const streamed = await app.inject({ method: "POST", url: "/api/agent/mcp", headers: mcp, payload: args });
  assert.equal(streamed.statusCode, 200);
  assert.match(streamed.headers["content-type"] ?? "", /^text\/event-stream/);
  assert.equal(streamed.headers["cache-control"], "private, no-store");
  const result = JSON.parse(streamed.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.details.baseHash, "current");
  const json = await app.inject({
    method: "POST", url: "/api/agent/v1/tools/platform_status", headers: mcp, payload: {},
  });
  assert.equal(json.statusCode, 409);
  assert.deepEqual(json.json(), result.structuredContent);
});

test("MCP rejects unsupported task augmentation before invoking a tool", async (t) => {
  let invocations = 0;
  const app = fixture(t, {
    async invoke(_credential, _actor, _name, _args, admit) {
      invocations++;
      admit?.();
      return { ok: true, data: {} };
    },
  });
  const id = "unsupported-task";
  const response = await app.inject({
    method: "POST", url: "/api/agent/mcp", headers: mcp,
    payload: { ...rpc("tools/call", { name: "fixture_create", arguments: {}, task: { ttl: 60_000 } }), id },
  });
  assert.equal(invocations, 0);
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers["content-type"] ?? "", /^application\/json/);
  const body = response.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, id);
  assert.match(body.error.message, /does not support task creation/);
  assert.equal(body.result, undefined);
});

test("disabled Agent ingress bypasses authentication and valid origin policy", async (t) => {
  let attempts = 0;
  const app = fixture(t, {
    async authenticate() { attempts++; return credential; },
  }, { enabled: false });
  const response = await app.inject({ url: "/api/agent/mcp", headers: { ...auth, origin: "https://untrusted.example" } });
  assert.equal(response.statusCode, 404);
  assert.equal(attempts, 0);
});

test("ingress limits count the trusted client IP before and after authentication", async (t) => {
  let now = new Date(0);
  let attempts = 0;
  const app = fixture(t, {
    async authenticate() { attempts++; return credential; },
  }, { now: () => now });
  const url = "/api/agent/v1/manifest";
  for (let index = 0; index < 180; index++) {
    const response = await app.inject({ url, headers: { ...auth, "x-forwarded-for": "192.0.2." + (index + 1) } });
    assert.equal(response.statusCode, index < 120 ? 200 : 429);
  }
  const rejected = await app.inject({ url, headers: auth });
  assert.equal(rejected.statusCode, 429);
  assert.equal(attempts, 180);
  assert.equal(rejected.headers["retry-after"], "60");
  now = new Date(60_000);
  assert.equal((await app.inject({ url, headers: auth })).statusCode, 200);

  const trusted = fixture(t, {}, {}, true);
  for (let index = 1; index <= 121; index++) {
    const response = await trusted.inject({ url, headers: { ...auth, "x-forwarded-for": "192.0.2." + index } });
    assert.equal(response.statusCode, 200);
  }
});
